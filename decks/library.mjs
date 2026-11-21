// Deck library for the SWU offline practice app (Stage 4).
//
// One module behind the deck import section, the community decks dropdown,
// and the bot wiring:
//   - "My Decks": Tyler's four decks pre-loaded from the SWU goal files,
//     plus anything imported later. Stored as files in decks/my/ with a
//     registry at decks/my-decks.json.
//   - "Community Decks": read live from ../community-decks.json (the file
//     refresh-community-decks.mjs rewrites on every update run), so the
//     dropdown is always as fresh as the last update.
//
// Every deck is SWUDB JSON: { metadata, leader:{id,count}, base:{id,count},
// deck:[{id,count}...], sideboard:[{id,count}...] } — the exact shape the
// game server's create-lobby accepts.
//
// CLI:
//   node library.mjs list                 -> human-readable deck list
//   node library.mjs get <id>             -> deck JSON on stdout
//   node library.mjs validate <file|->    -> validate a deck file (or stdin)
//   node library.mjs import <name> <file|->  -> validate + add to My Decks
//   node library.mjs preload              -> (re)seed Tyler's four decks
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DECKS_DIR = path.join(APP_DIR, 'decks');
export const MY_DIR = path.join(DECKS_DIR, 'my');
const REGISTRY_PATH = path.join(DECKS_DIR, 'my-decks.json');
const COMMUNITY_PATH = path.join(APP_DIR, 'community-decks.json');
const TYLER_DECKS_DIR = path.join(APP_DIR, '..', 'goals', 'star-wars-unlimited-decks-and-collection', 'files');
const CARD_DIR = path.join(APP_DIR, '..', 'forceteki', 'test', 'json', 'Card');

const TYLER_DECKS = [
    { file: 'vader-deck-holoscan.json', name: 'Vader — Coaxium Mine' },
    { file: 'jabba-deck-holoscan.json', name: "Jabba — Daimyo's Palace" },
    { file: 'trance-deck-holoscan.json', name: 'Trance — Palpatine Recursion' },
    { file: 'rites-deck-holoscan.json', name: 'Rites — Thrawn Death Payoffs' },
];

// Deck ids in the wild are SET_NNN, but the number is not always zero-padded
// (Tyler's Trance deck carries "TS26_57" for Mechanize). Accept 1-3 digits
// and normalize to the padded form for existence checks and storage.
const ID_RE = /^[A-Z][A-Z0-9]{1,4}_\d{1,3}$/;
function normalizeId(id) {
    const m = /^([A-Z][A-Z0-9]{1,4})_(\d{1,3})$/.exec(id ?? '');
    return m ? `${m[1]}_${m[2].padStart(3, '0')}` : id;
}

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck';
}

// ---- card id universe (for validation) -------------------------------------
let _validIds = null;
export function validCardIds() {
    if (_validIds) return _validIds;
    _validIds = new Set();
    try {
        for (const f of readdirSync(CARD_DIR)) {
            if (!f.endsWith('.json')) continue;
            try {
                const c = JSON.parse(readFileSync(path.join(CARD_DIR, f), 'utf8'));
                // A card's primary printing is setId; every other printing
                // lives in setCodes — deck ids may reference ANY printing
                // (e.g. Betrayed Trust is IC27_055 primarily, LAW_130 in LAW).
                const all = [...(c.setId ? [c.setId] : []), ...(Array.isArray(c.setCodes) ? c.setCodes : [])];
                for (const s of all) {
                    if (s?.set && typeof s.number === 'number') {
                        _validIds.add(`${s.set}_${String(s.number).padStart(3, '0')}`);
                    }
                }
            } catch { /* skip unreadable card file */ }
        }
    } catch { /* card dir missing — validation falls back to format-only */ }
    return _validIds;
}

// ---- validation --------------------------------------------------------------
// Returns { ok, errors:[], warnings:[], summary:{leader, base, main, sideboard} }
export function validateDeck(deck) {
    const errors = [];
    const warnings = [];
    if (!deck || typeof deck !== 'object' || Array.isArray(deck)) {
        return { ok: false, errors: ['deck is not a JSON object'], warnings, summary: null };
    }
    const ids = validCardIds();
    const checkEntry = (entry, what) => {
        if (!entry || typeof entry.id !== 'string' || !ID_RE.test(entry.id)) {
            errors.push(`${what}: missing or malformed id (want SET_NNN form, got ${JSON.stringify(entry?.id)})`);
            return;
        }
        if (ids.size > 0 && !ids.has(normalizeId(entry.id))) errors.push(`${what}: unknown card id ${entry.id} (not in the local card data)`);
        if (typeof entry.count !== 'number' || entry.count < 1) errors.push(`${what} ${entry.id}: count must be a positive number`);
    };
    checkEntry(deck.leader, 'leader');
    if (deck.leader && deck.leader.count !== 1) errors.push('leader count must be exactly 1');
    checkEntry(deck.base, 'base');
    if (deck.base && deck.base.count !== 1) errors.push('base count must be exactly 1');
    if (!Array.isArray(deck.deck)) {
        errors.push('deck: main deck list is missing (want an array of {id, count})');
    }
    const main = Array.isArray(deck.deck) ? deck.deck.reduce((a, c) => a + (c?.count ?? 0), 0) : 0;
    if (Array.isArray(deck.deck)) {
        deck.deck.forEach((c, i) => checkEntry(c, `deck[${i}]`));
        if (main !== 50) errors.push(`main deck totals ${main} cards, must be exactly 50`);
        const over = deck.deck.filter((c) => (c?.count ?? 0) > 3);
        if (over.length > 0) warnings.push(`more than 3 copies of: ${over.map((c) => c.id).join(', ')} (legal only for specific cards)`);
    }
    const side = Array.isArray(deck.sideboard) ? deck.sideboard.reduce((a, c) => a + (c?.count ?? 0), 0) : 0;
    if (Array.isArray(deck.sideboard)) {
        deck.sideboard.forEach((c, i) => checkEntry(c, `sideboard[${i}]`));
        if (side > 10) errors.push(`sideboard totals ${side} cards, max 10`);
    }
    if (ids.size === 0) warnings.push('local card data not found — ids checked for format only, not existence');
    return {
        ok: errors.length === 0,
        errors,
        warnings,
        summary: { leader: deck.leader?.id ?? null, base: deck.base?.id ?? null, main, sideboard: side },
    };
}

// ---- My Decks registry ---------------------------------------------------------
function readRegistry() {
    try { return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')); } catch { return []; }
}
function writeRegistry(reg) {
    mkdirSync(MY_DIR, { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n');
}

// Copy Tyler's four decks into the library (idempotent; never overwrites an
// existing registry entry, so later renames/imports survive a re-run).
export function ensurePreloaded() {
    const reg = readRegistry();
    let changed = false;
    for (const t of TYLER_DECKS) {
        const dest = path.join(MY_DIR, t.file);
        if (!existsSync(dest)) {
            const src = path.join(TYLER_DECKS_DIR, t.file);
            if (!existsSync(src)) continue;
            mkdirSync(MY_DIR, { recursive: true });
            copyFileSync(src, dest);
        }
        if (!reg.some((r) => r.file === t.file)) {
            reg.push({ id: `my:${slugify(t.name)}`, name: t.name, file: t.file, source: 'Tyler (pre-loaded)' });
            changed = true;
        }
    }
    if (changed || !existsSync(REGISTRY_PATH)) writeRegistry(reg);
    return reg;
}

export function importDeck(name, deck) {
    const v = validateDeck(deck);
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };
    ensurePreloaded();
    const reg = readRegistry();
    const slug = slugify(name);
    const file = `${slug}.json`;
    mkdirSync(MY_DIR, { recursive: true });
    // Store ids in canonical zero-padded SET_NNN form.
    const normEntry = (e) => (e && typeof e.id === 'string' ? { ...e, id: normalizeId(e.id) } : e);
    const toSave = {
        ...deck,
        leader: normEntry(deck.leader),
        base: normEntry(deck.base),
        deck: Array.isArray(deck.deck) ? deck.deck.map(normEntry) : deck.deck,
        sideboard: Array.isArray(deck.sideboard) ? deck.sideboard.map(normEntry) : deck.sideboard,
        metadata: { ...(deck.metadata ?? {}), name, author: deck.metadata?.author ?? 'imported' },
    };
    writeFileSync(path.join(MY_DIR, file), JSON.stringify(toSave, null, 2) + '\n');
    const existing = reg.findIndex((r) => r.file === file);
    const entry = { id: `my:${slug}`, name, file, source: 'imported' };
    if (existing >= 0) reg[existing] = entry; else reg.push(entry);
    writeRegistry(reg);
    return { ok: true, entry, warnings: v.warnings, summary: v.summary };
}

// ---- listing / lookup ------------------------------------------------------------
export function listDecks() {
    const reg = ensurePreloaded();
    const mine = reg.map((r) => {
        let summary = null;
        try { summary = validateDeck(JSON.parse(readFileSync(path.join(MY_DIR, r.file), 'utf8'))).summary; } catch { /* unreadable */ }
        return { id: r.id, name: r.name, source: r.source, kind: 'mine', summary };
    });
    let community = [];
    try {
        const data = JSON.parse(readFileSync(COMMUNITY_PATH, 'utf8'));
        community = (data.decks ?? []).map((d, i) => ({
            id: `community:${i}`,
            name: d.name,
            source: d.sourceUrl ?? 'sw-unlimited-db.com',
            kind: 'community',
            summary: {
                leader: d.deck?.leader?.id ?? null,
                base: d.deck?.base?.id ?? null,
                main: (d.deck?.deck ?? []).reduce((a, c) => a + (c.count ?? 0), 0),
                sideboard: (d.deck?.sideboard ?? []).reduce((a, c) => a + (c.count ?? 0), 0),
            },
        }));
    } catch { /* community file missing — dropdown just shows My Decks */ }
    return { mine, community };
}

// Resolve a library id ("my:<slug>" / "community:<index>") to deck JSON.
export function getDeck(id) {
    if (typeof id !== 'string') return null;
    if (id.startsWith('my:')) {
        const reg = ensurePreloaded();
        const entry = reg.find((r) => r.id === id);
        if (!entry) return null;
        return JSON.parse(readFileSync(path.join(MY_DIR, entry.file), 'utf8'));
    }
    if (id.startsWith('community:')) {
        const idx = parseInt(id.slice('community:'.length), 10);
        const data = JSON.parse(readFileSync(COMMUNITY_PATH, 'utf8'));
        return data.decks?.[idx]?.deck ?? null;
    }
    return null;
}

export function deckName(id) {
    const all = listDecks();
    return [...all.mine, ...all.community].find((d) => d.id === id)?.name ?? id;
}

// ---- CLI ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const [cmd, arg1, arg2] = process.argv.slice(2);
    const readInput = async (p) => {
        if (p && p !== '-') return readFileSync(p, 'utf8');
        const chunks = [];
        for await (const ch of process.stdin) chunks.push(ch);
        return Buffer.concat(chunks).toString('utf8');
    };
    if (cmd === 'list') {
        const { mine, community } = listDecks();
        console.log(`My Decks (${mine.length}):`);
        for (const d of mine) console.log(`  ${d.id}  ${d.name}  [leader ${d.summary?.leader}, base ${d.summary?.base}, ${d.summary?.main} cards]`);
        console.log(`Community Decks (${community.length}):`);
        for (const d of community) console.log(`  ${d.id}  ${d.name}  [leader ${d.summary?.leader}, base ${d.summary?.base}, ${d.summary?.main} cards]`);
    } else if (cmd === 'get') {
        const deck = getDeck(arg1);
        if (!deck) { console.error(`no such deck: ${arg1}`); process.exit(1); }
        console.log(JSON.stringify(deck));
    } else if (cmd === 'validate') {
        const deck = JSON.parse(await readInput(arg1));
        const v = validateDeck(deck);
        console.log(JSON.stringify(v, null, 2));
        process.exit(v.ok ? 0 : 1);
    } else if (cmd === 'import') {
        if (!arg1) { console.error('usage: import <name> <file|->'); process.exit(1); }
        const deck = JSON.parse(await readInput(arg2));
        const res = importDeck(arg1, deck);
        console.log(JSON.stringify(res, null, 2));
        process.exit(res.ok ? 0 : 1);
    } else if (cmd === 'preload') {
        const reg = ensurePreloaded();
        console.log(`registry: ${reg.length} decks`);
    } else {
        console.error('usage: library.mjs list|get <id>|validate <file|->|import <name> <file|->|preload');
        process.exit(1);
    }
}
