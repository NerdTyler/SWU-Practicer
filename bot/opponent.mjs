// Practice opponent bot (Stage 4 + Stage 6) — ONE seat of a game, played by
// the bot, so a human can take the other seat in the web client.
//
//   node opponent.mjs --deck-id community:0 [--name "Practice Bot"]
//                     [--state-file <path>] [--wait-seconds 900]
//                     [--client-url http://localhost:3000]
//                     [--mode bo1|bo3] [--records-file <path>]
//                     [--summaries-dir <path>] [--no-rematch]
//                     [--human-deck-id <library id>] [--human-deck <file>]
//   node opponent.mjs --deck <deck.json> [...]
//
// Flow: create a private lobby with the chosen deck -> write the join URL
// to the state file -> ready up -> wait for the human to join in the client
// (http://localhost:3000/lobby?lobbyId=<id>) -> start the game -> play the
// bot seat with the Stage 2 heuristics (the Seat class from bot.mjs).
//
// With --human-deck-id/--human-deck (the single-page flow), the human never
// touches the client lobby: as soon as their browser joins the lobby, the
// bot sets their deck via POST /api/lobby/:id/change-deck (the same call
// the Stage 4 harness proved) and starts the game itself — the server's
// startGameAsync gates on deck size only, not on ready flags, so no
// deck-picking and no ready click are needed. Without a human deck, the
// classic flow applies: the human picks a deck and readies in the client,
// and the bot starts when both are ready.
//
// Stage 6 lifecycle: the bot STAYS in the lobby after a game ends. It writes
// the play-by-play summary (from the engine's own message log) and the
// result into the local record book, offers a rematch (Bo1) which the human
// accepts with one click in the client, and in Bo3 mode confirms proceeding
// to the next game (the human sideboards / confirms in the client lobby)
// and tracks the series score. It exits when the human leaves the lobby
// after the set/game is over, on a stall, or on the time cap.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Seat, post, flushCapture } from './bot.mjs';
import { getDeck, deckName, validateDeck } from '../decks/library.mjs';
import { buildSummary, buildSeriesSummary } from './gamelog.mjs';
import { appendRecord, DEFAULT_RECORDS_FILE } from '../records.mjs';

const argv = process.argv.slice(2);
const flagVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const hasFlag = (flag) => argv.includes(flag);

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const deckId = flagVal('--deck-id');
const deckFile = flagVal('--deck');
const botName = flagVal('--name') ?? 'Practice Bot';
const stateFile = flagVal('--state-file');
const waitSeconds = parseInt(flagVal('--wait-seconds') ?? '900', 10);
const clientUrl = (flagVal('--client-url') ?? 'http://localhost:3000').replace(/\/$/, '');
const mode = (flagVal('--mode') ?? 'bo1').toLowerCase();
const recordsFile = flagVal('--records-file') ?? DEFAULT_RECORDS_FILE;
const summariesDir = flagVal('--summaries-dir') ?? path.join(APP_DIR, '..', 'summaries');
const offerRematch = !hasFlag('--no-rematch');
if (mode !== 'bo1' && mode !== 'bo3') { console.error(`opponent: unknown --mode ${mode}`); process.exit(1); }

// The human's pre-chosen deck (single-page flow). Resolved from the library
// exactly like the bot's own deck.
const humanDeckId = flagVal('--human-deck-id');
const humanDeckFile = flagVal('--human-deck');
let humanDeck = null;
let humanDeckLabel = null;
if (humanDeckId) {
    humanDeck = getDeck(humanDeckId);
    humanDeckLabel = deckName(humanDeckId);
    if (!humanDeck) { console.error(`opponent: no such human deck id: ${humanDeckId}`); process.exit(1); }
} else if (humanDeckFile) {
    humanDeck = JSON.parse(readFileSync(humanDeckFile, 'utf8'));
    humanDeckLabel = humanDeckFile;
}
if (humanDeck) {
    const v = validateDeck(humanDeck);
    if (!v.ok) { console.error(`opponent: human deck fails validation: ${v.errors.join('; ')}`); process.exit(1); }
}

let deck = null;
let deckLabel = null;
if (deckId) {
    deck = getDeck(deckId);
    deckLabel = deckName(deckId);
    if (!deck) { console.error(`opponent: no such deck id: ${deckId}`); process.exit(1); }
} else if (deckFile) {
    deck = JSON.parse(readFileSync(deckFile, 'utf8'));
    deckLabel = deckFile;
} else {
    console.error('opponent: give --deck-id <library id> or --deck <file>');
    process.exit(1);
}

mkdirSync(summariesDir, { recursive: true });

// ---------------------------------------------------------------- state file
const state = {
    status: 'starting',
    phase: 'waiting',
    mode,
    pid: process.pid,
    lobbyId: null,
    joinUrl: null,
    botDeck: deckLabel,
    botName,
    gameNumber: 0,
    series: null, // { bot, human } wins in the current Bo3 set
    yourDeck: humanDeckLabel,
    humanDeckSet: false,
    lastWinner: null,
    waitingOn: null,
    gameStartedAt: null,
    lastActionAt: null,
    summaryFile: null,
    updatedAt: Date.now(),
};
function writeState(patch = {}) {
    Object.assign(state, patch, { updatedAt: Date.now() });
    if (!stateFile) return;
    try { writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n'); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- game data
const seat = new Seat(botName, deck);
seat.stayAliveOnGameEnd = true;
const startedAt = Date.now();
let lobbyId = null;
let latestLobby = null;
let phase = 'waiting'; // waiting | playing | betweengames | gameover
let gameNumber = 0;
let gameStartedAt = null;
let humanUserId = null;
let humanUsername = null;
let humanLabel = null; // "Leader / Base" once seen in a gamestate
let botLabel = null;
let seriesGames = []; // [{ gameNumber, winnerSide, winnerName, summaryText, summaryFile }]
let lastGameEndAt = null;
let rematchOfferedFor = null; // gameId the bot already offered a rematch for
let handledRematchRequest = null; // signature of the request already confirmed
let proceededForGame = null; // gameNumber the bot already confirmed proceeding for
let humanGoneSince = null;
let lastStartAttempt = 0;
let lastProceedAttempt = 0;
let humanDeckApplied = false;
let humanDeckApplying = false;

// Single-page flow: set the human's deck for them, via the same change-deck
// API the web client uses (the user is identified by the lobby membership
// the server recorded when their browser connected).
async function applyHumanDeck() {
    if (!humanDeck || humanDeckApplied || humanDeckApplying || !lobbyId) return;
    const human = humanLobbyUser();
    if (!human) return;
    humanDeckApplying = true;
    try {
        const res = await post(`/api/lobby/${lobbyId}/change-deck`, {
            user: { id: human.id, username: human.username },
            deck: humanDeck,
        });
        if (res.status === 200) {
            humanDeckApplied = true;
            console.log(`Human deck set from the practice page: ${humanDeckLabel}`);
            writeState({ humanDeckSet: true });
            maybeStart();
        } else {
            console.log(`change-deck for human failed (${res.status}): ${JSON.stringify(res.json).slice(0, 200)} — will retry`);
        }
    } catch (e) {
        console.log('change-deck for human errored — will retry', e);
    } finally {
        humanDeckApplying = false;
    }
}

// Start the game when the table is complete. Auto mode (human deck given):
// the human only has to be IN the lobby with the deck applied — no ready
// click (startGameAsync checks deck sizes, not ready flags). Manual mode:
// both players ready, as before. A Bo3 series restart (after a newBo3
// rematch) always uses the ready flow, and only once winHistory shows a
// fresh set.
function maybeStart() {
    if (phase !== 'waiting' && phase !== 'gameover') return;
    if (!latestLobby || latestLobby.gameOngoing) return;
    const human = humanLobbyUser();
    if (!human) return;
    if (Date.now() - lastStartAttempt < 4000) return;
    const autoStart = humanDeck && (phase === 'waiting' || mode === 'bo1');
    if (phase === 'gameover' && mode === 'bo3') {
        const wh = latestLobby.winHistory;
        const freshSet = wh && wh.currentGameNumber === 1 && !wh.setEndResult
            && Object.values(wh.winsPerPlayer ?? {}).every((w) => w === 0);
        if (!freshSet) return;
    }
    if (autoStart) {
        if (!humanDeckApplied) return;
    } else {
        const me = myLobbyUser();
        if (!human.ready || me?.ready === false) return;
    }
    lastStartAttempt = Date.now();
    console.log('Table is complete — starting the game...');
    seat.socket.emit('lobby', 'startGameAsync');
}

function myLobbyUser() {
    return (latestLobby?.users ?? []).find((u) => u.id === seat.user.id) ?? null;
}
function humanLobbyUser() {
    return (latestLobby?.users ?? []).find((u) => u.id !== seat.user.id) ?? null;
}
function seriesScore() {
    const wh = latestLobby?.winHistory;
    if (!wh || wh.gamesToWinMode !== 'bestOfThree' || !wh.winsPerPlayer) return null;
    return {
        bot: wh.winsPerPlayer[seat.user.id] ?? 0,
        human: humanUserId ? (wh.winsPerPlayer[humanUserId] ?? 0) : 0,
    };
}
function setIsComplete() {
    const wh = latestLobby?.winHistory;
    if (!wh || wh.gamesToWinMode !== 'bestOfThree') return false;
    if (wh.setEndResult) return true;
    return Object.values(wh.winsPerPlayer ?? {}).some((w) => w >= 2);
}

function exitBot(code, status) {
    if (status) writeState({ status });
    try { flushCapture(); } catch { /* best effort */ }
    process.exit(code);
}
process.on('SIGTERM', () => exitBot(0));
process.on('SIGINT', () => exitBot(0));

// Learn both players' leader/base labels from any gamestate (public info).
function learnLabels(gs) {
    for (const p of Object.values(gs?.players ?? {})) {
        const label = [p.leaders?.[0]?.name, p.base?.name].filter(Boolean).join(' / ') || null;
        if (p?.user?.username === seat.lobbyUsername) { if (label) botLabel = label; }
        else if (label) {
            humanLabel = label;
            humanUsername = p?.user?.username ?? humanUsername;
        }
    }
}

seat.onGameStart = () => {
    phase = 'playing';
    gameNumber += 1;
    gameStartedAt = Date.now();
    humanGoneSince = null;
    writeState({ status: 'playing', phase, gameNumber, gameStartedAt, series: seriesScore() });
    console.log(`Game ${gameNumber} started.`);
};

// Write the summary file + record-book entry for one finished game.
function recordFinishedGame({ winnerSide, winnerName, gameNumber: n, durationMs }) {
    const seats = [
        { label: 'Bot', name: seat.lobbyUsername ?? botName, leader: botLabel?.split(' / ')[0] ?? null, base: botLabel?.split(' / ')[1] ?? null, deck: deckLabel },
        { label: 'You', name: humanUsername ?? 'Human', leader: humanLabel?.split(' / ')[0] ?? null, base: humanLabel?.split(' / ')[1] ?? null, deck: humanLabel ?? undefined },
    ];
    const lines = seat.messageLog.lines();
    const summaryText = buildSummary({
        mode, gameNumber: n, seats,
        winnerName: winnerName ? `${winnerSide === 'bot' ? 'Bot' : 'You'} (${winnerName})` : null,
        startedAt: gameStartedAt ?? startedAt, endedAt: Date.now(), lines,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const summaryFile = path.join(summariesDir, `${stamp}-${mode}-game${n}.txt`);
    try { writeFileSync(summaryFile, summaryText); } catch (e) { console.error('summary write failed', e); }
    appendRecord({
        kind: 'game', mode, gameNumber: n,
        botDeck: deckLabel, humanDeck: humanLabel ?? undefined,
        winnerSide, winnerName, durationMs: durationMs ?? null, summaryFile,
    }, recordsFile);
    seriesGames.push({ gameNumber: n, winnerSide, winnerName, summaryText, summaryFile });
    console.log(`Game ${n} over — winner: ${winnerName} (${winnerSide}). Summary: ${summaryFile}`);
    return summaryFile;
}

seat.onGameEnd = (info) => {
    lastGameEndAt = Date.now();
    try { flushCapture(); } catch { /* best effort */ }
    if (mode === 'bo3') {
        // Bo3 results are recorded from the lobby winHistory instead (see
        // syncBo3Results): mid-series, the gamestate winners/id stream
        // proved unreliable — one game's final state never arrived here,
        // while winHistory always reflects the true series score.
        console.log(`Bo3 game ended (winners: ${JSON.stringify(info.winners ?? [])}) — recording via winHistory.`);
        syncBo3Results();
        return;
    }
    const winners = info.winners ?? [];
    const botWon = seat.lobbyUsername != null && winners.includes(seat.lobbyUsername);
    const winnerName = winners[0] ?? null;
    const winnerSide = botWon ? 'bot' : (winnerName ? 'human' : null);
    const summaryFile = recordFinishedGame({ winnerSide, winnerName, gameNumber, durationMs: info.durationMs });

    if (mode === 'bo1') {
        phase = 'gameover';
        writeState({ status: 'finished', phase, lastWinner: winnerName, summaryFile, series: null });
        if (offerRematch && lobbyId) {
            rematchOfferedFor = info.gameId;
            setTimeout(() => {
                if (phase === 'gameover') {
                    console.log('Offering rematch (regular)...');
                    seat.socket.emit('lobby', 'requestRematch', 'regular');
                }
            }, 1000);
        }
    } else {
        // Bo3: the lobbystate handler decides betweengames vs series-over
        // once the updated winHistory arrives.
        phase = 'ending';
        writeState({ status: 'playing', phase: 'betweengames', lastWinner: winnerName, summaryFile, series: seriesScore() });
    }
};

// Bo3 end-of-game decision, driven by the lobby's winHistory. Called from
// the lobbystate handler and from the poll loop (in case no further
// lobbystate arrives after the final gamestate).
function checkBo3End() {
    if (mode !== 'bo3' || phase !== 'ending' || !latestLobby?.winHistory) return;
    if (setIsComplete()) {
        finishSeries();
    } else {
        phase = 'betweengames';
        writeState({ status: 'playing', phase, series: seriesScore() });
        console.log(`Between games — series score: ${JSON.stringify(seriesScore())}.`);
    }
}

let prevWinsPerPlayer = {};
let recordedGames = 0;
let lastSummaryFile = null;
// Bo3 bookkeeping driven by the lobby winHistory (the authoritative
// series record): whenever the total series wins grow past the games
// already recorded, record the newly finished game — the winner is the
// player whose win count increased. This runs from the lobbystate
// handler and the poll, so a game is recorded even if its final
// gamestate never reached the bot's seat.
function syncBo3Results() {
    if (mode !== 'bo3' || phase === 'gameover' || !latestLobby?.winHistory) return;
    const wh = latestLobby.winHistory;
    const wins = wh.winsPerPlayer ?? {};
    const total = Object.values(wins).reduce((a, b) => a + b, 0);
    let recorded = false;
    while (recordedGames < total) {
        let winnerId = null;
        for (const [uid, w] of Object.entries(wins)) {
            if ((prevWinsPerPlayer[uid] ?? 0) < w) { winnerId = uid; break; }
        }
        prevWinsPerPlayer = { ...wins };
        recordedGames += 1;
        const winnerSide = winnerId === seat.user.id ? 'bot' : 'human';
        const winnerName = (winnerId && wh.playerNames?.[winnerId]) ?? winnerId ?? null;
        lastSummaryFile = recordFinishedGame({ winnerSide, winnerName, gameNumber: recordedGames, durationMs: null });
        recorded = true;
    }
    if (recorded) {
        phase = 'ending';
        writeState({ status: 'playing', phase, gameNumber: recordedGames, series: seriesScore(), summaryFile: lastSummaryFile, lastWinner: seriesGames[seriesGames.length - 1]?.winnerName ?? null });
        checkBo3End();
    }
}

// Confirm the next Bo3 game once per completed game. Called from the poll
// as well as the lobbystate handler: the phase flip can happen inside the
// poll's checkBo3End, after which no new lobbystate may arrive to trigger
// a handler-only emit — that combination deadlocked a series once.
function maybeProceed() {
    if (mode !== 'bo3' || phase !== 'betweengames' || proceededForGame === gameNumber) return;
    proceededForGame = gameNumber;
    lastProceedAttempt = Date.now();
    console.log('Confirming proceed to next Bo3 game.');
    seat.socket.emit('lobby', 'proceedToNextBo3Game');
}

let readiedForGame = 0;
// Second half of the Bo3 between-games flow (the engine's actual design):
// once BOTH sides confirm proceed, the server advances to the next game's
// lobby (winHistory.currentGameNumber moves past the completed count,
// ready flags cleared, no game yet). That lobby is the sideboard window —
// updateDeck only passes its assert there. The bot readies itself and
// starts the game when the human readies (their ready click is their
// "done sideboarding" signal, exactly as in the real client).
function maybeStartNextBo3Game() {
    if (mode !== 'bo3' || phase !== 'betweengames' || !latestLobby) return;
    const wh = latestLobby.winHistory;
    if (!wh || latestLobby.gameOngoing) return;
    if ((wh.currentGameNumber ?? 1) !== gameNumber + 1) return;
    const human = humanLobbyUser();
    if (!human) return;
    if (readiedForGame !== gameNumber) {
        readiedForGame = gameNumber;
        seat.socket.emit('lobby', 'setReadyStatus', true);
        console.log('Bot is ready for the next Bo3 game (sideboard window open).');
    }
    if (human.ready && Date.now() - lastStartAttempt > 4000) {
        lastStartAttempt = Date.now();
        console.log('Human is ready — starting the next Bo3 game...');
        seat.socket.emit('lobby', 'startGameAsync');
    }
}

function finishSeries() {
    phase = 'gameover';
    const score = seriesScore();
    const winnerSide = score ? (score.bot >= 2 ? 'bot' : (score.human >= 2 ? 'human' : null)) : null;
    const winnerName = winnerSide === 'bot' ? seat.lobbyUsername : (winnerSide === 'human' ? humanUsername : null);
    const seats = [
        { label: 'Bot', name: seat.lobbyUsername ?? botName, leader: botLabel?.split(' / ')[0] ?? null, base: botLabel?.split(' / ')[1] ?? null, deck: deckLabel },
        { label: 'You', name: humanUsername ?? 'Human', leader: humanLabel?.split(' / ')[0] ?? null, base: humanLabel?.split(' / ')[1] ?? null, deck: humanLabel ?? undefined },
    ];
    const seriesText = buildSeriesSummary({
        seats,
        games: seriesGames.map((g) => ({ gameNumber: g.gameNumber, winnerName: g.winnerName, summaryText: g.summaryText })),
        winnerName: winnerName ? `${winnerSide === 'bot' ? 'Bot' : 'You'} (${winnerName})` : null,
        endedAt: Date.now(),
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const seriesFile = path.join(summariesDir, `${stamp}-bo3-series.txt`);
    try { writeFileSync(seriesFile, seriesText); } catch (e) { console.error('series summary write failed', e); }
    appendRecord({
        kind: 'series', mode: 'bo3', botDeck: deckLabel, humanDeck: humanLabel ?? undefined,
        winnerSide, winnerName, games: seriesGames.map((g) => ({ gameNumber: g.gameNumber, winnerSide: g.winnerSide })),
        summaryFile: seriesFile,
    }, recordsFile);
    console.log(`Series over — winner: ${winnerName} (${winnerSide}). Series summary: ${seriesFile}`);
    writeState({ status: 'finished', phase: 'seriesover', lastWinner: winnerName, summaryFile: seriesFile, series: score });
    if (offerRematch && lobbyId) {
        setTimeout(() => {
            if (phase === 'gameover') {
                console.log('Offering a new Bo3 set...');
                seat.socket.emit('lobby', 'requestRematch', 'newBo3');
            }
        }, 1000);
    }
    seriesGames = [];
}

// ---------------------------------------------------------------- lobby flow
const create = await post('/api/create-lobby', {
    user: seat.user, deck, isPrivate: true, format: 'eternal',
    lobbyName: `Practice vs ${botName}`, cardPool: 'current',
    gamesToWinMode: mode === 'bo3' ? 'bestOfThree' : 'bestOfOne',
});
if (create.status !== 200) { console.error('opponent: create-lobby failed', create); process.exit(1); }
seat.connect(null);
seat.socket.on('gamestate', (gs) => learnLabels(gs));

seat.socket.on('lobbystate', (ls) => {
    latestLobby = ls;
    const human = humanLobbyUser();
    if (human) { humanUserId = human.id; humanUsername = human.username ?? humanUsername; }
    if (humanDeck && human) applyHumanDeck();

    if (ls?.id && !lobbyId) {
        lobbyId = ls.id;
        const joinUrl = `${clientUrl}/lobby?lobbyId=${lobbyId}`;
        console.log(`LOBBY READY lobbyId=${lobbyId}`);
        console.log(`JOIN URL: ${joinUrl}`);
        writeState({ status: 'waiting', phase, lobbyId, joinUrl });
    }

    // Bo3: after a game ends, either advance to the next game or close out
    // the series, once winHistory reflects the finished game.
    syncBo3Results();
    checkBo3End();
    maybeProceed();
    maybeStartNextBo3Game();
    if (ls?.gameOngoing && phase === 'waiting') {
        // A game we didn't see start via the hook (safety net). Gated to
        // 'waiting': between Bo3 games the lobby can keep reporting the
        // finished game as ongoing, which must not flip betweengames into
        // a fake 'playing' (that once tripped the stall watchdog).
        phase = 'playing';
        writeState({ status: 'playing', phase });
    }

    // Rematch: confirm the human's request; the bot's own offers are made in
    // onGameEnd / finishSeries. Regular-style requests are confirmed with
    // 'rematch'; a 'reset' (quick rematch) request is confirmed by starting.
    const rr = ls?.rematchRequest;
    if (rr && rr.initiator !== seat.user.id && !ls.gameOngoing) {
        const sig = `${rr.initiator}:${rr.mode}`;
        if (handledRematchRequest !== sig) {
            handledRematchRequest = sig;
            console.log(`Human requested rematch (${rr.mode}) — confirming.`);
            if (rr.mode === 'reset') seat.socket.emit('lobby', 'startGameAsync');
            else seat.socket.emit('lobby', 'rematch');
        }
    } else if (!rr) {
        handledRematchRequest = null;
    }

    // Keep the bot readied whenever we're between games in the ready-flow
    // phases (initial wait and post-rematch lobby).
    const me = myLobbyUser();
    if (me && me.ready === false && (phase === 'waiting' || phase === 'gameover') && !ls.gameOngoing) {
        seat.socket.emit('lobby', 'setReadyStatus', true);
    }

    // Track human presence for the post-game exit.
    if (!human && (phase === 'gameover' || phase === 'betweengames')) {
        humanGoneSince = humanGoneSince ?? Date.now();
    } else if (human) {
        humanGoneSince = null;
    }
    maybeStart();
    writeState({ series: seriesScore(), gameNumber });
});

console.log(`Opponent bot "${botName}" created a ${mode} lobby with deck: ${deckLabel}`);
writeState({ status: 'waiting', phase });

// ---------------------------------------------------------------- poll loop
const poll = setInterval(() => {
    const ls = latestLobby;
    const elapsed = Date.now() - startedAt;
    const other = humanLobbyUser();
    const me = myLobbyUser();

    // Live clock for the practice page.
    if (phase === 'playing') {
        writeState({
            waitingOn: seat.hasActionablePrompt ? 'bot' : 'human',
            lastActionAt: seat.lastStateAt,
            gameStartedAt,
        });
    }

    syncBo3Results();
    checkBo3End();
    maybeProceed();
    maybeStartNextBo3Game();
    maybeStart();

    if (phase === 'waiting') {
        if (!other && elapsed > waitSeconds * 1000) {
            console.log(`No human joined within ${waitSeconds}s — giving up.`);
            writeState({ status: 'expired', phase });
            exitBot(4);
        }
        if (elapsed > (waitSeconds + 1800) * 1000) {
            console.log('TIME CAP reached while waiting');
            exitBot(3);
        }
    } else if (phase === 'playing') {
        const idleMs = Date.now() - seat.lastStateAt;
        // While the human is disconnected (lobby state says so), the game
        // is legitimately paused — no states flow to anyone. Don't call
        // that a stall: the resume window matters more than the watchdog.
        const humanDropped = !!other && !!other.state && other.state !== 'connected';
        if (idleMs > 60000 && !humanDropped) {
            console.log(`STALL: no gamestate for ${Math.round(idleMs / 1000)}s after game start`);
            writeState({ status: 'stalled', phase });
            exitBot(2);
        }
        if (elapsed > (waitSeconds + 1800) * 1000) {
            console.log('TIME CAP reached');
            exitBot(3);
        }
    } else if (phase === 'gameover' || phase === 'betweengames') {
        if (humanGoneSince && Date.now() - humanGoneSince > 8000) {
            console.log('Human left the lobby — practice session over.');
            exitBot(0, 'finished');
        }
        if (lastGameEndAt && Date.now() - lastGameEndAt > 900 * 1000) {
            console.log('Post-game linger cap reached — exiting.');
            exitBot(0, 'finished');
        }
        if (elapsed > (waitSeconds + 1800) * 1000) {
            console.log('TIME CAP reached');
            exitBot(3);
        }
    }
}, 2000);
poll.unref();
