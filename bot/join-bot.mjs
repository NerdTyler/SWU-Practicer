// Practice opponent bot — JOIN mode (Stage 7). One seat of a game, played
// by the bot, in a lobby the HUMAN created in the Karabast client.
//
//   node join-bot.mjs --lobby <lobbyId> --deck-id <library id>
//                     [--deck <deck.json>] [--name "Practice Bot"]
//                     [--wait-seconds 1800] [--linger-seconds 90]
//
// Flow: join the existing lobby as player 2 (POST /api/join-lobby) ->
// connect the socket -> set the bot's deck (POST /api/lobby/:id/change-deck,
// the call the client itself uses) -> ready up -> the HOST starts the game
// from their own lobby screen -> play the seat with the Stage 2 heuristics
// (the Seat class from bot.mjs — unchanged) -> leave after the game when
// the host leaves, or after a short linger.
//
// This is deliberately the smallest possible lifecycle: no record book, no
// summaries, no Bo3, no rematch offers, no starting games. The Stage 6
// opponent.mjs (which CREATES its own lobby for the retired practice page)
// is untouched; this file is spawned per lobby by bot-host.mjs.
import { readFileSync } from 'node:fs';
import { Seat, post, flushCapture } from './bot.mjs';
import { getDeck, deckName, validateDeck } from '../decks/library.mjs';

const argv = process.argv.slice(2);
const flagVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };

const lobbyId = flagVal('--lobby');
const deckId = flagVal('--deck-id');
const deckFile = flagVal('--deck');
const botName = flagVal('--name') ?? 'Practice Bot';
const waitSeconds = parseInt(flagVal('--wait-seconds') ?? '1800', 10);
const lingerSeconds = parseInt(flagVal('--linger-seconds') ?? '90', 10);

if (!lobbyId) { console.error('join-bot: --lobby <lobbyId> is required'); process.exit(1); }

let deck = null;
let deckLabel = null;
if (deckId) {
    deck = getDeck(deckId);
    deckLabel = `${deckId} (${deckName(deckId)})`;
    if (!deck) { console.error(`join-bot: no such deck id: ${deckId}`); process.exit(1); }
} else if (deckFile) {
    deck = JSON.parse(readFileSync(deckFile, 'utf8'));
    deckLabel = deckFile;
} else {
    console.error('join-bot: give --deck-id <library id> or --deck <file>');
    process.exit(1);
}
const v = validateDeck(deck);
if (!v.ok) { console.error(`join-bot: deck fails validation: ${v.errors.join('; ')}`); process.exit(1); }

const startedAt = Date.now();
let phase = 'waiting'; // waiting | playing | gameover
let gameEndAt = null;
let humanGoneSince = null;
let lastLobbyAt = 0;
let latestLobby = null;
let deckSet = false;
let deckSetting = false;
let lastDeckAttempt = 0;
let lastReadyAttempt = 0;
let exited = false;

function exitBot(code, why) {
    if (exited) return;
    exited = true;
    console.log(`join-bot: exiting (${why})`);
    try { flushCapture(); } catch { /* best effort */ }
    process.exit(code);
}
process.on('SIGTERM', () => exitBot(0, 'SIGTERM'));
process.on('SIGINT', () => exitBot(0, 'SIGINT'));

const seat = new Seat(botName, deck);
seat.stayAliveOnGameEnd = true;

seat.onGameStart = () => {
    phase = 'playing';
    humanGoneSince = null;
    console.log('join-bot: game started.');
};
seat.onGameEnd = (info) => {
    phase = 'gameover';
    gameEndAt = Date.now();
    console.log(`join-bot: game over — winners: ${JSON.stringify(info.winners ?? [])}`);
};

function myLobbyUser() {
    return (latestLobby?.users ?? []).find((u) => u.id === seat.user.id) ?? null;
}
function humanLobbyUser() {
    return (latestLobby?.users ?? []).find((u) => u.id !== seat.user.id) ?? null;
}

// Set the bot's deck via the same lobby change-deck API the web client
// uses. Only works once the socket has connected and the server sees us
// in the lobby (Stage 2 lesson), so it is retried from the lobbystate
// handler until it succeeds.
async function applyDeck() {
    if (deckSet || deckSetting) return;
    if (Date.now() - lastDeckAttempt < 3000) return;
    lastDeckAttempt = Date.now();
    deckSetting = true;
    try {
        const res = await post(`/api/lobby/${lobbyId}/change-deck`, { user: seat.user, deck });
        if (res.status === 200) {
            deckSet = true;
            console.log(`join-bot: deck set (${deckLabel}).`);
        } else {
            console.log(`join-bot: change-deck not accepted yet (${res.status}): ${JSON.stringify(res.json).slice(0, 160)} — will retry`);
        }
    } catch (e) {
        console.log('join-bot: change-deck errored — will retry', e);
    } finally {
        deckSetting = false;
    }
}

// ---------------------------------------------------------------- join flow
const join = await post('/api/join-lobby', { lobbyId, user: seat.user });
if (join.status !== 200) {
    console.error(`join-bot: join-lobby failed (${join.status}): ${JSON.stringify(join.json).slice(0, 200)}`);
    process.exit(5);
}
console.log(`join-bot: joined lobby ${lobbyId} with deck ${deckLabel}; waiting for the host to start.`);
seat.connect(lobbyId);

seat.socket.on('lobbystate', (ls) => {
    latestLobby = ls;
    lastLobbyAt = Date.now();
    const me = myLobbyUser();
    if (!me) return;
    if (!deckSet) { applyDeck(); return; }
    // Ready up once the deck is in; re-assert if the flag drops while no
    // game is running. The HOST starts the game — never start it here.
    if (me.ready === false && !ls.gameOngoing && phase !== 'playing'
        && Date.now() - lastReadyAttempt > 3000) {
        lastReadyAttempt = Date.now();
        seat.socket.emit('lobby', 'setReadyStatus', true);
    }
    const human = humanLobbyUser();
    // A host who closed their tab stays listed as 'disconnected' for the
    // reconnect grace — outside of a running game that counts as gone.
    const humanHere = !!human && (!human.state || human.state === 'connected');
    if (!humanHere && phase !== 'playing') {
        humanGoneSince = humanGoneSince ?? Date.now();
    } else if (humanHere) {
        humanGoneSince = null;
    }
});

// ---------------------------------------------------------------- poll loop
const poll = setInterval(() => {
    const elapsed = Date.now() - startedAt;

    if (phase === 'waiting') {
        if (humanGoneSince && Date.now() - humanGoneSince > 20000) {
            exitBot(0, 'host left before starting the game');
        }
        // Lobbystate is event-driven: a quiet lobby (host still deciding)
        // sends nothing for minutes at a time, so only treat a very long
        // silence as "lobby went away".
        if (lastLobbyAt && Date.now() - lastLobbyAt > 600000) {
            exitBot(0, 'lobby went away before the game started');
        }
        if (elapsed > waitSeconds * 1000) {
            exitBot(4, `host never started the game within ${waitSeconds}s`);
        }
    } else if (phase === 'playing') {
        const other = humanLobbyUser();
        const humanDropped = !!other && !!other.state && other.state !== 'connected';
        const idleMs = Date.now() - seat.lastStateAt;
        // Generous threshold: a human reading cards is quiet for a while;
        // only minutes of total silence mean something actually broke.
        if (idleMs > 300000 && !humanDropped) {
            exitBot(2, `stall: no gamestate for ${Math.round(idleMs / 1000)}s`);
        }
        if (elapsed > (waitSeconds + 1800) * 1000) {
            exitBot(3, 'time cap reached during game');
        }
    } else if (phase === 'gameover') {
        if (humanGoneSince && Date.now() - humanGoneSince > 6000) {
            exitBot(0, 'host left after the game — done');
        }
        if (Date.now() - gameEndAt > lingerSeconds * 1000) {
            exitBot(0, 'post-game linger cap reached');
        }
    }
}, 2000);
poll.unref();
