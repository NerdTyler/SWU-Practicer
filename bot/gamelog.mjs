// gamelog.mjs — the engine's own message log, accumulated from the
// gamestate stream, plus the end-of-match play-by-play summary builder.
//
// The Karabast server attaches message deltas to every gamestate event
// (newMessages / messageOffset / totalMessages — the same protocol the web
// client's useGameMessages hook consumes). A MessageLog consumes those
// deltas exactly like the client does: entries are placed at absolute
// indices, gaps are reported so the caller can ask the lobby to retransmit
// ('retransmitGameMessages'), and retransmit responses fill the gaps.
//
// The summary is built ONLY from this engine record (plus lobby facts the
// caller supplies: decks, leaders, bases, winner) — nothing is invented.

export function renderChatPart(part) {
    if (part == null) return '';
    if (typeof part === 'string') return part;
    if (typeof part === 'number') return String(part);
    if (typeof part === 'object') {
        if (part.type === 'playerChat') return part.name ?? '';
        if (typeof part.name === 'string') return part.name; // card / player object
        if (typeof part.label === 'string') return part.label;
    }
    return '';
}

export function renderChatEntry(entry) {
    const content = entry?.message;
    if (content == null) return null;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        if (content[0]?.type === 'playerChat') {
            const [head, ...rest] = content;
            return `${head.name}: ${rest.map(renderChatPart).join('')}`;
        }
        return content.map(renderChatPart).join('');
    }
    if (typeof content === 'object' && content.alert) {
        return (content.alert.message ?? []).map(renderChatPart).join('');
    }
    return null;
}

export class MessageLog {
    constructor() {
        this.reset();
    }

    reset() {
        this.byIndex = new Map(); // absolute message index -> raw entry
        this.count = 0; // one past the highest index covered by deltas
        this.total = 0;
    }

    // Feed one gamestate event. Returns { gap, added } where gap is
    // { startIndex, endIndex } if a retransmit should be requested, and
    // added is the list of newly rendered text lines (in arrival order).
    feed(gs) {
        const added = [];
        if (!gs || !Array.isArray(gs.newMessages) || typeof gs.messageOffset !== 'number') {
            return { gap: null, added };
        }
        let gap = null;
        if (gs.messageOffset > this.count) {
            gap = { startIndex: this.count, endIndex: gs.messageOffset };
        }
        gs.newMessages.forEach((entry, i) => {
            const idx = gs.messageOffset + i;
            if (!this.byIndex.has(idx)) {
                this.byIndex.set(idx, entry);
                const line = renderChatEntry(entry);
                if (line) added.push(line);
            }
        });
        this.count = Math.max(this.count, gs.messageOffset + gs.newMessages.length);
        if (typeof gs.totalMessages === 'number') this.total = gs.totalMessages;
        return { gap, added };
    }

    // Feed a 'retransmitResponse' payload { messages, startIndex }.
    // Returns newly rendered lines.
    feedRetransmit(rt) {
        const added = [];
        if (!rt || !Array.isArray(rt.messages) || typeof rt.startIndex !== 'number') return added;
        rt.messages.forEach((entry, i) => {
            const idx = rt.startIndex + i;
            if (!this.byIndex.has(idx)) {
                this.byIndex.set(idx, entry);
                const line = renderChatEntry(entry);
                if (line) added.push(line);
            }
        });
        return added;
    }

    lines() {
        return [...this.byIndex.keys()]
            .sort((a, b) => a - b)
            .map((k) => renderChatEntry(this.byIndex.get(k)))
            .filter((l) => l != null && l !== '');
    }
}

function fmtDuration(ms) {
    if (ms == null) return 'unknown';
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// Build the plain-text play-by-play summary for one finished game.
// seats: [{ label ('You' / 'Bot'), name (lobby username), leader, base, deck }]
// The message log is grouped under round headers when the engine's own
// messages announce a new round; otherwise it is one continuous log.
export function buildSummary({ title, mode, gameNumber, seats, winnerName, startedAt, endedAt, lines }) {
    const out = [];
    out.push('STAR WARS: UNLIMITED — PRACTICE MATCH SUMMARY');
    out.push(title ?? (mode === 'bo3' ? `Best of 3 · Game ${gameNumber}` : 'Best of 1'));
    out.push(`Date: ${new Date(endedAt ?? Date.now()).toLocaleString()}`);
    for (const s of seats) {
        const who = s.leader || s.base ? ` — ${s.leader ?? '?'} / ${s.base ?? '?'}` : '';
        const deck = s.deck ? ` (deck: ${s.deck})` : '';
        out.push(`${s.label}: ${s.name}${who}${deck}`);
    }
    out.push(`Result: ${winnerName ? `${winnerName} wins` : 'no winner recorded'}`);
    if (startedAt != null && endedAt != null) out.push(`Duration: ${fmtDuration(endedAt - startedAt)}`);
    out.push('');
    out.push('PLAY-BY-PLAY (engine game log)');
    // The engine announces rounds as "Round: N - Action Phase" (a header)
    // and "Round: N - Regroup Phase" (kept inline). Icon placeholders like
    // {resource:1} / {keyword:saboteur} are rendered as plain words.
    const clean = (line) => line
        .replace(/\{resource:(\d+)\}/g, '$1 resource')
        .replace(/\{keyword:([^}]+)\}/g, '$1')
        .replace(/\{aspect:([^}]+)\}/g, '$1');
    for (const line of lines) {
        const m = /^Round: (\d+) - Action Phase$/.exec(line.trim());
        if (m) {
            out.push('');
            out.push(`— Round ${m[1]} —`);
            continue;
        }
        out.push(clean(line));
    }
    out.push('');
    out.push(`(${lines.length} log entries)`);
    return out.join('\n') + '\n';
}

// Series summary for a finished Bo3 set: header + per-game results +
// each game's full play-by-play.
export function buildSeriesSummary({ seats, games, winnerName, endedAt }) {
    const out = [];
    out.push('STAR WARS: UNLIMITED — PRACTICE SERIES SUMMARY (BEST OF 3)');
    out.push(`Date: ${new Date(endedAt ?? Date.now()).toLocaleString()}`);
    for (const s of seats) {
        const who = s.leader || s.base ? ` — ${s.leader ?? '?'} / ${s.base ?? '?'}` : '';
        const deck = s.deck ? ` (deck: ${s.deck})` : '';
        out.push(`${s.label}: ${s.name}${who}${deck}`);
    }
    out.push('');
    for (const g of games) {
        out.push(`Game ${g.gameNumber}: ${g.winnerName} wins`);
    }
    out.push(`Series result: ${winnerName ? `${winnerName} wins the series` : 'no winner recorded'}`);
    for (const g of games) {
        out.push('');
        out.push('='.repeat(60));
        out.push(g.summaryText.trimEnd());
    }
    return out.join('\n') + '\n';
}
