// Probe: create a private Eternal lobby as an anonymous host, join it with a
// second anonymous user (the future bot seat), ready up, start the game, and
// record the real lobbystate / gamestate traffic to captures/ for study.
// Usage: node probe.mjs [seconds-to-observe]
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SERVER = 'http://localhost:9500';
const observeMs = (parseInt(process.argv[2] ?? '45', 10)) * 1000;

const host = { id: randomUUID(), username: 'ProbeHost' };
const bot = { id: randomUUID(), username: 'ProbeBot' };

mkdirSync(new URL('./captures/', import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const capturePath = new URL(`./captures/probe-${stamp}.jsonl`, import.meta.url);
const lines = [];
function record(side, event, data) {
    const line = JSON.stringify({ t: new Date().toISOString(), side, event, data });
    lines.push(line);
    console.log(`[${side}] ${event}: ${JSON.stringify(data)?.slice(0, 300)}`);
}
function flush() {
    writeFileSync(capturePath, lines.join('\n') + '\n');
}

const deck = JSON.parse(readFileSync(new URL('../../goals/star-wars-unlimited-decks-and-collection/files/vader-deck-holoscan.json', import.meta.url), 'utf8'));

async function post(path, body) {
    const res = await fetch(`${SERVER}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
}

function connect(user, lobbyId) {
    return io(SERVER, {
        path: '/ws',
        query: {
            user: JSON.stringify({ id: user.id, username: user.username }),
            lobby: JSON.stringify({ lobbyId: lobbyId ?? null }),
            spectator: 'false',
        },
        transports: ['websocket'],
    });
}

function wire(socket, side) {
    for (const ev of ['lobbystate', 'gamestate', 'matchmakingFailed', 'queueHeartbeat', 'retransmitResponse']) {
        socket.on(ev, (data) => record(side, ev, data));
    }
    socket.on('connection_error', (err) => record(side, 'connection_error', String(err?.message ?? err)));
    socket.on('connect', () => record(side, 'connect', { socketId: socket.id }));
    socket.on('disconnect', (reason) => record(side, 'disconnect', reason));
}

// 1. Host creates the lobby
const create = await post('/api/create-lobby', {
    user: host,
    deck,
    isPrivate: true,
    format: 'eternal',
    lobbyName: 'Probe Game',
    cardPool: 'current',
    gamesToWinMode: 'bestOfOne',
});
record('http', 'create-lobby', create);
if (create.status !== 200) { flush(); process.exit(1); }

// 2. Host connects (lobbyId null; server maps user -> lobby)
const hostSocket = connect(host, null);
wire(hostSocket, 'host');

// Give the host socket a moment to receive lobbystate, then find the lobby id
await new Promise((r) => setTimeout(r, 3000));
const hostLobbyLine = lines.map((l) => JSON.parse(l)).find((l) => l.side === 'host' && l.event === 'lobbystate');
const lobbyId = hostLobbyLine?.data?.id ?? hostLobbyLine?.data?.lobbyId ?? hostLobbyLine?.data?.lobby?.id;
record('probe', 'discovered-lobbyId', lobbyId ?? null);
if (!lobbyId) { flush(); console.log('No lobby id discovered; see capture file.'); process.exit(1); }

// 3. Bot joins and submits its deck (the lobby start refuses a deckless player)
const join = await post('/api/join-lobby', { lobbyId, user: bot });
record('http', 'join-lobby', join);
const botSocket = connect(bot, lobbyId);
wire(botSocket, 'bot');
await new Promise((r) => setTimeout(r, 2000));
// The bot only exists in the lobby's user list once its socket has connected,
// so the deck submission has to come after the connect.
const botDeck = JSON.parse(readFileSync(new URL('../../goals/star-wars-unlimited-decks-and-collection/files/jabba-deck-holoscan.json', import.meta.url), 'utf8'));
const change = await post(`/api/lobby/${lobbyId}/change-deck`, { user: bot, deck: botDeck });
record('http', 'change-deck', change);

// 4. Ready up and start
botSocket.emit('lobby', 'setReadyStatus', true);
hostSocket.emit('lobby', 'setReadyStatus', true);
await new Promise((r) => setTimeout(r, 1000));
hostSocket.emit('lobby', 'startGameAsync');
record('probe', 'startGameAsync-sent', {});

// 5. Observe gamestate traffic
await new Promise((r) => setTimeout(r, observeMs));
flush();
console.log(`Capture written: ${capturePath.pathname} (${lines.length} events)`);
hostSocket.close();
botSocket.close();
process.exit(0);
