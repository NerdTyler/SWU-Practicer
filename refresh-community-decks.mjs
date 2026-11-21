#!/usr/bin/env node
// Refresh the community-decks list for the SWU offline practice app.
//
// Source: sw-unlimited-db.com (tournament meta DB). Deck pages and leader
// pages are Nuxt apps whose __NUXT_DATA__ payload (devalue-flattened JSON)
// contains everything needed:
//   - the deck object: { name, cards: [{cardId, amount}], sideboard: [...] }
//     (main list totals 52 = 50 deck + leader + base; sideboard is separate)
//   - a pinia card store keyed by the site's numeric cardId, whose
//     data.attributes carry 'Card Type' and 'TTS Id' (the SET_NNN card id
//     the game engine uses, same format as Tyler's SWUDB JSON decks).
//
// Strategy (fail-soft, never empties the list):
//   1. Re-resolve every sourceUrl already in community-decks.json.
//   2. Crawl the S/A-tier leader pages (slugs below, from the verified seed
//      in community-decks.md) and take the first deck listed per leader,
//      checking the deck's leader subtitle matches the page's leader.
//   3. Validate every converted deck (exactly 1 leader, 1 base, 50 main
//      cards, 0-10 sideboard, all ids in SET_NNN form). Only decks that
//      validate are written. If nothing validates, exit 1 and leave the
//      existing file untouched.
//
// Usage: node refresh-community-decks.mjs [--out <path>] [--seed-only]
// Exit code 0 = file written (or already current), 1 = refresh failed,
// existing file preserved.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(APP_DIR, 'community-decks.json');
const SEED_ONLY = args.includes('--seed-only');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SITE = 'https://sw-unlimited-db.com';

// Verified 2026-11-20 (see community-decks.md): first "Top meta decks" entry
// for the top S-tier leaders of the 10 Oct - 15 Nov 2026 meta window.
const SEED_URLS = [
  'https://sw-unlimited-db.com/decks/172244', // Wicket — Imperial Command Complex
  'https://sw-unlimited-db.com/decks/172090', // Doctor Hemlock — Data Vault
  'https://sw-unlimited-db.com/decks/170971', // Director Krennic — Great Grass Plains
  'https://sw-unlimited-db.com/decks/169769', // Ahsoka Tano — Mos Eisley
];

// S/A-tier leaders from the same meta table (community-decks.md). Slugs are
// name + subtitle, lowercased and hyphenated — the site's verified pattern.
const LEADER_SLUGS = [
  'wicket-few-greater-battles-to-fight',
  'doctor-hemlock-emotion-has-no-place-here',
  'director-krennic-amidst-my-achievement',
  'ahsoka-tano-trust-in-the-force',
  'mother-talzin-power-through-magick',
  'dedra-meero-not-wasting-time',
  'lando-calrissian-full-sabacc',
  'darth-maul-sith-revealed',
  'han-solo-never-tell-me-the-odds',
  'boba-fett-any-methods-necessary',
  'sabine-wren-bargaining-on-belief',
  'kazuda-xiono-best-pilot-in-the-galaxy',
  'darth-vader-victor-squadron-leader',
];

const log = (...a) => console.log('[community-decks]', ...a);

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// --- Nuxt payload (devalue) handling -------------------------------------

function extractPayload(html) {
  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NUXT_DATA__ payload found');
  return JSON.parse(m[1]);
}

function unflatten(flat) {
  const revive = (i, depth) => {
    if (depth > 80) return null;
    const v = flat[i];
    if (Array.isArray(v)) {
      return v.map((x) => (Number.isInteger(x) && x >= 0 ? revive(x, depth + 1) : x));
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        out[k] = Number.isInteger(x) && x >= 0 ? revive(x, depth + 1) : x;
      }
      return out;
    }
    return v;
  };
  return revive(0, 0);
}

// --- structure finders (shape-tolerant deep walks) ------------------------

function findDeckObject(root) {
  let found = null;
  const walk = (o, depth) => {
    if (found || depth > 8 || !o || typeof o !== 'object') return;
    if (!Array.isArray(o) && Array.isArray(o.cards) && Array.isArray(o.sideboard) && typeof o.name === 'string') {
      found = o;
      return;
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(root, 0);
  return found;
}

// Card records in the pinia store are inconsistently wrapped: some are
// {data: {attributes}}, others sit inside an array ([1] -> {data: ...}).
// Unwrap either shape.
function attrsOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (Array.isArray(rec)) {
    for (const el of rec) {
      const a = attrsOf(el);
      if (a) return a;
    }
    return null;
  }
  if (rec.attributes && typeof rec.attributes === 'object') return rec.attributes;
  if (rec.data) return attrsOf(rec.data);
  return null;
}

function findCardStore(root) {
  // The pinia cards store: an object keyed by numeric site cardIds whose
  // values wrap data.attributes carrying a 'TTS Id'.
  let best = null;
  const walk = (o, depth) => {
    if (depth > 9 || !o || typeof o !== 'object') return;
    if (!Array.isArray(o)) {
      const keys = Object.keys(o);
      const numeric = keys.filter((k) => /^\d+$/.test(k));
      if (numeric.length >= 5) {
        let hits = 0;
        for (const k of numeric) {
          const attrs = attrsOf(o[k]);
          if (attrs && typeof attrs['TTS Id'] !== 'undefined') hits++;
        }
        if (hits >= 5 && (!best || numeric.length > Object.keys(best).length)) best = o;
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(root, 0);
  return best;
}

function firstVal(v) {
  return Array.isArray(v) ? v[0] : v;
}

// --- deck conversion -------------------------------------------------------

function convertDeck(root, sourceUrl) {
  const deckObj = findDeckObject(root);
  if (!deckObj) throw new Error('deck object not found in payload');
  const store = findCardStore(root);
  if (!store) throw new Error('card store not found in payload');

  const lookup = (cardId) => {
    const attrs = attrsOf(store[String(cardId)]);
    if (!attrs) throw new Error(`cardId ${cardId} missing from card store`);
    return {
      id: firstVal(attrs['TTS Id']),
      type: firstVal(attrs['Card Type']),
      subtitle: firstVal(attrs['Subname']) ?? null,
    };
  };

  let leader = null;
  let base = null;
  const deck = [];
  for (const entry of deckObj.cards) {
    const card = lookup(entry.cardId);
    if (!/^[A-Z]{3}_\d+$/.test(card.id ?? '')) throw new Error(`bad card id: ${card.id}`);
    if (card.type === 'Leader') {
      if (leader) throw new Error('two leaders in main list');
      leader = { id: card.id, count: 1, subtitle: card.subtitle };
    } else if (card.type === 'Base') {
      if (base) throw new Error('two bases in main list');
      base = { id: card.id, count: 1 };
    } else {
      deck.push({ id: card.id, count: entry.amount });
    }
  }
  const sideboard = [];
  for (const entry of deckObj.sideboard ?? []) {
    const card = lookup(entry.cardId);
    sideboard.push({ id: card.id, count: entry.amount });
  }

  const mainTotal = deck.reduce((s, c) => s + c.count, 0);
  const sideTotal = sideboard.reduce((s, c) => s + c.count, 0);
  if (!leader) throw new Error('no leader found');
  if (!base) throw new Error('no base found');
  if (mainTotal !== 50) throw new Error(`main deck totals ${mainTotal}, expected 50`);
  if (sideTotal > 10) throw new Error(`sideboard totals ${sideTotal}, expected <= 10`);

  return {
    name: deckObj.name,
    author: 'sw-unlimited-db.com',
    sourceUrl,
    leaderSubtitle: leader.subtitle,
    deck: {
      metadata: { name: deckObj.name, author: 'sw-unlimited-db.com (tournament list)' },
      leader: { id: leader.id, count: 1 },
      base: { id: base.id, count: 1 },
      deck,
      sideboard,
    },
  };
}

async function convertDeckPage(url) {
  const html = await fetchText(url);
  const root = unflatten(extractPayload(html));
  return convertDeck(root, url);
}

// --- leader crawl ------------------------------------------------------------

function slugSubtitleWords(slug) {
  // Everything after the leader's name is the subtitle; we can't split
  // reliably, so match on the full slug's word set instead: the deck's
  // leader subtitle words must all appear in the slug.
  return slug.split('-');
}

async function firstDeckForLeader(slug) {
  const url = `${SITE}/meta/leaders/${slug}`;
  const html = await fetchText(url);
  const ids = [...new Set([...html.matchAll(/\/decks\/(\d{5,})/g)].map((m) => m[1]))];
  if (!ids.length) throw new Error(`no deck link found on leader page ${slug}`);
  // A leader page lists several decks; take the first one that converts,
  // validates (exactly 50 main cards — some stored lists run over and the
  // engine would refuse them), and actually runs this leader.
  let lastErr = null;
  for (const id of ids.slice(0, 8)) {
    const deckUrl = `${SITE}/decks/${id}`;
    try {
      const converted = await convertDeckPage(deckUrl);
      const sub = (converted.leaderSubtitle ?? '').toLowerCase();
      if (sub) {
        const words = slugSubtitleWords(slug);
        const subWords = sub.replace(/[^a-z0-9 ]/gi, '').split(/\s+/).filter(Boolean);
        const missing = subWords.filter((w) => !words.includes(w));
        if (missing.length) {
          throw new Error(`leader mismatch: deck leader subtitle "${sub}" (missing words: ${missing.join(',')})`);
        }
      }
      return converted;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`no usable deck on leader page ${slug} (${ids.length} listed): ${lastErr?.message}`);
}

// --- main --------------------------------------------------------------------

async function main() {
  const urls = new Set(SEED_URLS);
  if (existsSync(OUT)) {
    try {
      const prev = JSON.parse(readFileSync(OUT, 'utf8'));
      for (const d of prev.decks ?? []) if (d.sourceUrl) urls.add(d.sourceUrl);
    } catch {
      log('existing community-decks.json unreadable; starting from seed');
    }
  }

  const byUrl = new Map();
  const excluded = [];
  const addDeck = (d) => {
    if (d && !byUrl.has(d.sourceUrl)) byUrl.set(d.sourceUrl, d);
  };

  for (const url of urls) {
    try {
      addDeck(await convertDeckPage(url));
      log('ok:', url);
    } catch (e) {
      log('skip:', url, '-', e.message);
      excluded.push({ sourceUrl: url, reason: e.message });
    }
  }

  if (!SEED_ONLY) {
    for (const slug of LEADER_SLUGS) {
      if (byUrl.size >= 13) break;
      try {
        const d = await firstDeckForLeader(slug);
        if (![...byUrl.values()].some((x) => x.deck.leader.id === d.deck.leader.id && x.name === d.name)) {
          addDeck(d);
          log('leader crawl ok:', slug, '->', d.sourceUrl);
        }
      } catch (e) {
        log('leader crawl skip:', slug, '-', e.message);
        excluded.push({ leaderPage: `${SITE}/meta/leaders/${slug}`, reason: e.message });
      }
    }
  }

  const decks = [...byUrl.values()].map(({ leaderSubtitle, ...rest }) => rest);
  if (decks.length === 0) {
    log('FAILED: no decks converted; existing file left untouched');
    process.exit(1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'sw-unlimited-db.com tournament meta (see community-decks.md)',
    note: 'Practice opponents for the offline app. Every deck here validated: 1 leader, 1 base, exactly 50 main cards, sideboard <= 10. Some lists stored on the source site run over 50 main cards (the site flags them legal; the game engine would refuse them) — those are recorded under "excluded" with the reason, never silently trimmed. Re-resolved by refresh-community-decks.mjs on each update run.',
    decks,
    excluded,
  };
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  renameSync(tmp, OUT);
  log(`wrote ${decks.length} decks to ${OUT}`);
}

main().catch((e) => {
  log('FAILED:', e.message);
  process.exit(1);
});
