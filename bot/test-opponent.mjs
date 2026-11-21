// End-to-end test of the practice flow in MANUAL mode (no pre-chosen human
// deck — the Stage 4 flow, kept as a regression test after Stage 6):
//   1. spawn bot/opponent.mjs with a community deck (no --human-deck-id),
//   2. wait for its state file to publish a lobbyId,
//   3. join as the "human" seat through the exact API+socket sequence the
//      web client uses (join-lobby -> connect -> change-deck -> ready),
//   4. the opponent bot starts the game; both seats auto-play with the
//      Stage 2 heuristics; at the win, the opponent (which now STAYS in the
//      lobby to offer a rematch) must have written the play-by-play summary
//      and a record-book entry, with state status 'finished'.
// Usage: node test-opponent.mjs [communityDeckId] [myDeckFile] [timeoutSec]
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Seat, post } from './bot.mjs';

const communityId = process.argv[2] ?? 'community:0';
const myDeckFile = process.argv[3] ?? new URL('../decks/my/vader-deck-holoscan.json', import.meta.url).pathname;
const timeoutSec = parseInt(process.argv[4] ?? '600', 10);
const stateFile = new URL('./opponent-test-state.json', import.meta.url).pathname;
const recordsFile = new URL('./opponent-test-records.json', import.meta.url).pathname;
const summariesDir = new URL('./opponent-test-summaries/', import.meta.url).pathname;
for (const f of [stateFile, recordsFile]) { try { rmSync(f); } catch { /* fresh */ } }

const child = spawn(process.execPath, [
    'opponent.mjs', '--deck-id', communityId, '--state-file', stateFile,
    '--records-file', recordsFile, '--summaries-dir', summariesDir,
    '--wait-seconds', '120', '--no-rematch',
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
        try { lobbyId = JSON.parse(readFileSync(stateFile, 'utf8')).lobbyId ?? null; } catch { /* partial write */ }
    }
}
if (!lobbyId) { console.error('TEST FAIL: opponent never published a lobbyId'); child.kill('SIGKILL'); process.exit(1); }
console.log(`Joining lobby ${lobbyId} as the human seat (manual deck pick + ready)...`);

const myDeck = JSON.parse(readFileSync(myDeckFile, 'utf8'));
const human = new Seat('TestHuman', myDeck);
human.user = { id: randomUUID(), username: 'TestHuman' };
human.stayAliveOnGameEnd = true;
let gameEnded = null;
human.onGameEnd = (info) => { gameEnded = info; };

const join = await post('/api/join-lobby', { lobbyId, user: human.user });
if (join.status !== 200) { console.error('TEST FAIL: join-lobby', join); child.kill('SIGKILL'); process.exit(1); }
human.connect(lobbyId);
await new Promise((r) => setTimeout(r, 2000));
const change = await post(`/api/lobby/${lobbyId}/change-deck`, { user: human.user, deck: myDeck });
if (change.status !== 200) { console.error('TEST FAIL: change-deck', change); child.kill('SIGKILL'); process.exit(1); }
human.socket.emit('lobby', 'setReadyStatus', true);
console.log('Human seat ready. Waiting for the game to play out...');

const deadline = Date.now() + timeoutSec * 1000;
while (!gameEnded && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
}
let st = null;
for (let i = 0; i < 20 && gameEnded; i++) {
    try {
        st = JSON.parse(readFileSync(stateFile, 'utf8'));
        if (st.status === 'finished') break;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
}
const failures = [];
if (!gameEnded) failures.push('game never ended');
if (st?.status !== 'finished') failures.push(`opponent state status=${st?.status}, expected finished`);
if (st?.summaryFile && !existsSync(st.summaryFile)) failures.push('summary file missing on disk');
if (st?.summaryFile && existsSync(st.summaryFile)) {
    const text = readFileSync(st.summaryFile, 'utf8');
    if (!text.includes('PLAY-BY-PLAY')) failures.push('summary lacks play-by-play section');
    if (text.split('\n').length < 40) failures.push('summary suspiciously short');
}
let rec = null;
try { rec = JSON.parse(readFileSync(recordsFile, 'utf8')); } catch { /* ignore */ }
const gameEntries = (rec?.entries ?? []).filter((e) => e.kind === 'game');
if (gameEntries.length !== 1) failures.push(`records has ${gameEntries.length} game entries, expected 1`);
else if (!['human', 'bot'].includes(gameEntries[0].winnerSide)) failures.push(`record winnerSide=${gameEntries[0].winnerSide}`);

child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1000));
if (failures.length) { console.error('TEST FAIL:', failures.join('; ')); process.exit(1); }
console.log('TEST PASS (manual flow + summary + record book)');
process.exit(0);
