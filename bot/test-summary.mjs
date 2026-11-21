// Integration test for Stage 6 play-by-play: drive a full bot-vs-bot game
// with the production Seat class; when it ends, build the summary from the
// host seat's accumulated engine message log and verify its contents.
// Usage: node test-summary.mjs [timeoutSec]
import { writeFileSync, mkdirSync } from 'node:fs';
import { Seat, post } from './bot.mjs';
import { buildSummary } from './gamelog.mjs';

const timeoutSec = parseInt(process.argv[2] ?? '600', 10);
const startedAt = Date.now();

import { readFileSync } from 'node:fs';
const deckVader = JSON.parse(readFileSync(new URL('../decks/my/vader-deck-holoscan.json', import.meta.url), 'utf8'));
const deckJabba = JSON.parse(readFileSync(new URL('../decks/my/jabba-deck-holoscan.json', import.meta.url), 'utf8'));

const host = new Seat('SummaryHost', deckVader);
const guest = new Seat('SummaryGuest', deckJabba);
host.stayAliveOnGameEnd = true;
guest.stayAliveOnGameEnd = true;

let lastGs = null;
let lobbyId = null;
const origConnect = host.connect.bind(host);
host.connect = (id) => {
    origConnect(id);
    host.socket.on('gamestate', (gs) => { lastGs = gs; });
    host.socket.on('lobbystate', (ls) => { if (ls?.id) lobbyId = ls.id; });
};

function seatInfo(gs, username) {
    for (const p of Object.values(gs?.players ?? {})) {
        if (p?.user?.username === username) {
            return { name: p.user.username, leader: p.leaders?.[0]?.name ?? null, base: p.base?.name ?? null };
        }
    }
    return { name: username, leader: null, base: null };
}

const done = new Promise((resolve) => {
    host.onGameEnd = (info) => resolve(info);
});

const create = await post('/api/create-lobby', {
    user: host.user, deck: host.deck, isPrivate: true, format: 'eternal',
    lobbyName: 'Summary Test', cardPool: 'current', gamesToWinMode: 'bestOfOne',
});
if (create.status !== 200) { console.error('TEST FAIL: create-lobby', create); process.exit(1); }
host.connect(null);
for (let i = 0; i < 30 && !lobbyId; i++) await new Promise((r) => setTimeout(r, 500));
if (!lobbyId) { console.error('TEST FAIL: could not discover lobbyId'); process.exit(1); }
console.log('lobbyId', lobbyId);

const join = await post('/api/join-lobby', { lobbyId, user: guest.user });
if (join.status !== 200) { console.error('TEST FAIL: join-lobby', join); process.exit(1); }
guest.connect(lobbyId);
await new Promise((r) => setTimeout(r, 2000));
const change = await post(`/api/lobby/${lobbyId}/change-deck`, { user: guest.user, deck: guest.deck });
if (change.status !== 200) { console.error('TEST FAIL: change-deck', change); process.exit(1); }
guest.socket.emit('lobby', 'setReadyStatus', true);
host.socket.emit('lobby', 'setReadyStatus', true);
await new Promise((r) => setTimeout(r, 1000));
host.socket.emit('lobby', 'startGameAsync');
console.log('Game started, waiting for completion...');

const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutSec * 1000));
const info = await Promise.race([done, timeout]).catch((e) => { console.error('TEST FAIL:', e.message); process.exit(1); });

const lines = host.messageLog.lines();
console.log(`Message log: ${lines.length} lines. First 15:`);
for (const l of lines.slice(0, 15)) console.log('  |', l);
const winnerName = info.winners[0];
const summary = buildSummary({
    mode: 'bo1',
    gameNumber: 1,
    seats: [
        { label: 'Bot (host)', ...seatInfo(lastGs, host.lobbyUsername), deck: 'Vader — Coaxium Mine' },
        { label: 'Bot (guest)', ...seatInfo(lastGs, guest.lobbyUsername), deck: 'Jabba — Daimyo\'s Palace' },
    ],
    winnerName,
    startedAt,
    endedAt: Date.now(),
    lines,
});
mkdirSync(new URL('./test-summaries/', import.meta.url), { recursive: true });
const outPath = new URL('./test-summaries/summary-test.txt', import.meta.url).pathname;
writeFileSync(outPath, summary);
console.log(`Summary written to ${outPath} (${summary.length} chars)`);

const failures = [];
if (lines.length < 30) failures.push(`too few message lines: ${lines.length}`);
if (!summary.includes('PLAY-BY-PLAY')) failures.push('summary missing play-by-play header');
if (!summary.includes(winnerName)) failures.push('summary missing winner');
if (!/wins/.test(summary)) failures.push('summary missing result line');
if (failures.length) { console.error('TEST FAIL:', failures.join('; ')); process.exit(1); }
console.log('TEST PASS');
process.exit(0);
