// Centerpiece test for the Stage 6 single-page flow: the human seat is
// joined with a pre-chosen deck and the game is started WITHOUT the human
// picking a deck or clicking ready — exactly what the redesigned practice
// page promises.
//   1. spawn opponent.mjs with --human-deck-id (the page's YOUR DECK pick),
//   2. join as the "human" through the API+socket sequence ONLY (no
//      change-deck call, no setReadyStatus — the two manual steps the old
//      flow forced in the client lobby),
//   3. assert: the human's lobby self-view shows the pre-chosen deck
//      applied, their ready flag stays false, yet the game starts, plays
//      to a winner, and produces a summary + record-book entry.
// Usage: node test-autostart.mjs [timeoutSec]
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Seat, post } from './bot.mjs';
import { getDeck } from '../decks/library.mjs';

const timeoutSec = parseInt(process.argv[2] ?? '600', 10);
const botDeckId = 'community:0';
const humanDeckId = 'my:vader-coaxium-mine';
const humanDeck = getDeck(humanDeckId);
const stateFile = new URL('./autostart-test-state.json', import.meta.url).pathname;
const recordsFile = new URL('./autostart-test-records.json', import.meta.url).pathname;
const summariesDir = new URL('./autostart-test-summaries/', import.meta.url).pathname;
for (const f of [stateFile, recordsFile]) { try { rmSync(f); } catch { /* fresh */ } }

const child = spawn(process.execPath, [
    'opponent.mjs', '--deck-id', botDeckId, '--human-deck-id', humanDeckId,
    '--state-file', stateFile, '--records-file', recordsFile,
    '--summaries-dir', summariesDir, '--wait-seconds', '120',
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
for (let i = 0; i < 60 && !lobbyId; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (existsSync(stateFile)) {
        try { lobbyId = JSON.parse(readFileSync(stateFile, 'utf8')).lobbyId ?? null; } catch { /* partial */ }
    }
}
if (!lobbyId) { console.error('TEST FAIL: no lobbyId'); child.kill('SIGKILL'); process.exit(1); }
console.log(`Joining lobby ${lobbyId} as the human seat (no deck pick, no ready)...`);

const human = new Seat('AutoHuman', humanDeck);
human.user = { id: randomUUID(), username: 'AutoHuman' };
human.stayAliveOnGameEnd = true;

let sawReadyTrue = false;
let deckSeenInLobby = null;
let gameStarted = false;
let gameEnded = null;
human.onGameStart = () => { gameStarted = true; console.log('Human seat received a live game (gamestate flowing).'); };
human.onGameEnd = (info) => { gameEnded = info; };

const join = await post('/api/join-lobby', { lobbyId, user: human.user });
if (join.status !== 200) { console.error('TEST FAIL: join-lobby', join); child.kill('SIGKILL'); process.exit(1); }
human.connect(lobbyId);
human.socket.on('lobbystate', (ls) => {
    const me = (ls.users ?? []).find((u) => u.id === human.user.id);
    if (!me) return;
    if (me.ready) sawReadyTrue = true;
    if (me.deck) deckSeenInLobby = me.deck;
});
// NOTE: deliberately NO change-deck call and NO setReadyStatus here.

const deadline = Date.now() + timeoutSec * 1000;
while (!gameEnded && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
}
// The opponent writes its summary/record/state from its own process when IT
// sees the win — give it a moment to land before asserting on the files.
for (let i = 0; i < 20; i++) {
    try {
        const s = JSON.parse(readFileSync(stateFile, 'utf8'));
        if (s.status === 'finished') break;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
}
const failures = [];
if (!gameStarted) failures.push('game never started');
if (!gameEnded) failures.push('game never ended');
if (sawReadyTrue) failures.push('human ready flag became true (the test never readied — something else set it)');
if (!deckSeenInLobby) failures.push('human deck never appeared in their lobby self-view');
else {
    const leaderId = deckSeenInLobby.leader?.id ?? deckSeenInLobby.leader?.setId ?? null;
    const deckCards = deckSeenInLobby.deckCards ?? deckSeenInLobby.cards ?? [];
    console.log(`Lobby self-view deck: leader=${JSON.stringify(deckSeenInLobby.leader)?.slice(0, 120)} mainCards=${Array.isArray(deckCards) ? deckCards.length : '?'}`);
    if (leaderId && leaderId !== humanDeck.leader.id) failures.push(`applied leader ${leaderId} != chosen ${humanDeck.leader.id}`);
}
let st = null;
try { st = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }
if (!st?.humanDeckSet) failures.push('opponent state does not show humanDeckSet');
if (st?.status !== 'finished') failures.push(`opponent state status=${st?.status}, expected finished`);
let rec = null;
try { rec = JSON.parse(readFileSync(recordsFile, 'utf8')); } catch { /* ignore */ }
const gameEntries = (rec?.entries ?? []).filter((e) => e.kind === 'game');
if (gameEntries.length !== 1) failures.push(`records has ${gameEntries.length} game entries, expected 1`);
if (st?.summaryFile && !existsSync(st.summaryFile)) failures.push('summary file missing on disk');

child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1000));
if (failures.length) { console.error('TEST FAIL:', failures.join('; ')); process.exit(1); }
console.log('TEST PASS — deck applied + game auto-started with human ready flag false throughout');
process.exit(0);
