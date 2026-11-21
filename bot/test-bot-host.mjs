// End-to-end test of the Stage 7 flow (bot-host + join-bot), against the
// LAUNCHER-MANAGED stack (there must be exactly one bot-host running —
// the launcher's; this test observes it through bot-host-launcher.log):
//   1. a scripted "human" HOST does exactly what Tyler does in the client:
//      create a PUBLIC lobby named "BOT 3" with a pasted-JSON deck
//      (POST /api/create-lobby), connect the socket, wait for the bot to
//      appear in the lobby ready, then start the game from the host seat,
//   2. both seats auto-play (Stage 2 heuristics) to a winner,
//   3. the human disconnects; the join-bot must exit (code 0 in the log),
//   4. SECOND game in a FRESH lobby named "BOT" (default deck) — proves
//      the helper keeps working across games.
// Usage: node test-bot-host.mjs [timeoutSecPerGame]   (launcher stack up)
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Seat, post } from './bot.mjs';

const BOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const APP_DIR = path.resolve(BOT_DIR, '..');
const HOST_LOG = path.join(APP_DIR, 'bot-host-launcher.log');
const timeoutSec = parseInt(process.argv[2] ?? '600', 10);
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Track the log by full-text length (code units), NOT byte offsets — the
// log contains multi-byte characters (…, —), so byte size and string
// length drift apart and a byte-based slice silently reads nothing.
let seenText = readFileSync(HOST_LOG, 'utf8');
function newLog() {
    const text = readFileSync(HOST_LOG, 'utf8');
    if (text.length <= seenText.length) { seenText = text; return ''; }
    const out = text.slice(seenText.length);
    seenText = text;
    return out;
}
let logWindow = '';
async function waitForLog(substr, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        logWindow += newLog();
        if (logWindow.includes(substr)) return true;
        await sleep(1500);
    }
    console.log(`(timed out waiting for "${substr}" in bot-host log)`);
    return false;
}

async function playOneGame({ lobbyName, humanDeckFile, expectDeckId, label }) {
    logWindow = '';
    const deck = JSON.parse(readFileSync(humanDeckFile, 'utf8'));
    const human = new Seat(`Host-${label}`, deck);
    human.user = { id: randomUUID(), username: `Host-${label}` };
    human.stayAliveOnGameEnd = true;
    let gameEnded = null;
    human.onGameEnd = (info) => { gameEnded = info; };

    const create = await post('/api/create-lobby', {
        user: human.user, deck, isPrivate: false, format: 'eternal',
        cardPool: 'current', gamesToWinMode: 'bestOfOne', lobbyName,
    });
    if (create.status !== 200) { failures.push(`${label}: create-lobby ${create.status}`); return; }
    human.connect(null);
    let latest = null;
    human.socket.on('lobbystate', (ls) => { latest = ls; });

    const deadline = Date.now() + 120000;
    let lobbyId = null;
    let botReady = false;
    while (Date.now() < deadline && !botReady) {
        if (latest?.id) lobbyId = latest.id;
        const users = latest?.users ?? [];
        const bot = users.find((u) => u.id !== human.user.id);
        if (users.length >= 2 && bot?.ready === true) botReady = true;
        if (!botReady) await sleep(1000);
    }
    if (!lobbyId) { failures.push(`${label}: host never learned its lobbyId`); human.socket.disconnect(); return; }
    if (!botReady) { failures.push(`${label}: bot never appeared ready in the lobby`); human.socket.disconnect(); return; }
    console.log(`${label}: bot is in lobby ${lobbyId.slice(0, 8)}… and ready — host starting the game`);
    if (!(await waitForLog(`spawning join-bot with ${expectDeckId}`, 15000, label))) {
        failures.push(`${label}: bot-host log shows no join-bot spawned with ${expectDeckId}`);
    }

    human.socket.emit('lobby', 'setReadyStatus', true);
    await sleep(500);
    human.socket.emit('lobby', 'startGameAsync');

    const gameDeadline = Date.now() + timeoutSec * 1000;
    while (!gameEnded && Date.now() < gameDeadline) await sleep(1000);
    if (!gameEnded) { failures.push(`${label}: game never ended within ${timeoutSec}s`); human.socket.disconnect(); return; }
    console.log(`${label}: game ended — winners: ${JSON.stringify(gameEnded.winners)}`);

    human.socket.disconnect();
    const sawExitLine = await waitForLog(`join-bot for lobby ${lobbyId.slice(0, 8)}`, 150000, label)
        && logWindow.includes('exited (code 0)');
    if (!sawExitLine) failures.push(`${label}: join-bot did not exit (code 0) after the host left`);
    else console.log(`${label}: join-bot exited cleanly`);
}

const myDir = path.join(APP_DIR, 'decks', 'my');
await playOneGame({
    lobbyName: 'BOT 3',
    humanDeckFile: path.join(myDir, 'vader-deck-holoscan.json'),
    expectDeckId: 'community:3',
    label: 'game1',
});
await playOneGame({
    lobbyName: 'BOT',
    humanDeckFile: path.join(myDir, 'jabba-deck-holoscan.json'),
    expectDeckId: 'community:0',
    label: 'game2',
});

if (failures.length) { console.error('TEST FAIL:', failures.join('; ')); process.exit(1); }
console.log('TEST PASS (bot-host: two lobbies, two full games, join-bot exits cleanly)');
process.exit(0);
