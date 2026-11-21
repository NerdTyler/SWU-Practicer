// Bot host (Stage 7 + 7.1) — the always-on half of the offline practice app.
//
//   node bot-host.mjs [--poll-ms 2000] [--default-deck community:0]
//                     [--server-log <path>]
//
// Two ways in, one helper:
//  1. LOBBY path (Stage 7): polls the game server's public-lobby list
//     (GET /api/available-lobbies). When a lobby appears whose name starts
//     with "BOT", it spawns a join-bot (bot/join-bot.mjs) to take the open
//     seat: the bot sets its deck, readies up, and the lobby's host starts
//     the game from their own lobby screen.
//  2. QUEUE path (Stage 7.1): tails the game server's log file (the
//     launcher redirects server stdout to server-launcher.log). The
//     server exposes no queue API, but QueueHandler logs every queue
//     join (with the exact format key + preference), every removal, and
//     every match. When a human starts searching in Quick Game, it spawns
//     a queue-bot (bot/queue-bot.mjs) into the SAME queue with a random
//     community deck; when the human leaves before a match forms, it
//     orders the bot to withdraw. The bot never queues on its own.
// One instance handles any number of games — each game is a fresh lobby
// or queue entry and a fresh bot process.
//
// Deck choice from the lobby name:
//   "BOT"          -> the default deck (community:0 unless overridden)
//   "BOT 3"        -> community deck #3
//   "BOT krennic"  -> first deck whose name/slug contains the word
//                     (Tyler's own decks are searched first)
//   "BOT my:vader-coaxium-mine" / "BOT community:7" -> exact library id
// Anything unrecognized falls back to the default deck and is logged.
//
// Logs plainly (stdout; the launcher redirects to bot-host-launcher.log).
// Started and stopped by SWU-Practice.command; safe to run standalone.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDeck, listDecks, deckName } from '../decks/library.mjs';

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(BOT_DIR, '..');
const SERVER = process.env.SWU_SERVER_URL ?? 'http://localhost:9500';
const argv = process.argv.slice(2);
const flagVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const POLL_MS = parseInt(flagVal('--poll-ms') ?? process.env.SWU_BOT_POLL_MS ?? '2000', 10);
const DEFAULT_DECK_ID = flagVal('--default-deck') ?? process.env.SWU_BOT_DEFAULT_DECK ?? 'community:0';
const MAX_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 20000;
// Queue path (Stage 7.1): the server's own log is the only place queue
// state is observable. The launcher starts the server with stdout
// redirected to this file (start_bg in SWU-Practice.command).
const SERVER_LOG = flagVal('--server-log') ?? process.env.SWU_SERVER_LOG ?? path.join(APP_DIR, 'server-launcher.log');
const QUEUE_MAX_ATTEMPTS = 3;
// Bot-deck picker (Stage 7.1 extension): the patched Karabast forms show
// a "Bot deck" dropdown that talks to a tiny HTTP endpoint served by
// this process (below). The choice persists in a JSON file next to the
// other app state. deckChoice is:
//   null     — never picked: queue bots play a random community deck;
//              a bare "BOT" lobby keeps the Stage 7 default deck.
//   'random' — random community deck on both paths, every game.
//   <id>     — that library deck on both paths (a BOT-lobby name suffix
//              still overrides it for that one lobby).
const HTTP_PORT = parseInt(flagVal('--http-port') ?? process.env.SWU_BOT_HTTP_PORT ?? '9778', 10);
const CHOICE_PATH = path.join(APP_DIR, 'bot-deck-choice.json');
let deckChoice = (() => {
    try {
        const j = JSON.parse(readFileSync(CHOICE_PATH, 'utf8'));
        if (j && (j.deckId === 'random' || (typeof j.deckId === 'string' && getDeck(j.deckId)))) return j.deckId;
    } catch { /* no choice file yet */ }
    return null;
})();
function saveDeckChoice(id) {
    deckChoice = id;
    try {
        writeFileSync(CHOICE_PATH, JSON.stringify({ deckId: id }, null, 2) + '\n');
    } catch (e) {
        log(`picker: could not persist the bot deck choice (${e.message}) — it will last for this run only`);
    }
}
const chosenDeckId = () => (deckChoice && deckChoice !== 'random' ? deckChoice : null);

function log(msg) {
    console.log(`[bot-host ${new Date().toISOString()}] ${msg}`);
}

function resolveDeckKey(restRaw) {
    const rest = (restRaw ?? '').trim();
    if (!rest) {
        // No name suffix: the bot-deck picker choice rules (Stage 7.1).
        if (chosenDeckId()) return { id: deckChoice, why: 'bot deck picker choice' };
        if (deckChoice === 'random') return { id: randomCommunityDeckId(), why: 'bot deck picker: random community deck' };
        return { id: DEFAULT_DECK_ID, why: 'default deck' };
    }
    if (/^\d+$/.test(rest)) {
        const id = `community:${parseInt(rest, 10)}`;
        if (getDeck(id)) return { id, why: `community index ${rest}` };
        return { id: DEFAULT_DECK_ID, why: `no community deck #${rest} — default instead` };
    }
    if (getDeck(rest)) return { id: rest, why: 'exact library id' };
    const token = rest.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (token) {
        const { mine, community } = listDecks();
        const my = mine.find((d) => d.id.slice(3) === token || d.id.slice(3).startsWith(token) || d.name.toLowerCase().includes(token));
        if (my) return { id: my.id, why: `your deck matching "${token}"` };
        const comm = community.find((d) => d.name.toLowerCase().includes(token));
        if (comm) return { id: comm.id, why: `community deck matching "${token}"` };
    }
    return { id: DEFAULT_DECK_ID, why: `could not match "${rest}" — default instead` };
}

const active = new Map(); // lobbyId -> child process
const attempts = new Map(); // lobbyId -> spawn count
const cooldownUntil = new Map(); // lobbyId -> timestamp
let shuttingDown = false;

function spawnJoinBot(lobby) {
    const m = /^\s*BOT\b[-\s]*(.*)$/i.exec(lobby.name ?? '');
    const { id: deckId, why } = resolveDeckKey(m ? m[1] : '');
    const n = (attempts.get(lobby.id) ?? 0) + 1;
    attempts.set(lobby.id, n);
    log(`lobby "${lobby.name}" (${lobby.id.slice(0, 8)}…) wants a bot — spawning join-bot with ${deckId} (${deckName(deckId)}) [${why}, attempt ${n}]`);
    const child = spawn(process.execPath, [
        path.join(BOT_DIR, 'join-bot.mjs'),
        '--lobby', lobby.id,
        '--deck-id', deckId,
    ], { cwd: BOT_DIR, stdio: 'inherit' });
    active.set(lobby.id, child);
    child.on('exit', (code, signal) => {
        active.delete(lobby.id);
        cooldownUntil.set(lobby.id, Date.now() + RETRY_COOLDOWN_MS);
        log(`join-bot for lobby ${lobby.id.slice(0, 8)}… exited (code ${code}${signal ? `, signal ${signal}` : ''}); ${active.size} bot(s) still active`);
    });
    child.on('error', (e) => {
        active.delete(lobby.id);
        cooldownUntil.set(lobby.id, Date.now() + RETRY_COOLDOWN_MS);
        log(`join-bot for lobby ${lobby.id.slice(0, 8)}… failed to start: ${e.message}`);
    });
}

// ============================================================ queue path
// Stage 7.1 — Quick Game (matchmaking queue) watcher.
//
// State per human: queueHumans userId -> { key, preference, attempts }.
// State per bot:   queueBots botUserId -> { child, forHuman, key, state }
// where state is 'waiting' (spawned, not yet matched) or 'matched'.
// The watcher is driven entirely by server log lines:
//   QueueHandler: User <id> connected ... added to queue for format
//     (f / cp / g) | {"event":"queueJoin","userId":...,"format":...,
//     "cardPool":...,"gamesToWinMode":...,"preference":...}
//   QueueHandler: Removing player <id> from queue ... Reason: ...
//   GameServer: Matched players <id1> and <id2> in lobby <lobbyId>.
const queueHumans = new Map();
const queueBots = new Map();

const shortId = (id) => `${String(id).slice(0, 8)}…`;
const keyToString = (k) => `(${k.format} / ${k.cardPool} / ${k.gamesToWinMode})`;
const sameKey = (a, b) => a.format === b.format && a.cardPool === b.cardPool && a.gamesToWinMode === b.gamesToWinMode;

function randomCommunityDeckId() {
    const { community } = listDecks();
    if (!community.length) return DEFAULT_DECK_ID;
    return community[Math.floor(Math.random() * community.length)].id;
}

function sendWithdraw(bot, why) {
    try {
        bot.child.stdin.write('withdraw\n');
        log(`queue: withdrawing queue-bot for human ${shortId(bot.forHuman)} (${why})`);
    } catch (e) {
        log(`queue: could not signal queue-bot for human ${shortId(bot.forHuman)} to withdraw (${e.message}) — killing it instead`);
        try { bot.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
}

function spawnQueueBot(humanId) {
    const human = queueHumans.get(humanId);
    if (!human) return;
    for (const bot of queueBots.values()) {
        if (bot.forHuman === humanId && bot.state === 'waiting') return; // already on it
    }
    if (human.attempts >= QUEUE_MAX_ATTEMPTS) {
        log(`queue: giving up on human ${shortId(humanId)} after ${human.attempts} queue-bot attempts`);
        return;
    }
    human.attempts += 1;
    const deckId = chosenDeckId() ?? randomCommunityDeckId();
    const botUserId = randomUUID();
    log(`queue: human ${shortId(humanId)} is waiting in ${keyToString(human.key)} — spawning queue-bot with ${deckId} (${deckName(deckId)}) [attempt ${human.attempts}]`);
    const child = spawn(process.execPath, [
        path.join(BOT_DIR, 'queue-bot.mjs'),
        '--user-id', botUserId,
        '--deck-id', deckId,
        '--format', human.key.format,
        '--card-pool', human.key.cardPool,
        '--games-to-win', human.key.gamesToWinMode,
        '--preference', human.preference ?? 'noPreference',
    ], { cwd: BOT_DIR, stdio: ['pipe', 'inherit', 'inherit'] });
    const bot = { child, forHuman: humanId, key: human.key, state: 'waiting' };
    queueBots.set(botUserId, bot);
    child.on('exit', (code, signal) => {
        queueBots.delete(botUserId);
        log(`queue: queue-bot for human ${shortId(humanId)} exited (code ${code}${signal ? `, signal ${signal}` : ''}); ${queueBots.size} queue-bot(s) still active`);
        // A bot that died before matching (enter-queue rejected, socket
        // failed, ...) while its human is still waiting gets ONE more
        // thing: a fresh bot with a different random deck, up to the cap.
        if (code !== 0 && bot.state === 'waiting' && queueHumans.has(humanId)) {
            spawnQueueBot(humanId);
        }
    });
    child.on('error', (e) => {
        queueBots.delete(botUserId);
        log(`queue: queue-bot for human ${shortId(humanId)} failed to start: ${e.message}`);
        if (queueHumans.has(humanId)) spawnQueueBot(humanId);
    });
}

function onQueueJoin(userId, key, preference) {
    if (queueBots.has(userId)) {
        // One of ours. A join from a bot that was already matched means
        // the server auto-requeued it after its opponent disconnected
        // during the pre-game countdown — its human is gone, so pull it
        // out of the queue instead of letting it ambush a later search.
        const bot = queueBots.get(userId);
        if (bot.state === 'matched') {
            log(`queue: queue-bot ${shortId(userId)} was auto-requeued (opponent left during countdown) — withdrawing it`);
            bot.state = 'waiting';
            sendWithdraw(bot, 'auto-requeued after opponent left');
        }
        return;
    }
    const existing = queueHumans.get(userId);
    if (existing && sameKey(existing.key, key)) {
        existing.preference = preference ?? existing.preference;
        return; // reconnect of a search we already cover
    }
    if (existing) {
        // Re-queued under different settings: retire the old bot, cover
        // the new search instead.
        for (const bot of queueBots.values()) {
            if (bot.forHuman === userId && bot.state === 'waiting') sendWithdraw(bot, 'human re-queued with different settings');
        }
    }
    queueHumans.set(userId, { key, preference: preference ?? 'noPreference', attempts: existing?.attempts ?? 0 });
    spawnQueueBot(userId);
}

function onQueueRemove(userId) {
    if (queueBots.has(userId)) return; // our own bot leaving is expected
    if (!queueHumans.has(userId)) return;
    queueHumans.delete(userId);
    for (const bot of queueBots.values()) {
        if (bot.forHuman === userId && bot.state === 'waiting') {
            sendWithdraw(bot, 'human left the queue');
        }
    }
}

function onMatched(idA, idB, lobbyId) {
    const botId = queueBots.has(idA) ? idA : (queueBots.has(idB) ? idB : null);
    const humanId = botId ? (botId === idA ? idB : idA) : null;
    if (botId) {
        const bot = queueBots.get(botId);
        bot.state = 'matched';
        queueHumans.delete(humanId);
        log(`queue: queue-bot matched with human ${shortId(humanId)} — game forming in lobby ${shortId(lobbyId)}`);
        return;
    }
    // Two humans found each other: any bot still waiting for either of
    // them would now be sitting in the queue alone — withdraw it.
    for (const id of [idA, idB]) {
        if (!queueHumans.has(id)) continue;
        queueHumans.delete(id);
        for (const bot of queueBots.values()) {
            if (bot.forHuman === id && bot.state === 'waiting') {
                sendWithdraw(bot, 'human matched another human');
            }
        }
    }
}

// ---- server log tail ----------------------------------------------------
let logOffset = null; // bytes; null until first sight of the file
let logPartial = '';
const logDecoder = new StringDecoder('utf8');

function handleServerLogLine(line) {
    if (!line.includes('QueueHandler') && !line.includes('Matched players')) return;
    // Queue join: prefer the structured meta JSON after ' | '.
    let m = /QueueHandler: User (\S+) connected with socket id/.exec(line);
    if (m) {
        let meta = null;
        const metaStart = line.lastIndexOf(' | {');
        if (metaStart >= 0) { try { meta = JSON.parse(line.slice(metaStart + 3)); } catch { /* fall back to regex */ } }
        if (meta?.event === 'queueJoin' && meta.userId && meta.format && meta.cardPool && meta.gamesToWinMode) {
            onQueueJoin(meta.userId, { format: meta.format, cardPool: meta.cardPool, gamesToWinMode: meta.gamesToWinMode }, meta.preference);
            return;
        }
        const km = /added to queue for format \((\S+) \/ (\S+) \/ (\S+)\)/.exec(line);
        if (km) onQueueJoin(m[1], { format: km[1], cardPool: km[2], gamesToWinMode: km[3] }, 'noPreference');
        return;
    }
    m = /QueueHandler: Removing player (\S+) from queue.* Reason: (.+)$/.exec(line);
    if (m) {
        // connectPlayer logs a "removal" from the waiting list as pure
        // bookkeeping when a queued player connects/reconnects their
        // socket ("Player connected with socket id …"), and addPlayer
        // does the same on a re-queue ("Rejoining into queue") — both are
        // immediately followed by a fresh queueJoin line for the same
        // user. Only OTHER reasons are genuine leaves.
        const reason = m[2];
        if (reason.startsWith('Player connected') || reason === 'Rejoining into queue') return;
        onQueueRemove(m[1]);
        return;
    }
    m = /GameServer: Matched players (\S+) and (\S+) in lobby (\S+)\./.exec(line);
    if (m) { onMatched(m[1], m[2], m[3]); }
}

function tailServerLog() {
    let size;
    try { size = statSync(SERVER_LOG).size; } catch { return; } // not there yet
    if (logOffset === null) { logOffset = size; return; } // skip history
    if (size < logOffset) { logOffset = 0; logPartial = ''; } // truncated/rotated
    if (size === logOffset) return;
    let fd;
    try {
        fd = openSync(SERVER_LOG, 'r');
        const buf = Buffer.alloc(size - logOffset);
        const bytesRead = readSync(fd, buf, 0, buf.length, logOffset);
        logOffset += bytesRead;
        logPartial += logDecoder.write(buf.subarray(0, bytesRead));
    } catch (e) {
        log(`queue: cannot read the server log (${e.message}) — queue watching paused`);
        return;
    } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    }
    let idx;
    while ((idx = logPartial.indexOf('\n')) >= 0) {
        const line = logPartial.slice(0, idx);
        logPartial = logPartial.slice(idx + 1);
        try { handleServerLogLine(line); } catch (e) { log(`queue: error handling a server log line: ${e.message}`); }
    }
}

let lastFetchErrorAt = 0;
async function pollOnce() {
    try { tailServerLog(); } catch (e) { log(`queue: log tail failed: ${e.message}`); }
    let lobbies;
    try {
        const res = await fetch(`${SERVER}/api/available-lobbies`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        lobbies = await res.json();
    } catch (e) {
        if (Date.now() - lastFetchErrorAt > 60000) {
            lastFetchErrorAt = Date.now();
            log(`cannot reach the game server at ${SERVER} (${e.message}) — will keep polling`);
        }
        return;
    }
    if (!Array.isArray(lobbies)) return;
    for (const lobby of lobbies) {
        if (!lobby?.id || !/^\s*BOT\b/i.test(lobby.name ?? '')) continue;
        if (active.has(lobby.id)) continue;
        if ((attempts.get(lobby.id) ?? 0) >= MAX_ATTEMPTS) continue;
        if ((cooldownUntil.get(lobby.id) ?? 0) > Date.now()) continue;
        spawnJoinBot(lobby);
    }
}

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`got ${signal} — stopping ${active.size} join-bot(s) and ${queueBots.size} queue-bot(s) and exiting`);
    for (const child of active.values()) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    for (const bot of queueBots.values()) { try { bot.child.kill('SIGTERM'); } catch { /* already gone */ } }
    setTimeout(() => process.exit(0), 500).unref();
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log(`polling ${SERVER}/api/available-lobbies every ${POLL_MS}ms for lobbies named "BOT…"; default deck ${DEFAULT_DECK_ID}`);
log(`watching ${SERVER_LOG} for matchmaking queue joins (Stage 7.1 queue path)`);

// ---- bot-deck picker endpoint -------------------------------------------
// Served for the patched Karabast forms (BotDeckPicker.tsx). Localhost
// only; permissive CORS because the page origin is localhost:3000 and
// this is a single-machine helper — nothing here is sensitive (the worst
// an attacker page could do is change which deck the practice bot plays).
const pickerServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const sendJson = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/bot-deck') {
        sendJson(200, {
            deckId: deckChoice,
            deckName: deckChoice === 'random' ? 'Random community deck'
                : deckChoice ? deckName(deckChoice) : null,
        });
        return;
    }
    if (req.method === 'GET' && url.pathname === '/bot-deck-options') {
        const { mine, community } = listDecks();
        sendJson(200, {
            current: deckChoice,
            options: [
                { id: 'random', name: 'Random community deck' },
                ...mine.map((d) => ({ id: d.id, name: d.name })),
                ...community.map((d) => ({ id: d.id, name: d.name })),
            ],
        });
        return;
    }
    if (req.method === 'POST' && url.pathname === '/bot-deck') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
        req.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch { sendJson(400, { ok: false, error: 'body is not JSON' }); return; }
            const id = parsed?.deckId;
            if (id === null) {
                saveDeckChoice(null);
                log('picker: bot deck choice cleared (back to defaults)');
                sendJson(200, { ok: true, deckId: null });
                return;
            }
            if (id !== 'random' && (typeof id !== 'string' || !getDeck(id))) {
                sendJson(400, { ok: false, error: `unknown deck id: ${id}` });
                return;
            }
            saveDeckChoice(id);
            log(`picker: bot deck choice set to ${id}${id === 'random' ? '' : ` (${deckName(id)})`}`);
            sendJson(200, { ok: true, deckId: id });
        });
        return;
    }
    sendJson(404, { ok: false, error: 'not found' });
});
pickerServer.on('error', (e) => {
    log(`picker: endpoint on port ${HTTP_PORT} unavailable (${e.message}) — the in-page picker will not work, everything else continues`);
});
pickerServer.listen(HTTP_PORT, '127.0.0.1', () => {
    log(`picker: bot deck endpoint listening on http://127.0.0.1:${HTTP_PORT} (current choice: ${deckChoice ?? 'unset — defaults'})`);
});
await pollOnce();
setInterval(() => { if (!shuttingDown) pollOnce().catch(() => { /* logged inside */ }); }, POLL_MS);
