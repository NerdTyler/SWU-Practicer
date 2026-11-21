// records.mjs — the local win/loss record book for practice games.
//
// One JSON file (records.json next to this module): an append-only list of
// game and series results recorded by the practice opponent bot. The
// practice page reads the aggregates from here. Nothing leaves the machine.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RECORDS_FILE = path.join(APP_DIR, 'records.json');

export function loadRecords(file = DEFAULT_RECORDS_FILE) {
    if (existsSync(file)) {
        try {
            const j = JSON.parse(readFileSync(file, 'utf8'));
            if (j && Array.isArray(j.entries)) return j;
        } catch { /* fall through to a fresh book */ }
    }
    return { version: 1, entries: [] };
}

export function appendRecord(entry, file = DEFAULT_RECORDS_FILE) {
    const data = loadRecords(file);
    data.entries.push({ ...entry, recordedAt: new Date().toISOString() });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    return data;
}

// Aggregates from the human's point of view ("wins" = games the human won
// against the bot).
export function summarizeRecords(file = DEFAULT_RECORDS_FILE) {
    const { entries } = loadRecords(file);
    const games = entries.filter((e) => e.kind === 'game');
    const seriesList = entries.filter((e) => e.kind === 'series');
    const blank = () => ({ wins: 0, losses: 0 });
    const overall = blank();
    const seriesAgg = blank();
    const byHumanDeck = new Map();
    const byBotDeck = new Map();
    const bump = (map, key, humanWon) => {
        if (!key) return;
        if (!map.has(key)) map.set(key, blank());
        const t = map.get(key);
        if (humanWon) t.wins++; else t.losses++;
    };
    for (const g of games) {
        const hw = g.winnerSide === 'human';
        if (hw) overall.wins++; else overall.losses++;
        bump(byHumanDeck, g.humanDeck, hw);
        bump(byBotDeck, g.botDeck, hw);
    }
    for (const s of seriesList) {
        if (s.winnerSide === 'human') seriesAgg.wins++; else seriesAgg.losses++;
    }
    const toList = (map) => [...map.entries()].map(([name, t]) => ({ name, ...t }));
    return {
        overall,
        series: seriesAgg,
        byHumanDeck: toList(byHumanDeck),
        byBotDeck: toList(byBotDeck),
        totalGames: games.length,
        totalSeries: seriesList.length,
        recent: entries.slice(-12).reverse(),
    };
}
