// Resume test (Stage 6): the game lives on the server, so a human whose
// connection drops mid-game can rejoin the same seat (same user id — the
// web client persists its anonymous id in localStorage) and the game
// continues. This test:
//   1. starts an AUTO-mode game (deck pre-chosen, auto-start),
//   2. lets it run until several prompts have been answered,
//   3. hard-closes the human socket (simulated crash — no manual
//      disconnect flag), waits 10s (inside the server's ~20s disconnect
//      grace), reconnects with the SAME user id,
//   4. asserts gamestates flow again and the game plays to a winner.
// Usage: node test-resume.mjs [timeoutSec]
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Seat, post } from './bot.mjs';
import { getDeck } from '../decks/library.mjs';

const timeoutSec = parseInt(process.argv[2] ?? '600', 10);
const stateFile = new URL('./resume-test-state.json', import.meta.url).pathname;
const recordsFile = new URL('./resume-test-records.json', import.meta.url).pathname;
const summariesDir = new URL('./resume-test-summaries/', import.meta.url).pathname;
for (const f of [stateFile, recordsFile]) { try { rmSync(f); } catch { /* fresh */ } }

const child = spawn(process.execPath, [
    'opponent.mjs', '--deck-id', 'community:0', '--human-deck-id', 'my:vader-coaxium-mine',
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

const human = new Seat('ResumeHuman', getDeck('my:vader-coaxium-mine'));
human.user = { id: randomUUID(), username: 'ResumeHuman' };
human.stayAliveOnGameEnd = true;
let gameEnded = null;
let statesBefore = 0;
let statesAfter = 0;
let phase = 'before';
human.onGameEnd = (info) => { gameEnded = info; };

const join = await post('/api/join-lobby', { lobbyId, user: human.user });
if (join.status !== 200) { console.error('TEST FAIL: join-lobby', join); child.kill('SIGKILL'); process.exit(1); }
human.connect(lobbyId);
human.socket.on('gamestate', () => { if (phase === 'before') statesBefore++; else if (phase === 'after') statesAfter++; });

// Wait until the game is genuinely under way.
const t0 = Date.now();
while (statesBefore < 12 && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 500));
if (statesBefore < 12) { console.error(`TEST FAIL: game never got going (${statesBefore} states)`); child.kill('SIGKILL'); process.exit(1); }
console.log(`Game under way (${statesBefore} states). Disconnecting the human socket for 10s...`);
phase = 'away';
human.socket.close();
await new Promise((r) => setTimeout(r, 10000));
console.log('Reconnecting with the same user id...');
phase = 'after';
human.connect(lobbyId);
// connect() created a fresh socket — re-attach the state counter to it.
human.socket.on('gamestate', () => { if (phase === 'after') statesAfter++; });

const deadline = Date.now() + timeoutSec * 1000;
while (!gameEnded && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
}
const failures = [];
if (statesAfter < 5) failures.push(`only ${statesAfter} gamestates after reconnect — seat did not resume`);
if (!gameEnded) failures.push('game never ended after reconnect');
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1000));
if (failures.length) { console.error('TEST FAIL:', failures.join('; ')); process.exit(1); }
console.log(`TEST PASS — resumed after a 10s disconnect (${statesAfter} states post-reconnect) and finished`);
process.exit(0);
