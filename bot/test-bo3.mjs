// Bo3 + sideboard test (Stage 6): a full best-of-3 series vs the practice
// bot in AUTO mode (human deck pre-chosen, game 1 auto-starts).
//   - game 1 plays to a winner,
//   - between games the human performs a REAL sideboard swap through the
//     lobby updateDeck protocol (one main-deck card out, one sideboard
//     card in) and the swap is verified against the human's own lobby
//     decklist (50 main / 10 sideboard, composition changed),
//   - both sides confirm proceedToNextBo3Game (the bot confirms on its
//     own; the human confirms here) and the series runs to completion,
//   - the record book gains per-game entries AND a series entry, and a
//     series summary file is written.
// Usage: node test-bo3.mjs [timeoutSec]
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Seat, post } from './bot.mjs';
import { getDeck } from '../decks/library.mjs';

const timeoutSec = parseInt(process.argv[2] ?? '1500', 10);
const stateFile = new URL('./bo3-test-state.json', import.meta.url).pathname;
const recordsFile = new URL('./bo3-test-records.json', import.meta.url).pathname;
const summariesDir = new URL('./bo3-test-summaries/', import.meta.url).pathname;
for (const f of [stateFile, recordsFile]) { try { rmSync(f); } catch { /* fresh */ } }

// Pick a community deck with a real sideboard for the human; bot takes another.
const count = (list) => (list ?? []).reduce((a, c) => a + (c.count ?? 0), 0);
let humanDeckId = null;
for (let i = 0; i < 12 && !humanDeckId; i++) {
    const d = getDeck(`community:${i}`);
    if (d && count(d.sideboard) >= 3) humanDeckId = `community:${i}`;
}
if (!humanDeckId) { console.error('TEST FAIL: no community deck with a sideboard'); process.exit(1); }
const botDeckId = humanDeckId === 'community:0' ? 'community:1' : 'community:0';
const humanDeck = getDeck(humanDeckId);
console.log(`Bo3 test: bot=${botDeckId} human=${humanDeckId} (sideboard ${count(humanDeck.sideboard)})`);

const child = spawn(process.execPath, [
    'opponent.mjs', '--deck-id', botDeckId, '--mode', 'bo3', '--human-deck-id', humanDeckId,
    '--state-file', stateFile, '--records-file', recordsFile,
    '--summaries-dir', summariesDir, '--wait-seconds', '180',
], { cwd: new URL('.', import.meta.url).pathname, stdio: 'inherit' });

const hardTimeout = setTimeout(() => {
    console.error(`TEST TIMEOUT after ${timeoutSec}s`);
    child.kill('SIGKILL');
    process.exit(1);
}, timeoutSec * 1000);
hardTimeout.unref();
child.on('exit', (code) => {
    if (code !== 0 && code !== null) { console.error(`TEST FAIL: opponent exited ${code}`); process.exit(1); }
});

let lobbyId = null;
for (let i = 0; i < 90 && !lobbyId; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (existsSync(stateFile)) {
        try { lobbyId = JSON.parse(readFileSync(stateFile, 'utf8')).lobbyId ?? null; } catch { /* partial */ }
    }
}
if (!lobbyId) { console.error('TEST FAIL: no lobbyId'); child.kill('SIGKILL'); process.exit(1); }

const human = new Seat('Bo3Human', humanDeck);
human.user = { id: randomUUID(), username: 'Bo3Human' };
human.stayAliveOnGameEnd = true;
let gamesStarted = 0;
let gamesEnded = 0;
let betweenGames = false;
human.onGameStart = () => { gamesStarted++; betweenGames = false; console.log(`Human: game ${gamesStarted} started`); };
human.onGameEnd = () => { gamesEnded++; betweenGames = true; };

const join = await post('/api/join-lobby', { lobbyId, user: human.user });
if (join.status !== 200) { console.error('TEST FAIL: join-lobby', join); child.kill('SIGKILL'); process.exit(1); }
human.connect(lobbyId);

// ---- sideboard + proceed driver ----
// Driven from an interval over the last seen lobbystate (not only inside
// the event handler): between games, lobbystate events can stop arriving,
// and winHistory.currentGameNumber does not reliably read "next game" —
// the completed-games count is the dependable signal.
const outId = humanDeck.deck[0].id;
const inId = humanDeck.sideboard[0].id;
let swapping = false;
let swapped = false;
let swapVerified = false;
const proceededFor = new Set();
let lastSelfDeck = null;
let lastLobby = null;

human.socket.on('lobbystate', (ls) => {
    lastLobby = ls;
    const me = (ls.users ?? []).find((u) => u.id === human.user.id);
    if (me?.deck) lastSelfDeck = me.deck;
});

const readiedFor = new Set();
const driver = setInterval(async () => {
    const ls = lastLobby;
    // NOTE: ls.gameOngoing is deliberately NOT consulted — between Bo3
    // games the lobby can keep reporting the finished game as ongoing.
    // The Seat's own game-end hook is the reliable between-games signal.
    if (!ls || !betweenGames || gamesEnded < 1) return;
    const wh = ls.winHistory;
    if (!wh) return;
    const setDone = !!wh.setEndResult || Object.values(wh.winsPerPlayer ?? {}).some((w) => w >= 2);
    if (setDone) return;
    // The engine's between-games order (from Lobby.ts): BOTH sides confirm
    // proceed -> the server advances to the next game's lobby
    // (currentGameNumber increments, ready flags cleared) -> THAT lobby is
    // the sideboard window (updateDeck asserts before it) -> ready up ->
    // host starts. Follow it exactly:
    if (!proceededFor.has(gamesEnded)) {
        proceededFor.add(gamesEnded);
        console.log(`Confirming proceed after game ${gamesEnded}`);
        human.socket.emit('lobby', 'proceedToNextBo3Game');
        return;
    }
    if ((wh.currentGameNumber ?? 1) < gamesEnded + 1) return; // transition pending
    if (!swapped && !swapping) {
        swapping = true;
        console.log(`Sideboard window open — sideboarding: out ${outId}, in ${inId}`);
        human.socket.emit('lobby', 'updateDeck', 'Deck', outId);
        await new Promise((r) => setTimeout(r, 1200));
        human.socket.emit('lobby', 'updateDeck', 'Sideboard', inId);
        await new Promise((r) => setTimeout(r, 1200));
        swapped = true;
        swapping = false;
        // Verify against the latest self-view decklist.
        if (lastSelfDeck) {
            const main = count(lastSelfDeck.deck);
            const side = count(lastSelfDeck.sideboard);
            const inMain = (lastSelfDeck.deck ?? []).find((c) => c.id === inId);
            const outInSide = (lastSelfDeck.sideboard ?? []).find((c) => c.id === outId);
            console.log(`Post-swap decklist: main=${main} sideboard=${side} inCardInMain=${JSON.stringify(inMain)} outCardInSide=${JSON.stringify(outInSide)}`);
            swapVerified = main === 50 && side === 10 && !!inMain && !!outInSide;
        }
        return;
    }
    if (swapped && !readiedFor.has(gamesEnded)) {
        readiedFor.add(gamesEnded);
        console.log('Human ready for the next game');
        human.socket.emit('lobby', 'setReadyStatus', true);
    }
}, 1500);
driver.unref();

// ---- wait for the series record ----
const deadline = Date.now() + timeoutSec * 1000;
let seriesEntry = null;
let gameEntries = [];
while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
        const rec = JSON.parse(readFileSync(recordsFile, 'utf8'));
        gameEntries = rec.entries.filter((e) => e.kind === 'game');
        seriesEntry = rec.entries.find((e) => e.kind === 'series') ?? null;
        if (seriesEntry) break;
    } catch { /* not yet */ }
}
let st = null;
try { st = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }

const failures = [];
if (!seriesEntry) failures.push('no series entry in the record book');
else {
    if (!Array.isArray(seriesEntry.games) || seriesEntry.games.length < 2) failures.push(`series games=${JSON.stringify(seriesEntry.games)}`);
    if (!['human', 'bot'].includes(seriesEntry.winnerSide)) failures.push(`series winnerSide=${seriesEntry.winnerSide}`);
    if (seriesEntry.summaryFile && !existsSync(seriesEntry.summaryFile)) failures.push('series summary file missing');
}
if (gameEntries.length < 2) failures.push(`only ${gameEntries.length} game entries, expected >= 2`);
if (gamesStarted < 2) failures.push(`only ${gamesStarted} games started`);
if (!swapVerified) failures.push('sideboard swap not verified in the human decklist');
if (st?.status !== 'finished' || st?.phase !== 'seriesover') failures.push(`state=${st?.status}/${st?.phase}, expected finished/seriesover`);

child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1000));
if (failures.length) { console.error('TEST FAIL:', failures.join('; ')); process.exit(1); }
console.log(`TEST PASS — Bo3 series complete (${gameEntries.length} games), sideboard swap verified, series recorded`);
process.exit(0);
