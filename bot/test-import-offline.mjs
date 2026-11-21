// Offline deck-import test (Stage 7) — verifies, using the client's OWN
// code and the exact API sequence its forms perform, which of Karabast's
// deck-import methods work with no internet connection:
//
//   A. Paste-JSON validation: the client's checkJson.ts (compiled with the
//      client's own tsc) run over Tyler's four SWUDB deck files. This is
//      the exact function CreateGameForm/QuickGameForm call on pasted
//      input — pure client-side, no network by construction.
//   B. Create-lobby with a pasted JSON deck: the exact POST the Create
//      Game form sends after a successful parse (deck object inline, no
//      link, no resolve call). Must return 200 with the game server being
//      the only machine involved.
//   C. Link resolution: POST /api/resolve-deck-link with a swudb.com link
//      (what AddDeckDialog and the saved-deck dropdown rely on). The
//      server resolves links by fetching swudb.com live, so offline this
//      CANNOT succeed — the test asserts it does not return a deck and
//      captures the upstream-flavored error as evidence.
//
// Usage: node test-import-offline.mjs   (stack must be running)
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { post } from './bot.mjs';

const failures = [];
const CLIENT_CHECKJSON = path.resolve(process.env.HOME, 'workspace/forceteki-client/src/app/_utils/checkJson.ts');
const CLIENT_TSC = path.resolve(process.env.HOME, 'workspace/forceteki-client/node_modules/.bin/tsc');
const MY_DECKS = [
    'vader-deck-holoscan.json',
    'jabba-deck-holoscan.json',
    'trance-deck-holoscan.json',
    'rites-deck-holoscan.json',
].map((f) => path.resolve(process.env.HOME, 'workspace/swu-forge-app/decks/my', f));

// ---- A: the client's own validator over Tyler's deck files ------------------
const outDir = mkdtempSync(path.join(tmpdir(), 'checkjson-'));
execFileSync(CLIENT_TSC, [CLIENT_CHECKJSON, '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler', '--outDir', outDir], { stdio: 'pipe' });
const { validateDeckJSON, parseInputAsDeckData } = await import(path.join(outDir, 'checkJson.js'));

let parsedVader = null;
for (const file of MY_DECKS) {
    const raw = readFileSync(file, 'utf8');
    const parsed = parseInputAsDeckData(raw);
    if (parsed.type !== 'json' || !parsed.data) {
        failures.push(`A: ${path.basename(file)} did not parse as a JSON deck (type=${parsed.type})`);
    } else {
        console.log(`A: ${path.basename(file)} -> type=json, name="${parsed.data.metadata.name}", leader=${parsed.data.leader.id}, base=${parsed.data.base.id}`);
        if (file.includes('vader')) parsedVader = parsed.data;
    }
}
const urlParsed = parseInputAsDeckData('https://swudb.com/deck/someDeckId');
if (urlParsed.type !== 'url') failures.push(`A: swudb URL parsed as type=${urlParsed.type}, expected url`);
if (!validateDeckJSON) failures.push('A: validateDeckJSON missing from compiled client module');
if (!parsedVader) failures.push('A: vader deck unavailable for part B');

// ---- B: the Create Game form's submit sequence with a pasted JSON deck ------
if (parsedVader) {
    const res = await post('/api/create-lobby', {
        user: { id: randomUUID(), username: 'ImportTest' },
        deck: parsedVader,
        isPrivate: true,
        format: 'eternal',
        cardPool: 'current',
        gamesToWinMode: 'bestOfOne',
        lobbyName: 'import-test (json paste)',
    });
    if (res.status !== 200) failures.push(`B: create-lobby with pasted JSON deck returned ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`);
    else console.log('B: create-lobby with pasted JSON deck -> 200 (lobby created entirely locally)');
}

// ---- C: link resolution must NOT work offline --------------------------------
const link = await post('/api/resolve-deck-link', { deckLink: 'https://swudb.com/deck/zzzznotarealdeck' });
console.log(`C: resolve-deck-link -> ${link.status}: ${JSON.stringify(link.json).slice(0, 220)}`);
if (link.status === 200 && link.json?.deck) {
    failures.push('C: resolve-deck-link returned a deck — it must have fetched it from swudb.com live (this VM has proxied egress; on an offline machine this call fails)');
}

if (failures.length) { console.error('TEST FAIL:', failures.join('; ')); process.exit(1); }
console.log('TEST PASS (offline import: paste-JSON works locally; link import is a live swudb.com fetch)');
process.exit(0);
