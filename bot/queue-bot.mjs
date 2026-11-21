// Practice opponent bot — QUEUE mode (Stage 7.1). One seat of a game,
// reached through Karabast's matchmaking queue (the client's Quick Game).
//
//   node queue-bot.mjs --user-id <uuid> --deck-id <library id>
//                      --format eternal --card-pool current
//                      --games-to-win bestOfOne --preference noPreference
//                      [--deck <deck.json>] [--name "Practice Bot"]
//                      [--wait-seconds 1200] [--linger-seconds 120]
//
// Flow — the exact sequence the web client performs (QuickGameForm.tsx ->
// Game.context.tsx createNewSocket):
//   POST /api/enter-queue {user, deck, format, cardPool, gamesToWinMode,
//   matchmakingCompetitivenessPreference} -> connect the socket with NO
//   lobby (GameServer routes a lobby-less socket to the caller's queue
//   entry) -> server matchmaking pairs us with the waiting human, creates
//   a "Quick Game" lobby with both decks already set from the queue
//   entries, attaches this socket to it, and auto-starts the game after
//   a ~6s countdown (Lobby.quickLobbyCountdownAsync — nobody readies or
//   presses start) -> play the seat with the Stage 2 heuristics (the
//   Seat class from bot.mjs) -> leave after the game.
//
// bot-host owns this process and can order a withdrawal over stdin:
//   "withdraw"  -> leave the queue the same way the client's Leave Queue
//                  button does (a 'manualDisconnect' socket emit, which
//                  the server answers by removing us from the queue at
//                  once). Only meaningful before a match forms; ignored
//                  once we are in a lobby or a game.
//
// Exit codes: 0 clean (game finished / withdrew / human gone),
//   2 in-game stall, 3 in-game time cap, 4 queue wait cap,
//   5 socket connect failed, 6 enter-queue rejected (bot-host may
//   retry with a different deck).
import { readFileSync } from 'node:fs';
import { Seat, post, flushCapture } from './bot.mjs';
import { getDeck, deckName, validateDeck } from '../decks/library.mjs';

const argv = process.argv.slice(2);
const flagVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };

const userId = flagVal('--user-id');
const deckId = flagVal('--deck-id');
const deckFile = flagVal('--deck');
const botName = flagVal('--name') ?? 'Practice Bot';
const format = flagVal('--format') ?? 'eternal';
const cardPool = flagVal('--card-pool') ?? 'current';
const gamesToWinMode = flagVal('--games-to-win') ?? 'bestOfOne';
const preference = flagVal('--preference') ?? 'noPreference';
const waitSeconds = parseInt(flagVal('--wait-seconds') ?? '1200', 10);
const lingerSeconds = parseInt(flagVal('--linger-seconds') ?? '120', 10);

if (!userId) { console.error('queue-bot: --user-id <uuid> is required (bot-host assigns it)'); process.exit(1); }

let deck = null;
let deckLabel = null;
if (deckId) {
    deck = getDeck(deckId);
    deckLabel = `${deckId} (${deckName(deckId)})`;
    if (!deck) { console.error(`queue-bot: no such deck id: ${deckId}`); process.exit(1); }
} else if (deckFile) {
    deck = JSON.parse(readFileSync(deckFile, 'utf8'));
    deckLabel = deckFile;
} else {
    console.error('queue-bot: give --deck-id <library id> or --deck <file>');
    process.exit(1);
}
const v = validateDeck(deck);
if (!v.ok) { console.error(`queue-bot: deck fails validation: ${v.errors.join('; ')}`); process.exit(1); }

const startedAt = Date.now();
let phase = 'entering'; // entering | queued | matched | playing | gameover
let matchedAt = 0;
let gameEndAt = 0;
let humanGoneSince = null;
let latestLobby = null;
let lastReadyAttempt = 0;
let withdrawPending = false;
let withdrawing = false;
let exited = false;

function exitBot(code, why) {
    if (exited) return;
    exited = true;
    console.log(`queue-bot: exiting ${code} (${why})`);
    try { flushCapture(); } catch { /* best effort */ }
    process.exit(code);
}
function exitDelayed(code, why, ms = 300) {
    if (exited) return;
    setTimeout(() => exitBot(code, why), ms);
}

// The client's Leave Queue, verbatim in effect: emit 'manualDisconnect'
// (GameServer.handleSocketConnectionAsync turns that into an immediate
// queue removal), then drop the socket.
function leaveQueueNow() {
    try { seat.socket?.emit('manualDisconnect'); } catch { /* no socket yet */ }
    setTimeout(() => { try { seat.socket?.disconnect(); } catch { /* already gone */ } }, 150);
}

function withdraw(why) {
    if (withdrawing || exited) return;
    if (phase !== 'entering' && phase !== 'queued') {
        console.log(`queue-bot: withdraw ignored — already ${phase} (${why})`);
        return;
    }
    withdrawing = true;
    console.log(`queue-bot: withdrawing from queue (${why})`);
    if (seat.socket?.connected) {
        leaveQueueNow();
        exitDelayed(0, `withdrew from queue (${why})`);
    } else {
        // Still POSTing / connecting: withdraw the moment the socket is
        // up (the queue entry only becomes real once we connect).
        withdrawPending = true;
    }
}

const seat = new Seat(botName, deck);
seat.user = { id: userId, username: botName };
seat.stayAliveOnGameEnd = true;

seat.onGameStart = () => {
    phase = 'playing';
    humanGoneSince = null;
    console.log('queue-bot: game started.');
};
seat.onGameEnd = (info) => {
    phase = 'gameover';
    gameEndAt = Date.now();
    console.log(`queue-bot: game over — winners: ${JSON.stringify(info.winners ?? [])}`);
};

function myLobbyUser() {
    return (latestLobby?.users ?? []).find((u) => u.id === seat.user.id) ?? null;
}
function humanLobbyUser() {
    return (latestLobby?.users ?? []).find((u) => u.id !== seat.user.id) ?? null;
}

// ------------------------------------------------------------ stdin orders
let stdinBuf = '';
process.stdin.on('data', (chunk) => {
    stdinBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdinBuf.indexOf('\n')) >= 0) {
        const line = stdinBuf.slice(0, idx).trim();
        stdinBuf = stdinBuf.slice(idx + 1);
        if (line === 'withdraw') withdraw('bot-host order');
    }
});
process.on('SIGTERM', () => {
    if (phase === 'entering' || phase === 'queued') { leaveQueueNow(); exitDelayed(0, 'SIGTERM', 200); }
    else exitBot(0, 'SIGTERM');
});
process.on('SIGINT', () => {
    if (phase === 'entering' || phase === 'queued') { leaveQueueNow(); exitDelayed(0, 'SIGINT', 200); }
    else exitBot(0, 'SIGINT');
});

// ---------------------------------------------------------------- queue in
const enter = await post('/api/enter-queue', {
    user: seat.user,
    deck,
    format,
    cardPool,
    gamesToWinMode,
    matchmakingCompetitivenessPreference: preference,
});
if (enter.status !== 200) {
    console.error(`queue-bot: enter-queue rejected (${enter.status}): ${JSON.stringify(enter.json).slice(0, 240)}`);
    process.exit(6);
}
console.log(`queue-bot: entered queue (${format} / ${cardPool} / ${gamesToWinMode}, preference ${preference}) with ${deckLabel}; connecting socket…`);
seat.connect(null);

seat.socket.on('connect', () => {
    if (withdrawPending && !withdrawing) {
        // Give the server a beat to register the queue entry, then leave.
        setTimeout(() => withdraw('bot-host order (pending)'), 800);
    }
});
seat.socket.on('connect_error', (e) => {
    exitBot(5, `socket connect failed: ${e?.message ?? e}`);
});
seat.socket.on('queueHeartbeat', () => {
    if (phase === 'entering') {
        phase = 'queued';
        console.log('queue-bot: in queue, waiting for a match.');
        if (withdrawPending && !withdrawing) withdraw('bot-host order (pending)');
    } else if (phase === 'matched' && Date.now() - matchedAt > 3000) {
        // Heartbeats only reach players sitting in the queue. If one
        // arrives after we were matched, the server auto-requeued us —
        // that happens when the opponent disconnects during the pre-game
        // countdown (Lobby.handleMatchmakingDisconnect). Nobody is
        // waiting for us anymore: leave instead of ambushing a later,
        // unrelated queue.
        console.log('queue-bot: server put us back in the queue (opponent left during countdown) — withdrawing');
        phase = 'queued';
        withdraw('auto-requeue backstop');
    }
});
seat.socket.on('lobbystate', (ls) => {
    latestLobby = ls;
    if (phase === 'entering' || phase === 'queued') {
        phase = 'matched';
        matchedAt = Date.now();
        console.log(`queue-bot: matched — lobby ${ls.id?.slice(0, 8)}…; game auto-starts after the countdown.`);
    }
    const me = myLobbyUser();
    if (!me) return;
    // Ready up whenever no game is running and our flag is down. The
    // countdown starts the first game on its own; between Bo3 games the
    // lobby waits for ready, so re-assert it there (same pattern as
    // join-bot, which the lobby flow proved safe).
    if (me.ready === false && !ls.gameOngoing && phase !== 'playing'
        && Date.now() - lastReadyAttempt > 3000) {
        lastReadyAttempt = Date.now();
        seat.socket.emit('lobby', 'setReadyStatus', true);
    }
    const human = humanLobbyUser();
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

    if (phase === 'entering' || phase === 'queued') {
        if (elapsed > waitSeconds * 1000) {
            leaveQueueNow();
            exitDelayed(4, `no match within ${waitSeconds}s — left the queue`, 200);
        }
    } else if (phase === 'matched') {
        if (humanGoneSince && Date.now() - humanGoneSince > 20000) {
            exitBot(0, 'human left before the game started');
        }
        if (Date.now() - matchedAt > 300000) {
            exitBot(0, 'matched but the game never started (5 min)');
        }
    } else if (phase === 'playing') {
        const other = humanLobbyUser();
        const humanDropped = !!other && !!other.state && other.state !== 'connected';
        const idleMs = Date.now() - seat.lastStateAt;
        // Same generous thresholds as join-bot: a human reading cards is
        // quiet for a while; only minutes of total silence mean breakage.
        if (idleMs > 300000 && !humanDropped) {
            exitBot(2, `stall: no gamestate for ${Math.round(idleMs / 1000)}s`);
        }
        if (elapsed > (waitSeconds + 1800) * 1000) {
            exitBot(3, 'time cap reached during game');
        }
    } else if (phase === 'gameover') {
        if (humanGoneSince && Date.now() - humanGoneSince > 6000) {
            exitBot(0, 'human left after the game — done');
        }
        // Best-of-1 is the queue's normal mode: the match is over, leave
        // promptly. In a Bo3 lobby the next game may still be coming —
        // wait for it (a fresh onGameStart flips us back to playing) up
        // to the linger cap.
        const doneAfterMs = gamesToWinMode === 'bestOfThree' ? lingerSeconds * 1000 : 8000;
        if (Date.now() - gameEndAt > doneAfterMs) {
            exitBot(0, gamesToWinMode === 'bestOfThree' ? 'post-game linger cap reached' : 'game over — done');
        }
    }
}, 2000);
poll.unref();
