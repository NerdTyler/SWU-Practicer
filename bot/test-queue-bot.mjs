// End-to-end test of the Stage 7.1 queue flow (bot-host queue watcher +
// queue-bot), against the LAUNCHER-MANAGED stack (exactly one bot-host —
// the launcher's; this test observes it through bot-host-launcher.log
// and cross-checks the game server's own log):
//
//   (a) a scripted human does exactly what Tyler does in Quick Game:
//       POST /api/enter-queue with a pasted-JSON deck, then connect the
//       socket with no lobby. The bot-host must notice the queue join in
//       the server log, spawn a queue-bot into the same queue, the two
//       must be matched, the game must auto-start and play to a winner,
//       and the queue-bot must exit (code 0) afterwards.
//   (b) a second human queues and leaves the moment bot-host spawns
//       their bot (the client's 'manualDisconnect' — its Leave Queue
//       button), i.e. before the bot can connect and a match can form.
//       bot-host must order the bot to withdraw; the bot must exit
//       (code 0) with zero queue-bots left. A probe human then proves
//       no stale bot is sitting in the queue (it is NOT matched before
//       bot-host spawns a fresh bot for it) and that the watcher still
//       works (the probe's own bot is withdrawn after it leaves).
//   (c) a third human queues after all that and plays a full game —
//       the watcher keeps working across games.
//
// Usage: node test-queue-bot.mjs [timeoutSecPerGame]  (launcher stack up)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Seat, post } from './bot.mjs';

const BOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const APP_DIR = path.resolve(BOT_DIR, '..');
const HOST_LOG = path.join(APP_DIR, 'bot-host-launcher.log');
const SERVER_LOG = path.join(APP_DIR, 'server-launcher.log');
const timeoutSec = parseInt(process.argv[2] ?? '600', 10);
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortId = (id) => `${id.slice(0, 8)}…`;

// Track logs by full-text length (code units), NOT byte offsets — the
// logs contain multi-byte characters (…, —); see test-bot-host.mjs.
function makeLogTracker(file) {
    let seen = readFileSync(file, 'utf8');
    let window = '';
    return {
        pump() {
            const text = readFileSync(file, 'utf8');
            if (text.length > seen.length) { window += text.slice(seen.length); seen = text; }
            else if (text.length < seen.length) { seen = text; } // rotated
        },
        async waitFor(substr, timeoutMs, label, pollMs = 1200) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                this.pump();
                if (window.includes(substr)) return true;
                await sleep(pollMs);
            }
            console.log(`(${label}: timed out waiting for "${substr}")`);
            return false;
        },
        reset() { window = ''; },
        get window() { return window; },
    };
}
const hostLog = makeLogTracker(HOST_LOG);
const serverLog = makeLogTracker(SERVER_LOG);

// Real queue-bot processes only: their command line is
// "node …/bot/queue-bot.mjs --user-id …". (A bare "queue-bot.mjs" pattern
// also matches this test's own file name — that was run 1's phantom.)
function queueBotProcesses() {
    try {
        const out = execFileSync('pgrep', ['-f', 'queue-bot\\.mjs --user-id'], { encoding: 'utf8' }).trim();
        return out ? out.split('\n').length : 0;
    } catch { return 0; } // pgrep exits 1 when nothing matches
}

// A scripted human performing the client's exact queue sequence:
// QuickGameForm's POST, then Game.context's lobby-less socket connect.
async function queueHuman(label, deckFile) {
    const deck = JSON.parse(readFileSync(deckFile, 'utf8'));
    const human = new Seat(label, deck);
    human.user = { id: randomUUID(), username: label };
    human.stayAliveOnGameEnd = true;
    const res = await post('/api/enter-queue', {
        user: human.user,
        deck,
        format: 'eternal',
        cardPool: 'current',
        gamesToWinMode: 'bestOfOne',
        matchmakingCompetitivenessPreference: 'noPreference',
    });
    if (res.status !== 200) {
        failures.push(`${label}: enter-queue returned ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`);
        return null;
    }
    human.connect(null);
    return human;
}

async function playQueuedGame({ label, deckFile }) {
    hostLog.reset(); serverLog.reset();
    const human = await queueHuman(label, deckFile);
    if (!human) return;
    let gameEnded = null;
    human.onGameEnd = (info) => { gameEnded = info; };
    let matchedLobby = null;
    human.socket.on('lobbystate', (ls) => { if (!matchedLobby) matchedLobby = ls; });

    if (!(await hostLog.waitFor(`spawning queue-bot`, 60000, label))) {
        failures.push(`${label}: bot-host never spawned a queue-bot`);
        human.socket.disconnect();
        return;
    }
    console.log(`${label}: queue-bot spawned for human ${shortId(human.user.id)}`);

    const matchDeadline = Date.now() + 90000;
    while (!matchedLobby && Date.now() < matchDeadline) await sleep(1000);
    if (!matchedLobby) {
        failures.push(`${label}: human was never matched (no lobbystate within 90s)`);
        human.socket.disconnect();
        return;
    }
    console.log(`${label}: matched — lobby ${matchedLobby.id.slice(0, 8)}…`);

    if (!(await serverLog.waitFor(`Matched players`, 15000, label))
        || !serverLog.window.includes(human.user.id)) {
        failures.push(`${label}: server log shows no "Matched players" line naming the human`);
    }
    if (!(await hostLog.waitFor(`queue-bot matched with human ${shortId(human.user.id)}`, 15000, label))) {
        failures.push(`${label}: bot-host never logged the match`);
    }

    const gameDeadline = Date.now() + timeoutSec * 1000;
    while (!gameEnded && Date.now() < gameDeadline) await sleep(1000);
    if (!gameEnded) {
        failures.push(`${label}: game never ended within ${timeoutSec}s`);
        human.socket.disconnect();
        return;
    }
    console.log(`${label}: game ended — winners: ${JSON.stringify(gameEnded.winners)}`);

    if (!(await hostLog.waitFor(`queue-bot for human ${shortId(human.user.id)} exited (code 0)`, 90000, label))) {
        failures.push(`${label}: queue-bot did not exit (code 0) after the game`);
    } else {
        console.log(`${label}: queue-bot exited cleanly`);
    }
    await sleep(2000);
    const procs = queueBotProcesses();
    if (procs !== 0) failures.push(`${label}: ${procs} queue-bot process(es) still running after the game`);
    human.socket.disconnect();
}

const myDir = path.join(APP_DIR, 'decks', 'my');

// ---- (a) full queued game --------------------------------------------------
await playQueuedGame({ label: 'queue-game1', deckFile: path.join(myDir, 'vader-deck-holoscan.json') });

// ---- (b) cancel before a match forms + probe -------------------------------
{
    const label = 'cancel';
    hostLog.reset(); serverLog.reset();
    const human = await queueHuman(label, path.join(myDir, 'vader-deck-holoscan.json'));
    if (human) {
        let matched = null;
        human.socket.on('lobbystate', (ls) => { matched = ls; });
        // React to the spawn line FAST (100ms poll): bot-host writes it
        // before the child even starts, and the child still needs to
        // boot, POST enter-queue and connect before any match can form
        // (measured at ~400ms on this machine). Leaving now removes the
        // human from the queue before the bot arrives.
        const sawSpawn = await hostLog.waitFor('spawning queue-bot', 30000, label, 100);
        if (!sawSpawn) {
            failures.push(`${label}: bot-host never spawned a queue-bot`);
        } else {
            try { human.socket.emit('manualDisconnect'); } catch { /* ignore */ }
            await sleep(300);
            human.socket.disconnect();
            console.log(`${label}: human left the queue the moment their bot spawned (matched beforehand: ${!!matched})`);

            if (!(await hostLog.waitFor(`withdrawing queue-bot for human ${shortId(human.user.id)}`, 30000, label))) {
                failures.push(`${label}: bot-host never ordered the queue-bot to withdraw after the human left`);
            }
            if (!(await hostLog.waitFor(`queue-bot for human ${shortId(human.user.id)} exited (code 0)`, 60000, label))) {
                failures.push(`${label}: queue-bot did not exit (code 0) after the withdraw`);
            } else {
                console.log(`${label}: queue-bot withdrew and exited cleanly`);
            }
            if (matched) {
                failures.push(`${label}: a match formed before the cancel landed — the pre-match withdraw path was not exercised`);
            }
            await sleep(2000);
            if (queueBotProcesses() !== 0) failures.push(`${label}: queue-bot process still running after the withdraw`);
        }

        // Probe: a fresh human must NOT be matched before bot-host has
        // spawned a fresh bot for it — if a stale bot were still sitting
        // in the queue, the probe would match on connect, first.
        hostLog.reset();
        const probe = await queueHuman('probe', path.join(myDir, 'jabba-deck-holoscan.json'));
        if (probe) {
            let probeMatched = null;
            probe.socket.on('lobbystate', (ls) => { probeMatched = ls; });
            const probeDeadline = Date.now() + 30000;
            let probeSpawnSeen = false;
            while (Date.now() < probeDeadline && !probeSpawnSeen) {
                hostLog.pump();
                if (hostLog.window.includes('spawning queue-bot')) probeSpawnSeen = true;
                if (probeMatched && !probeSpawnSeen) break;
                if (!probeSpawnSeen) await sleep(100);
            }
            if (probeMatched && !probeSpawnSeen) {
                failures.push('probe: matched before any fresh spawn — a stale bot was sitting in the queue');
            } else if (!probeSpawnSeen) {
                failures.push('probe: bot-host never spawned a queue-bot for the probe — watcher unhealthy');
            } else {
                console.log('probe: no match before a fresh spawn — the queue held no stale bot');
            }
            // Leave again; the probe's bot must be cleaned up either by
            // the withdraw path (not yet matched) or the countdown path.
            try { probe.socket.emit('manualDisconnect'); } catch { /* ignore */ }
            await sleep(300);
            probe.socket.disconnect();
            if (!(await hostLog.waitFor(`queue-bot for human ${shortId(probe.user.id)} exited (code 0)`, 90000, 'probe'))) {
                failures.push('probe: its queue-bot never exited (code 0) after the probe left');
            } else {
                console.log('probe: its queue-bot was cleaned up after it left');
            }
            await sleep(2000);
            if (queueBotProcesses() !== 0) failures.push('probe: queue-bot process still running at the end of (b)');
        }
    }
}

// ---- (c) second full queued game -------------------------------------------
await playQueuedGame({ label: 'queue-game2', deckFile: path.join(myDir, 'jabba-deck-holoscan.json') });

if (failures.length) { console.error('TEST FAIL:', failures.join('; ')); process.exit(1); }
console.log('TEST PASS (queue-bot: two full queued games, cancel withdraws the bot, queue left empty)');
process.exit(0);
