// Bot v0 — generic prompt answerer + prompt harvester.
// Drives BOTH seats of a local game with safe generic rules so a full game
// flows, and records every prompt shape to captures/ for heuristic design.
// Usage: node bot.mjs [max-seconds] [--host-deck <file>] [--guest-deck <file>]
// As a module it exports { Seat, post } (Stage 4: bot/opponent.mjs reuses
// the Seat heuristics for the single-seat practice bot).
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MessageLog } from './gamelog.mjs';

const SERVER = 'http://localhost:9500';
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flagVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const maxMs = (parseInt(positional[0] ?? '300', 10)) * 1000;
const startedAt = Date.now();

mkdirSync(new URL('./captures/', import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const capturePath = new URL(`./captures/bot-${stamp}.jsonl`, import.meta.url);
const lines = [];
function record(side, event, data) {
    lines.push(JSON.stringify({ t: new Date().toISOString(), side, event, data }));
}
function flush() { writeFileSync(capturePath, lines.join('\n') + '\n'); }

// Stage 7 root-cause fix: the two goal-file reads below originally used
// hard paths into Gord's workspace layout (../../goals/...). In the
// shipped install (~/Downloads/swu-practice) there is no goals/ folder,
// so EVERY bot entry point crashed at import time on Tyler's Mac — the
// bot died before it could create or join anything ("link isn't
// generating / game isn't setting up"). Those decks are only the
// standalone bot-vs-bot defaults, so load them fail-soft; the card map
// gets the same treatment (heuristics fall back to printed costs).
function readJsonSoft(url) {
    try { return JSON.parse(readFileSync(url, 'utf8')); } catch { return null; }
}
const deckVader = readJsonSoft(new URL('../../goals/star-wars-unlimited-decks-and-collection/files/vader-deck-holoscan.json', import.meta.url));
const deckJabba = readJsonSoft(new URL('../../goals/star-wars-unlimited-decks-and-collection/files/jabba-deck-holoscan.json', import.meta.url));
const loadDeckArg = (flag, fallback) => {
    const p = flagVal(flag);
    if (!p) return fallback;
    return JSON.parse(readFileSync(p, 'utf8'));
};

// name -> cost from the engine's own card map (real costs for heuristic choices)
const cardMap = readJsonSoft(new URL('../../forceteki/test/json/_cardMap.json', import.meta.url)) ?? [];
const nameToCost = new Map();
for (const c of cardMap) {
    if (c.title && typeof c.cost === 'number' && !nameToCost.has(c.title)) nameToCost.set(c.title, c.cost);
}
const costOf = (card) => nameToCost.get(card?.name) ?? card?.cost ?? 0;

async function post(path, body) {
    const res = await fetch(`${SERVER}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
}

const BUTTON_PREFS = ['yourself', 'keep', 'done', 'pass', 'no', 'skip', 'decline', 'ok', 'yes', 'continue'];

class Seat {
    constructor(name, deck) {
        this.name = name;
        this.deck = deck;
        this.user = { id: randomUUID(), username: name };
        this.lobbyUsername = null; // server-assigned, learned from lobbystate
        this.socket = null;
        this.answeredPrompts = new Map(); // promptUuid -> answer signature
        this.lastStateAt = Date.now();
        this.promptsSeen = new Map(); // promptType -> count
        // Stage 6: engine message log + game lifecycle hooks.
        this.messageLog = new MessageLog();
        this.gameId = null;
        this.gameStartedAt = null;
        this.gameEndedForId = null;
        this.onGameStart = null; // (gs) => void, fired when a new game id appears
        this.onGameEnd = null; // ({winners, gameId, durationMs}) => void
        this.stayAliveOnGameEnd = false; // opponent mode: don't exit at game end
        this.hasActionablePrompt = false;
        this.currentPhase = null;
    }

    connect(lobbyId) {
        // A (re)connect voids our delivery bookkeeping: if a previous
        // answer was emitted but lost with the old socket, the server is
        // still waiting on that prompt, and the dedupe map would block
        // re-answering it forever (deadlock after any mid-game reconnect).
        // Whatever prompt the server presents on a fresh connection is by
        // definition unanswered.
        this.answeredPrompts?.clear();
        this.distributeState?.clear();
        this.socket = io(SERVER, {
            path: '/ws',
            query: {
                user: JSON.stringify({ id: this.user.id, username: this.user.username }),
                lobby: JSON.stringify({ lobbyId: lobbyId ?? null }),
                spectator: 'false',
            },
            transports: ['websocket'],
        });
        this.socket.on('lobbystate', (ls) => {
            const me = (ls.users ?? []).find((u) => u.id === this.user.id);
            if (me) this.lobbyUsername = me.username;
            record(this.name, 'lobbystate', { lobbyId: ls.id, myUsername: this.lobbyUsername });
        });
        this.socket.on('gamestate', (gs) => this.onGamestate(gs));
        this.socket.on('retransmitResponse', (rt) => {
            const added = this.messageLog.feedRetransmit(rt);
            if (added.length) record(this.name, 'messages', { lines: added, via: 'retransmit' });
        });
        this.socket.on('connection_error', (e) => record(this.name, 'connection_error', String(e?.message ?? e)));
    }

    myPlayer(gs) {
        if (!this.lobbyUsername) return null;
        for (const p of Object.values(gs.players ?? {})) {
            if (p?.user?.username === this.lobbyUsername) return p;
        }
        return null;
    }

    emitGame(...args) {
        record(this.name, 'answer', args);
        this.socket.emit('game', ...args);
    }

    onGamestate(gs) {
        this.lastStateAt = Date.now();
        this.currentPhase = gs.phase ?? this.currentPhase;
        record(this.name, 'gamestate-meta', { phase: gs.phase, winners: gs.winners, playerUpdate: gs.playerUpdate });
        // A new game id means a fresh game in this lobby (rematch / next Bo3
        // game): reset the message log and notify the lifecycle hook.
        if (gs.id && gs.id !== this.gameId) {
            this.gameId = gs.id;
            this.messageLog.reset();
            this.gameStartedAt = Date.now();
            if (this.onGameStart) { try { this.onGameStart(gs); } catch (e) { console.error('onGameStart error', e); } }
        }
        const { gap, added } = this.messageLog.feed(gs);
        if (added.length) record(this.name, 'messages', { lines: added });
        if (gap && this.socket) {
            this.socket.emit('lobby', 'retransmitGameMessages', gap.startIndex, gap.endIndex);
        }
        if (Array.isArray(gs.winners) && gs.winners.length > 0) {
            console.log(`GAME OVER — winners: ${JSON.stringify(gs.winners)}`);
            if (this.gameEndedForId !== gs.id) {
                this.gameEndedForId = gs.id;
                if (this.onGameEnd) {
                    try {
                        this.onGameEnd({
                            winners: gs.winners,
                            gameId: gs.id,
                            durationMs: this.gameStartedAt ? Date.now() - this.gameStartedAt : null,
                        });
                    } catch (e) { console.error('onGameEnd error', e); }
                }
            }
            this.hasActionablePrompt = false;
            if (!this.stayAliveOnGameEnd) finish(0);
            return;
        }
        const me = this.myPlayer(gs);
        if (!me) { this.hasActionablePrompt = false; return; }
        const ps = me.promptState;
        if (!ps || !ps.promptUuid) { this.hasActionablePrompt = false; return; }
        if (ps.menuTitle && ps.menuTitle.startsWith('Waiting for')) { this.hasActionablePrompt = false; return; }
        this.hasActionablePrompt = true;

        // Targets live in the OPPONENT's piles — scan every player's cards.
        this.view = { me, entries: allEntries(gs, this.lobbyUsername) };
        const selectableNow = this.view.entries.filter((e) => e.card.selectable);
        const selectedNow = this.view.entries.filter((e) => e.card.selected);
        let signature = JSON.stringify([ps.promptType, ps.menuTitle, (ps.buttons ?? []).map((b) => [b.text, !!b.disabled]), (ps.displayCards ?? []).length, selectedNow.map((c) => c.uuid), selectableNow.length]);
        if (ps.promptType === 'distributeAmongTargets') {
            signature += '|att' + (this.distributeState?.get(ps.promptUuid) ?? 0);
        }
        if (this.answeredPrompts.get(ps.promptUuid) === signature) return; // already answered this exact prompt
        this.answeredPrompts.set(ps.promptUuid, signature);
        this.promptsSeen.set(ps.promptType ?? '(none)', (this.promptsSeen.get(ps.promptType ?? '(none)') ?? 0) + 1);
        record(this.name, 'prompt', { promptState: ps, myPiles: summarizePiles(me), allPiles: summarizeAll(gs) });
        if (/target/i.test(ps.menuTitle ?? '')) {
            record(this.name, 'target-prompt-fullstate', gs);
        }
        console.log(`[${this.name}] prompt type=${ps.promptType} title="${ps.promptTitle ?? ''}" menu="${(ps.menuTitle ?? '').slice(0, 80)}" buttons=[${(ps.buttons ?? []).map((b) => b.text).join(' | ')}] displayCards=${(ps.displayCards ?? []).length}`);

        const view = this.view;
        setTimeout(() => this.answer(ps, view), 350);
    }

    answer(ps, view) {
        const me = view.me;

        // Stateful distribute prompts (indirect damage, experience, ...):
        // ONE message carries the whole distribution — the client accumulates
        // clicks locally and sends {type, valueDistribution:[{uuid, amount}]}
        // with the prompt uuid. No cardClicked, no 'done' string.
        if (ps.promptType === 'distributeAmongTargets') {
            this.distributeState = this.distributeState ?? new Map();
            const attempt = (this.distributeState.get(ps.promptUuid) ?? 0) + 1;
            this.distributeState.set(ps.promptUuid, attempt);
            const info = ps.distributeAmongTargets ?? {};
            const amount = info.amount ?? 1;
            const isDamage = /damage/i.test(info.type ?? '');
            // The engine marks exactly the legal targets selectable — trust
            // that, never filter by side. (Indirect damage from an attack is
            // distributed by the DEFENDER among their OWN units.)
            const pool = view.entries.filter((e) => e.card.selectable && e.card.uuid);
            const units = pool.filter((e) => e.zone === 'groundArena' || e.zone === 'spaceArena');
            const sorted = isDamage
                ? [...units].sort((a, b) => (a.card.hp ?? 99) - (b.card.hp ?? 99))
                : [...units].sort((a, b) => (b.card.power ?? 0) - (a.card.power ?? 0));
            const base = pool.find((e) => e.zone === 'base');
            const order = [...sorted, ...(base ? [base] : []), ...pool.filter((e) => !sorted.includes(e) && e !== base)];
            if (order.length === 0) return;
            // Damage can never exceed a target's remaining HP (hp - damage) —
            // dumping 3 on a 2-HP unit is an illegal distribution and the
            // server rejects it silently. Overflow walks down the order.
            const remainingHp = (c) => Math.max(0, (c.hp ?? 99) - (c.damage ?? 0));
            const counts = new Map();
            let left = amount;
            if (attempt === 1) {
                for (const e of order) {
                    if (left <= 0) break;
                    const cap = isDamage ? remainingHp(e.card) : left;
                    const give = Math.min(cap, left);
                    if (give > 0) { counts.set(e.card.uuid, give); left -= give; }
                }
            } else {
                // Retry spread: 1 point each, cycling the order, same caps.
                let i = 0;
                while (left > 0 && order.length > 0) {
                    const e = order[i % order.length];
                    const cap = isDamage ? remainingHp(e.card) : amount;
                    if ((counts.get(e.card.uuid) ?? 0) < cap) {
                        counts.set(e.card.uuid, (counts.get(e.card.uuid) ?? 0) + 1);
                        left--;
                    }
                    i++;
                    if (i > amount * order.length + 10) break;
                }
            }
            const valueDistribution = [...counts.entries()].map(([uuid, amt]) => ({ uuid, amount: amt }));
            this.emitGame('statefulPromptResults', { type: info.type, valueDistribution }, ps.promptUuid);
            return;
        }

        const buttons = (ps.buttons ?? []).filter((b) => !b.disabled);
        const selectable = view.entries.filter((e) => e.card.selectable && e.card.uuid).map((e) => e.card);
        const selected = view.entries.filter((e) => e.card.selected).map((e) => e.card);

        // Mulligan: keep a hand with at least two cheap cards (a curve);
        // mulligan once at most, keep whatever comes back.
        if ((ps.promptTitle ?? '').includes('Mulligan')) {
            const hand = (me.cardPiles?.hand ?? []).filter((c) => c && c.name);
            const cheap = hand.filter((c) => costOf(c) <= 3).length;
            const keepBtn = buttons.find((b) => /keep/i.test(b.text ?? ''));
            const mullBtn = buttons.find((b) => /mulligan/i.test(b.text ?? ''));
            const choice = (this.mulligans ?? 0) >= 1 || cheap >= 2 ? (keepBtn ?? buttons[0]) : (mullBtn ?? keepBtn ?? buttons[0]);
            if (choice === mullBtn) this.mulligans = (this.mulligans ?? 0) + 1;
            if (choice) { this.emitGame(choice.command, choice.arg, choice.uuid); return; }
        }

        // Action window: play a card, attack, or pass — in that order.
        if (ps.promptType === 'actionWindow') {
            const hand = (me.cardPiles?.hand ?? []).filter((c) => c && c.selectable && c.uuid);
            if (hand.length > 0) {
                const play = hand.reduce((a, b) => (costOf(b) > costOf(a) ? b : a));
                this.emitGame('cardClicked', play.uuid);
                return;
            }
            const attackers = [...(me.cardPiles?.groundArena ?? []), ...(me.cardPiles?.spaceArena ?? [])]
                .filter((c) => c && c.selectable && c.uuid && !c.exhausted);
            if (attackers.length > 0) {
                this.lastAttackerPower = attackers[0].power ?? 0;
                this.emitGame('cardClicked', attackers[0].uuid);
                return;
            }
            const pass = buttons.find((b) => /pass/i.test(b.text ?? ''));
            const claim = buttons.find((b) => /claim/i.test(b.text ?? ''));
            const choice = pass ?? claim ?? buttons[0];
            if (choice) { this.emitGame(choice.command, choice.arg, choice.uuid); return; }
        }

        // Attack target: kill a unit my attacker survives-or-trades with,
        // otherwise hit the base, otherwise the weakest enemy unit.
        if (/target for attack/i.test(ps.menuTitle ?? '') || /target for attack/i.test(ps.promptTitle ?? '')) {
            const enemyEntries = view.entries.filter((e) => !e.mine && e.card.selectable && e.card.uuid);
            if (enemyEntries.length > 0) {
                const atk = this.lastAttackerPower ?? 0;
                const units = enemyEntries.filter((e) => e.zone === 'groundArena' || e.zone === 'spaceArena');
                const killable = units.filter((e) => (e.card.hp ?? 99) <= atk)
                    .sort((a, b) => (b.card.power ?? 0) - (a.card.power ?? 0));
                const base = enemyEntries.find((e) => e.zone === 'base');
                const weakest = [...units].sort((a, b) => (a.card.hp ?? 99) - (b.card.hp ?? 99))[0];
                const target = killable[0] ?? base ?? weakest ?? enemyEntries[0];
                this.emitGame('cardClicked', target.card.uuid);
                return;
            }
        }

        // Selection prompts (resource step, target picks, etc.): click cards
        // BEFORE any confirm button. The confirm arrives disabled until the
        // required number are selected.
        const isSelection = !!ps.selectCardMode || (selectable.length > 0 && (ps.buttons ?? []).length > 0);
        if (isSelection && selectable.length > 0) {
            const between = /between (\d+) and (\d+)/i.exec(ps.menuTitle ?? '');
            const m = /select (?:up to )?(\d+)/i.exec(ps.menuTitle ?? '');
            const needed = between ? parseInt(between[2], 10) : (m ? parseInt(m[1], 10) : (ps.selectCardMode === 'single' ? 1 : selectable.length));
            const upTo = /up to/i.test(ps.menuTitle ?? '');
            if (selected.length < needed && !(upTo && selected.length >= 1)) {
                const unselected = selectable.filter((c) => !c.selected);
                if (unselected.length > 0) {
                    // Resource heuristic: shed the most expensive cards first —
                    // they are unplayable for the most turns.
                    const pickCard = ps.promptType === 'resource'
                        ? unselected.reduce((a, b) => (costOf(b) > costOf(a) ? b : a))
                        : unselected[0];
                    this.emitGame('cardClicked', pickCard.uuid);
                    return;
                }
            }
            if (buttons.length > 0) {
                this.emitGame(buttons[0].command, buttons[0].arg, buttons[0].uuid);
                return;
            }
        }

        if (buttons.length > 0) {
            // Damage-to-a-player choices: hit the opponent, not yourself.
            if (/damage/i.test(ps.menuTitle ?? '')) {
                const opp = buttons.find((b) => /opponent/i.test(b.text ?? ''));
                if (opp) { this.emitGame(opp.command, opp.arg, opp.uuid); return; }
            }
            const pick = BUTTON_PREFS
                .map((pref) => buttons.find((b) => (b.text ?? '').toLowerCase().includes(pref)))
                .find(Boolean) ?? buttons[0];
            this.emitGame(pick.command, pick.arg, pick.uuid);
            return;
        }
        if ((ps.dropdownListOptions ?? []).length > 0) {
            this.emitGame('menuButton', ps.dropdownListOptions[0], ps.promptUuid);
            return;
        }
        // Card-selection prompt: try displayCards first, then any selectable card in my piles
        const displayUuid = (ps.displayCards ?? []).find((c) => c && (c.uuid ?? c.id))?.uuid ?? (ps.displayCards ?? [])[0]?.id;
        if (displayUuid) {
            this.emitGame('cardClicked', displayUuid);
            return;
        }
        const candidate = findSelectableCard(me);
        if (candidate) {
            this.emitGame('cardClicked', candidate);
            return;
        }
        record(this.name, 'no-answer-found', { promptState: ps });
        console.log(`[${this.name}] NO ANSWER for prompt type=${ps.promptType} menu="${(ps.menuTitle ?? '').slice(0, 80)}"`);
    }
}

function summarizePiles(player) {
    const out = {};
    for (const [zone, cards] of Object.entries(player.cardPiles ?? {})) {
        if (Array.isArray(cards) && cards.length > 0) {
            out[zone] = cards.map((c) => ({ uuid: c.uuid, name: c.name, cost: c.cost, power: c.power, hp: c.hp, selectable: c.selectable, selected: c.selected, canBePlayed: c.canBePlayed, exhausted: c.exhausted }));
        }
    }
    return out;
}

function allCards(player) {
    const out = [];
    for (const cards of Object.values(player.cardPiles ?? {})) {
        if (Array.isArray(cards)) out.push(...cards.filter((c) => c && typeof c === 'object'));
    }
    return out;
}

// Every card in the game with its owner and zone: [{card, mine, zone}]
function allEntries(gs, myUsername) {
    const out = [];
    for (const p of Object.values(gs.players ?? {})) {
        const mine = p?.user?.username === myUsername;
        for (const [zone, cards] of Object.entries(p.cardPiles ?? {})) {
            if (Array.isArray(cards)) {
                for (const c of cards) if (c && typeof c === 'object') out.push({ card: c, mine, zone });
            }
        }
        // The base is a card object on the player, NOT in cardPiles — and it
        // is the most common attack target. Missing it stalled target picks.
        if (p.base && typeof p.base === 'object') out.push({ card: p.base, mine, zone: 'base' });
    }
    return out;
}

function summarizeAll(gs) {
    const out = {};
    for (const p of Object.values(gs.players ?? {})) {
        out[p?.user?.username ?? '?'] = summarizePiles(p);
    }
    return out;
}

function findSelectableCard(player) {
    for (const cards of Object.values(player.cardPiles ?? {})) {
        if (!Array.isArray(cards)) continue;
        for (const c of cards) {
            if (c && c.uuid && (c.selectable || c.canBePlayed)) return c.uuid;
        }
    }
    return null;
}

let finished = false;
function finish(code) {
    if (finished) return;
    finished = true;
    flush();
    console.log(`Capture: ${capturePath.pathname} (${lines.length} events)`);
    process.exit(code);
}

// Stage 6: opponent mode stays alive past game end, so it flushes the
// capture itself (the replay viewer reads these files).
function flushCapture() {
    flush();
    return capturePath.pathname;
}

export { Seat, post, flushCapture };

// ---- lobby flow (same proven sequence as probe.mjs) ----
async function runBotVsBot() {
    const hostDeck = loadDeckArg('--host-deck', deckVader);
    const guestDeck = loadDeckArg('--guest-deck', deckJabba);
    if (!hostDeck || !guestDeck) {
        console.log('bot.mjs standalone mode needs --host-deck and --guest-deck files (the built-in defaults live in Gord\'s workspace and are not part of the shipped install).');
        process.exit(1);
    }
    const host = new Seat('BotHost', hostDeck);
    const guest = new Seat('BotGuest', guestDeck);

    const create = await post('/api/create-lobby', {
        user: host.user, deck: host.deck, isPrivate: true, format: 'eternal',
        lobbyName: 'Bot Test Game', cardPool: 'current', gamesToWinMode: 'bestOfOne',
    });
    if (create.status !== 200) { console.log('create-lobby failed', create); process.exit(1); }
    host.connect(null);
    await new Promise((r) => setTimeout(r, 3000));

    const hostLobby = lines.map((l) => JSON.parse(l)).find((l) => l.side === 'BotHost' && l.event === 'lobbystate');
    const lobbyId = hostLobby?.data?.lobbyId;
    if (!lobbyId) { console.log('no lobby id'); finish(1); }

    const join = await post('/api/join-lobby', { lobbyId, user: guest.user });
    if (join.status !== 200) { console.log('join failed', join); finish(1); }
    guest.connect(lobbyId);
    await new Promise((r) => setTimeout(r, 2000));
    const change = await post(`/api/lobby/${lobbyId}/change-deck`, { user: guest.user, deck: guest.deck });
    if (change.status !== 200) { console.log('change-deck failed', change); finish(1); }

    guest.socket.emit('lobby', 'setReadyStatus', true);
    host.socket.emit('lobby', 'setReadyStatus', true);
    await new Promise((r) => setTimeout(r, 1000));
    host.socket.emit('lobby', 'startGameAsync');
    console.log('Game started; driving both seats...');

    // ---- watchdogs ----
    const stallTimer = setInterval(() => {
        const idleMs = Date.now() - Math.max(host.lastStateAt, guest.lastStateAt);
        if (idleMs > 45000) {
            console.log(`STALL: no gamestate for ${Math.round(idleMs / 1000)}s`);
            console.log('host prompts:', [...host.promptsSeen.entries()]);
            console.log('guest prompts:', [...guest.promptsSeen.entries()]);
            finish(2);
        }
        if (Date.now() - startedAt > maxMs) {
            console.log(`TIME CAP reached. host prompts:`, [...host.promptsSeen.entries()], 'guest prompts:', [...guest.promptsSeen.entries()]);
            finish(3);
        }
    }, 5000);
    stallTimer.unref();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    runBotVsBot().catch((e) => { console.error(e); finish(1); });
}
