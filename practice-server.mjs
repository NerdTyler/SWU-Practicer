// Practice page server (Stages 4 + 6) — the offline app's front door and
// single command page.
//
// A zero-dependency local web server (node:http) on http://localhost:9777.
// Stage 6 made this page the whole flow (Tyler's requirement: one page,
// clearly labeled, no lobby-link hop):
//   - YOUR DECK + BOT DECK pickers and one START button. Starting spawns
//     bot/opponent.mjs with both decks; when your browser opens the game,
//     the bot sets YOUR deck for you (change-deck API) and starts the game
//     itself — no deck picking, no ready click in the client lobby.
//   - The page then sends this window into the game (auto-navigate, with a
//     big ENTER YOUR GAME button as the manual path). The game board stays
//     in the Karabast client; come Back here after the match for:
//   - the copyable play-by-play summary of the last match,
//   - the local W/L record book (records.json, fed by the bot),
//   - a step-through replay viewer over the bot's game captures.
// Deck import (SWUDB JSON -> My Decks) still lives here too.
//
// Everything is local-only: binds 127.0.0.1, no external assets, works fully
// offline. Community decks are read live from community-decks.json.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, openSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDecks, getDeck, importDeck, validateDeck, deckName } from './decks/library.mjs';
import { summarizeRecords } from './records.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SWU_PRACTICE_PORT ?? '9777', 10);
const CLIENT_URL = (process.env.SWU_CLIENT_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const STATE_FILE = path.join(APP_DIR, 'practice-state.json');
const RECORDS_FILE = path.join(APP_DIR, 'records.json');
const SUMMARIES_DIR = path.join(APP_DIR, 'summaries');
const CAPTURES_DIR = path.join(APP_DIR, 'bot', 'captures');
const BOT_LOG = path.join(APP_DIR, 'practice-bot.log');

let botChild = null;

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function readState() {
    if (!existsSync(STATE_FILE)) return null;
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function botStatus() {
    const state = readState();
    const childAlive = !!botChild && botChild.exitCode === null && !botChild.killed;
    const alive = childAlive || pidAlive(state?.pid);
    if (state && !alive && ['starting', 'waiting', 'playing'].includes(state.status)) {
        return { alive, state: { ...state, status: 'ended' } };
    }
    return { alive, state };
}

function killBot() {
    if (botChild && botChild.exitCode === null && !botChild.killed) {
        botChild.kill('SIGTERM');
        return true;
    }
    const pid = readState()?.pid;
    if (pidAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); return true; } catch { /* raced */ }
    }
    return false;
}

function startBot({ botDeckId, yourDeckId, mode }) {
    if (mode !== 'bo1' && mode !== 'bo3') return { ok: false, error: `unknown mode: ${mode}` };
    const botDeck = getDeck(botDeckId);
    if (!botDeck) return { ok: false, error: `unknown bot deck id: ${botDeckId}` };
    const yourDeck = getDeck(yourDeckId);
    if (!yourDeck) return { ok: false, error: `unknown deck id: ${yourDeckId}` };
    for (const [label, deck] of [['bot deck', botDeck], ['your deck', yourDeck]]) {
        const v = validateDeck(deck);
        if (!v.ok) return { ok: false, error: `${label} fails validation: ${v.errors.join('; ')}` };
    }
    killBot();
    try { writeFileSync(STATE_FILE, JSON.stringify({ status: 'starting', botDeck: deckName(botDeckId), yourDeck: deckName(yourDeckId), mode }) + '\n'); } catch { /* best effort */ }
    const logFd = openSync(BOT_LOG, 'a');
    botChild = spawn(process.execPath, [
        path.join(APP_DIR, 'bot', 'opponent.mjs'),
        '--deck-id', botDeckId,
        '--human-deck-id', yourDeckId,
        '--mode', mode,
        '--state-file', STATE_FILE,
        '--records-file', RECORDS_FILE,
        '--summaries-dir', SUMMARIES_DIR,
        '--client-url', CLIENT_URL,
    ], { cwd: path.join(APP_DIR, 'bot'), stdio: ['ignore', logFd, logFd], detached: false });
    botChild.on('error', (e) => console.error('practice bot spawn error:', e));
    return { ok: true, botDeck: deckName(botDeckId), yourDeck: deckName(yourDeckId), mode };
}

// ---- replay -------------------------------------------------------------
// Capture format (bot/bot.mjs): one JSON object per line,
// { t, side, event, data } with event in lobbystate | gamestate-meta |
// messages (data.lines = rendered play-by-play lines) | prompt
// (data = { promptState, myPiles, allPiles }) | answer (data = the emit
// args) | no-answer-found.
function summarizeAllPiles(allPiles) {
    const out = [];
    for (const [player, zones] of Object.entries(allPiles ?? {})) {
        for (const [zone, cards] of Object.entries(zones ?? {})) {
            if (!Array.isArray(cards) || !cards.length) continue;
            const names = cards.slice(0, 12).map((c) => c.name ?? c.id ?? '?');
            out.push(`${player} ${zone}(${cards.length}): ${names.join(', ')}${cards.length > 12 ? ', …' : ''}`);
        }
    }
    return out.join('\n');
}

function buildReplay(file) {
    const records = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const steps = [];
    const logLines = [];
    let phase = null;
    let uuidNames = new Map();
    const describe = (data) => JSON.stringify(data, (k, v) => (typeof v === 'string' && uuidNames.has(v) ? uuidNames.get(v) : v)).slice(0, 500);
    for (const rec of records) {
        if (rec.event === 'gamestate-meta') {
            phase = rec.data?.phase ?? phase;
        } else if (rec.event === 'messages') {
            for (const l of rec.data?.lines ?? []) logLines.push(l);
        } else if (rec.event === 'prompt') {
            uuidNames = new Map();
            const collect = (zones) => {
                for (const cards of Object.values(zones ?? {})) {
                    for (const c of cards ?? []) if (c?.uuid) uuidNames.set(c.uuid, c.name ?? c.id ?? c.uuid);
                }
            };
            collect(rec.data?.myPiles);
            for (const zones of Object.values(rec.data?.allPiles ?? {})) collect(zones);
            steps.push({
                n: steps.length + 1, side: rec.side, phase,
                promptType: rec.data?.promptState?.promptTitle ?? rec.data?.promptState?.promptType ?? 'prompt',
                piles: summarizeAllPiles(rec.data?.allPiles),
                msgCount: logLines.length,
                answer: null,
            });
        } else if (rec.event === 'answer' || rec.event === 'no-answer-found') {
            const step = [...steps].reverse().find((s) => s.side === rec.side && !s.answer) ?? steps[steps.length - 1];
            if (step) step.answer = rec.event === 'answer' ? describe(rec.data) : '(the bot found no answer for this prompt)';
        }
    }
    return { steps, lines: logLines };
}

// ---- page ---------------------------------------------------------------
const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>SWU Practice</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; background:#111; color:#eee; }
  h1 { font-size: 1.5rem; margin-bottom: .2rem; } h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #444; padding-bottom: .3rem; }
  select, input, textarea, button { font: inherit; background:#222; color:#eee; border:1px solid #555; border-radius:6px; padding:.45rem .6rem; }
  textarea { width: 100%; height: 120px; box-sizing: border-box; }
  button { cursor: pointer; background:#2b4c7e; border-color:#2b4c7e; }
  button.secondary { background:#333; border-color:#555; }
  button.big { font-size: 1.25rem; padding: .8rem 2rem; }
  .row { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin:.6rem 0; }
  .picker { border:1px solid #333; border-radius:8px; padding:.8rem; background:#181818; flex:1; min-width:300px; }
  .picker h3 { margin:.1rem 0 .5rem; font-size:1.05rem; }
  .deck { padding:.5rem .7rem; border:1px solid #333; border-radius:8px; margin:.4rem 0; background:#181818; }
  .meta { color:#aaa; font-size:.85rem; }
  .ok { color:#7dd87d; } .err { color:#ff8080; } a { color:#8db8ff; }
  #gameBox { border:1px solid #2b4c7e; border-radius:8px; padding:1rem; margin-top:1rem; display:none; background:#141c28; }
  #enterBtn { display:none; font-size:1.3rem; padding:.9rem 2.2rem; background:#2e7d32; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; }
  pre { background:#0a0a0a; border:1px solid #333; border-radius:8px; padding:.8rem; white-space:pre-wrap; word-break:break-word; max-height:480px; overflow:auto; font-size:.82rem; }
  .over { color:#ffb84d; }
</style></head><body>
<h1>Star Wars: Unlimited — Practice</h1>
<p class="meta">One page, whole match: pick your deck and the bot's deck, press Start, and you are dropped straight into the game — your deck is set for you, no lobby steps. After the match, come Back to this page for the play-by-play summary and your record book.</p>

<h2>New match</h2>
<div class="row" style="align-items:stretch">
  <div class="picker"><h3>YOUR DECK</h3>
    <select id="yourDeck" style="width:100%"></select>
    <div class="meta" style="margin-top:.4rem">Set for you automatically when the game opens.</div>
  </div>
  <div class="picker"><h3>BOT DECK</h3>
    <select id="botDeck" style="width:100%"></select>
    <div class="meta" style="margin-top:.4rem">The deck the practice bot plays against you.</div>
  </div>
</div>
<div class="row">
  <label><input type="radio" name="mode" value="bo1" checked> Best of 1</label>
  <label><input type="radio" name="mode" value="bo3"> Best of 3 (sideboard between games, in the game window)</label>
</div>
<div class="row">
  <label for="turnTarget">Turn clock target (minutes, display only — nothing is enforced):</label>
  <input id="turnTarget" type="number" min="0" step="0.5" style="width:5.5rem" placeholder="off">
</div>
<div class="row">
  <button id="startBtn" class="big">START GAME</button>
  <span id="startMsg"></span>
</div>

<div id="gameBox">
  <div id="gameStatus" style="font-size:1.1rem"></div>
  <div id="gameClock" class="meta" style="margin:.4rem 0"></div>
  <div class="row"><a id="enterBtn" href="#">ENTER YOUR GAME</a></div>
  <div class="meta" id="gameHint"></div>
  <div class="row"><button id="stopBtn" class="secondary">Stop this match</button></div>
</div>

<h2>Last match — play-by-play summary</h2>
<div class="row"><button id="copySummary" class="secondary">Copy play-by-play</button><span id="summaryMsg" class="meta"></span></div>
<pre id="summaryPre">No match summary yet — finish a game and it appears here.</pre>

<h2>Record book</h2>
<div id="recordsBox" class="meta">No games recorded yet.</div>
<div class="row"><button id="refreshRecords" class="secondary">Refresh</button></div>

<h2>Replay a bot game</h2>
<p class="meta">Step through a recorded bot game prompt by prompt (from the bot's seat captures). Pick a capture and step with Prev/Next.</p>
<div class="row"><select id="captureSel"></select><button id="loadReplay" class="secondary">Load replay</button><span id="replayMsg" class="meta"></span></div>
<div id="replayBox" style="display:none">
  <div class="row"><button id="repPrev" class="secondary">&larr; Prev</button><span id="repInfo"></span><button id="repNext" class="secondary">Next &rarr;</button></div>
  <pre id="repPiles"></pre>
  <div class="meta">Play-by-play up to this step:</div>
  <pre id="repLog"></pre>
</div>

<h2>Import a deck</h2>
<p class="meta">Paste a deck in SWUDB JSON format (swudb.com / HoloScan export). It is validated against the local card data and saved into My Decks, so it persists.</p>
<div class="row"><input id="importName" placeholder="Deck name, e.g. My Vader Variant" size="34"></div>
<textarea id="importJson" placeholder='{"leader":{"id":"LAW_011","count":1},"base":{"id":"LAW_021","count":1},"deck":[{"id":"...","count":3}],"sideboard":[]}'></textarea>
<div class="row"><button id="importBtn">Import deck</button><span id="importMsg"></span></div>

<h2>My Decks</h2>
<div id="myDecks"></div>

<h2>Community Decks <span class="meta">(tournament lists, refreshed by the updater)</span></h2>
<div id="communityDecks"></div>

<script>
var $ = function (id) { return document.getElementById(id); };
var decks = { mine: [], community: [] };
var lastState = null;
var armed = false;          // this page started the current match
var navigatedFor = null;    // lobbyId we already auto-navigated into
var lastSummaryFile = null;
var replay = null, repIdx = 0;

function fillPicker(sel, selectedId) {
  sel.innerHTML = '';
  var mk = function (label, list) { var g = document.createElement('optgroup'); g.label = label; for (var i = 0; i < list.length; i++) { var o = document.createElement('option'); o.value = list[i].id; o.textContent = list[i].name; g.appendChild(o); } sel.appendChild(g); };
  mk('My Decks', decks.mine); mk('Community Decks', decks.community);
  if (selectedId) sel.value = selectedId;
}

function loadDecks() {
  fetch('/api/decks').then(function (r) { return r.json(); }).then(function (j) {
    decks = j;
    var yourDefault = (decks.mine[0] || decks.community[0] || {}).id;
    var botDefault = null;
    for (var i = 0; i < decks.community.length; i++) { if (decks.community[i].id !== yourDefault) { botDefault = decks.community[i].id; break; } }
    if (!botDefault) botDefault = (decks.community[0] || decks.mine[0] || {}).id;
    fillPicker($('yourDeck'), yourDefault);
    fillPicker($('botDeck'), botDefault);
    var render = function (list, el) { el.innerHTML = ''; for (var k = 0; k < list.length; k++) { (function (d) {
      var div = document.createElement('div'); div.className = 'deck';
      div.innerHTML = '<b></b> <span class="meta"></span>';
      div.querySelector('b').textContent = d.name;
      var s = d.summary || {};
      div.querySelector('.meta').textContent = 'leader ' + (s.leader || '?') + ' · base ' + (s.base || '?') + ' · ' + (s.main || '?') + ' cards' + (s.sideboard ? ' + ' + s.sideboard + ' sideboard' : '');
      var row = document.createElement('div'); row.className = 'row';
      var play = document.createElement('button'); play.className = 'secondary'; play.textContent = 'Play this';
      play.onclick = function () { $('yourDeck').value = d.id; window.scrollTo({ top: 0, behavior: 'smooth' }); };
      var bot = document.createElement('button'); bot.className = 'secondary'; bot.textContent = 'Bot plays this';
      bot.onclick = function () { $('botDeck').value = d.id; window.scrollTo({ top: 0, behavior: 'smooth' }); };
      var copy = document.createElement('button'); copy.className = 'secondary'; copy.textContent = 'Copy deck JSON';
      copy.onclick = function () { fetch('/api/deck?id=' + encodeURIComponent(d.id)).then(function (r) { return r.json(); }).then(function (dj) { navigator.clipboard.writeText(JSON.stringify(dj)); copy.textContent = 'Copied!'; setTimeout(function () { copy.textContent = 'Copy deck JSON'; }, 1500); }); };
      row.appendChild(play); row.appendChild(bot); row.appendChild(copy); div.appendChild(row); el.appendChild(div);
    })(list[k]); } };
    render(decks.mine, $('myDecks')); render(decks.community, $('communityDecks'));
  });
}

function fmtDur(ms) {
  if (ms == null || ms < 0) return '0:00';
  var s = Math.floor(ms / 1000); var m = Math.floor(s / 60); s = s % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function pollStatus() {
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    lastState = s.state;
    var st = s.state;
    if (!st) { $('gameBox').style.display = 'none'; return; }
    $('gameBox').style.display = 'block';
    var status = st.status, phase = st.phase;
    var line = '', hint = '';
    if (status === 'starting') { line = 'Setting up your game…'; }
    else if (status === 'waiting') {
      line = st.humanDeckSet ? 'You are in — the game is starting…' : 'Your game is set up: you (' + (st.yourDeck || '?') + ') vs bot (' + (st.botDeck || '?') + ').';
      hint = 'Press ENTER YOUR GAME — your deck is set for you and the match starts by itself. No deck picking, no ready button.';
    }
    else if (status === 'playing') {
      line = 'Game in progress' + (st.mode === 'bo3' ? ' — game ' + (st.gameNumber || 1) + ' of the series' : '') + '.';
      if (st.series) line += ' Series score — you ' + st.series.human + ' · bot ' + st.series.bot + '.';
      hint = 'If this window lost the game (closed tab, crash), ENTER YOUR GAME rejoins your seat — reconnect within about 20 seconds of a drop and you land right back in the game.';
    }
    else if (status === 'finished' && phase === 'betweengames') { line = 'Between games — sideboard in the game window; the next game starts when both sides confirm.'; }
    else if (status === 'finished') {
      line = 'Match finished' + (st.lastWinner ? ' — winner: ' + st.lastWinner : '') + '.';
      if (st.series) line += ' Series — you ' + st.series.human + ' · bot ' + st.series.bot + '.';
      hint = 'The bot is still in the lobby: hit Rematch in the game window for another game with the same decks, or start a fresh match here.';
    }
    else if (status === 'expired') { line = 'The last lobby expired (nobody joined in time). Start a new match any time.'; }
    else if (status === 'stalled') { line = 'The last game stalled and the bot left. Start a new match any time.'; }
    else if (status === 'ended') { line = 'The last match ended.'; }
    $('gameStatus').textContent = line;
    $('gameHint').textContent = hint;
    var showEnter = !!st.joinUrl && (status === 'waiting' || status === 'playing');
    $('enterBtn').style.display = showEnter ? 'inline-block' : 'none';
    if (st.joinUrl) $('enterBtn').href = st.joinUrl;
    // Clock: match time + whose move the bot is waiting on.
    var clock = '';
    if (st.gameStartedAt) {
      var end = st.lastActionAt || st.gameStartedAt;
      clock = 'Match time ' + fmtDur(end - st.gameStartedAt);
      if (status === 'playing' && st.lastActionAt) {
        var idleMs = Date.now() - st.lastActionAt;
        clock += ' · last action ' + fmtDur(idleMs) + ' ago · waiting on ' + (st.waitingOn === 'bot' ? 'the bot' : 'you');
        var targetMin = parseFloat($('turnTarget').value);
        if (!isNaN(targetMin) && targetMin > 0 && idleMs > targetMin * 60000) clock += ' — over your ' + targetMin + ' min target (display only)';
      }
    }
    $('gameClock').textContent = clock;
    // Auto-send this window into the game once it is live (only for a
    // match started from this page view; the button covers every other
    // case, e.g. after using Back).
    if (armed && st.joinUrl && status === 'playing' && navigatedFor !== st.lobbyId) {
      navigatedFor = st.lobbyId;
      setTimeout(function () { location.href = st.joinUrl; }, 900);
    }
    if (status === 'finished') { armed = false; loadSummary(st); refreshRecords(); }
  }).catch(function () { /* next poll retries */ });
}

function loadSummary(st) {
  if (!st.summaryFile || st.summaryFile === lastSummaryFile) return;
  lastSummaryFile = st.summaryFile;
  var base = st.summaryFile.split('/').pop();
  fetch('/api/summary?file=' + encodeURIComponent(base)).then(function (r) { return r.text(); }).then(function (t) {
    $('summaryPre').textContent = t;
    $('summaryMsg').textContent = '';
  }).catch(function () { /* ignore */ });
}

$('copySummary').onclick = function () {
  navigator.clipboard.writeText($('summaryPre').textContent).then(function () {
    $('summaryMsg').textContent = 'Copied.';
    setTimeout(function () { $('summaryMsg').textContent = ''; }, 1500);
  });
};

function refreshRecords() {
  fetch('/api/records').then(function (r) { return r.json(); }).then(function (j) {
    var box = $('recordsBox');
    var sm = j.summary;
    if (!sm || !sm.totalGames) { box.textContent = 'No games recorded yet.'; return; }
    var o = sm.overall, sr = sm.series;
    var rate = sm.totalGames ? Math.round(100 * o.wins / sm.totalGames) : 0;
    var html = '<div>Overall vs the bot: <b>' + o.wins + ' W – ' + o.losses + ' L</b> (' + sm.totalGames + ' games, ' + rate + '% wins)</div>';
    if (sm.totalSeries > 0) html += '<div>Best-of-3 series: <b>' + sr.wins + ' won – ' + sr.losses + ' lost</b> (' + sm.totalSeries + ' played)</div>';
    var by = function (title, list) {
      if (!list || !list.length) return '';
      var out = '<div style="margin-top:.4rem"><b>' + title + '</b></div>';
      for (var i = 0; i < list.length; i++) { out += '<div>' + String(list[i].name).replace(/</g, '&lt;') + ' — ' + list[i].wins + ' W – ' + list[i].losses + ' L</div>'; }
      return out;
    };
    html += by('By your deck', sm.byHumanDeck) + by('By bot deck', sm.byBotDeck);
    if (sm.recent && sm.recent.length) {
      html += '<div style="margin-top:.4rem"><b>Recent results</b></div>';
      for (var i = 0; i < sm.recent.length; i++) { var e = sm.recent[i];
        var when = e.recordedAt ? new Date(e.recordedAt).toLocaleString() : '';
        var what = e.kind === 'series' ? 'Series' : ('Game ' + (e.gameNumber || 1));
        html += '<div>' + when + ' · ' + (e.mode === 'bo3' ? 'Bo3' : 'Bo1') + ' · ' + what + ' · You (' + (e.humanDeck || '?') + ') vs Bot (' + (e.botDeck || '?') + ') — <b>' + (e.winnerSide === 'human' ? 'you won' : 'bot won') + '</b></div>';
      }
    }
    box.innerHTML = html;
  }).catch(function () { /* ignore */ });
}
$('refreshRecords').onclick = refreshRecords;

function loadCaptures() {
  fetch('/api/captures').then(function (r) { return r.json(); }).then(function (j) {
    var sel = $('captureSel'); sel.innerHTML = '';
    for (var i = 0; i < j.length; i++) { var o = document.createElement('option'); o.value = j[i].name; o.textContent = j[i].name + ' (' + Math.round(j[i].size / 1024) + ' KB)'; sel.appendChild(o); }
    if (!j.length) { var o2 = document.createElement('option'); o2.textContent = 'no captures yet'; sel.appendChild(o2); }
  });
}

function renderReplayStep() {
  if (!replay || !replay.steps.length) return;
  var step = replay.steps[repIdx];
  $('repInfo').textContent = 'Step ' + (repIdx + 1) + ' of ' + replay.steps.length + ' — ' + step.side + ' · ' + (step.phase || '') + ' · ' + step.promptType;
  $('repPiles').textContent = (step.piles || '(no cards)') + (step.answer ? '\\n\\nAnswer: ' + step.answer : '');
  var upto = replay.lines.slice(0, step.msgCount);
  $('repLog').textContent = upto.slice(-16).join('\\n') || '(no play-by-play yet)';
}
$('loadReplay').onclick = function () {
  var f = $('captureSel').value;
  if (!f) return;
  $('replayMsg').textContent = 'Loading…';
  fetch('/api/replay?file=' + encodeURIComponent(f)).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { $('replayMsg').textContent = j.error || 'failed'; return; }
    replay = j; repIdx = 0; $('replayBox').style.display = 'block'; $('replayMsg').textContent = j.steps.length + ' steps';
    renderReplayStep();
  }).catch(function () { $('replayMsg').textContent = 'failed to load'; });
};
$('repPrev').onclick = function () { if (repIdx > 0) { repIdx--; renderReplayStep(); } };
$('repNext').onclick = function () { if (replay && repIdx < replay.steps.length - 1) { repIdx++; renderReplayStep(); } };

$('startBtn').onclick = function () {
  var mode = document.querySelector('input[name="mode"]:checked').value;
  $('startMsg').textContent = 'Starting…';
  fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botDeckId: $('botDeck').value, yourDeckId: $('yourDeck').value, mode: mode }) }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.ok) {
      armed = true; navigatedFor = null; lastSummaryFile = null;
      $('startMsg').innerHTML = '<span class="ok">Setting up: you (' + j.yourDeck + ') vs bot (' + j.botDeck + '), ' + (j.mode === 'bo3' ? 'best of 3' : 'best of 1') + ' — this window goes into the game by itself.</span>';
    } else { $('startMsg').innerHTML = '<span class="err">' + j.error + '</span>'; }
    pollStatus();
  });
};

$('stopBtn').onclick = function () {
  fetch('/api/stop', { method: 'POST' }).then(function () { armed = false; pollStatus(); });
};

$('importBtn').onclick = function () {
  var name = $('importName').value.trim();
  if (!name) { $('importMsg').innerHTML = '<span class="err">Give the deck a name first.</span>'; return; }
  var parsed; try { parsed = JSON.parse($('importJson').value); } catch (e) { $('importMsg').innerHTML = '<span class="err">That is not valid JSON.</span>'; return; }
  fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, deck: parsed }) }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.ok) { $('importMsg').innerHTML = '<span class="ok">Imported as “' + j.entry.name + '”.</span>'; $('importJson').value = ''; $('importName').value = ''; loadDecks(); }
    else { $('importMsg').innerHTML = '<span class="err">' + (j.errors || [j.error]).join('<br>') + '</span>'; }
  });
};

loadDecks(); loadCaptures(); refreshRecords(); pollStatus(); setInterval(pollStatus, 2500);
</script></body></html>`;

// ---- http ---------------------------------------------------------------
function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function safeBasename(name) {
    const base = path.basename(String(name ?? ''));
    return base === String(name ?? '') ? base : null;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(PAGE);
        } else if (req.method === 'GET' && url.pathname === '/api/decks') {
            sendJson(res, 200, listDecks());
        } else if (req.method === 'GET' && url.pathname === '/api/deck') {
            const deck = getDeck(url.searchParams.get('id'));
            if (!deck) return sendJson(res, 404, { error: 'unknown deck id' });
            sendJson(res, 200, deck);
        } else if (req.method === 'GET' && url.pathname === '/api/status') {
            sendJson(res, 200, botStatus());
        } else if (req.method === 'GET' && url.pathname === '/api/records') {
            sendJson(res, 200, { summary: summarizeRecords(RECORDS_FILE) });
        } else if (req.method === 'GET' && url.pathname === '/api/summary') {
            const base = safeBasename(url.searchParams.get('file'));
            if (!base || !base.endsWith('.txt')) return sendJson(res, 400, { error: 'bad file' });
            const file = path.join(SUMMARIES_DIR, base);
            if (!existsSync(file)) return sendJson(res, 404, { error: 'no such summary' });
            const text = readFileSync(file, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(text.slice(0, 400_000));
        } else if (req.method === 'GET' && url.pathname === '/api/captures') {
            const files = existsSync(CAPTURES_DIR) ? readdirSync(CAPTURES_DIR)
                .filter((f) => f.endsWith('.jsonl'))
                .map((f) => ({ name: f, size: statSync(path.join(CAPTURES_DIR, f)).size, mtime: statSync(path.join(CAPTURES_DIR, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime).slice(0, 50) : [];
            sendJson(res, 200, files);
        } else if (req.method === 'GET' && url.pathname === '/api/replay') {
            const base = safeBasename(url.searchParams.get('file'));
            if (!base || !base.endsWith('.jsonl')) return sendJson(res, 400, { ok: false, error: 'bad file' });
            const file = path.join(CAPTURES_DIR, base);
            if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: 'no such capture' });
            sendJson(res, 200, { ok: true, ...buildReplay(file) });
        } else if (req.method === 'POST' && url.pathname === '/api/import') {
            const body = JSON.parse(await readBody(req));
            if (!body.name || !body.deck) return sendJson(res, 400, { ok: false, error: 'name and deck are required' });
            const result = importDeck(String(body.name), body.deck);
            sendJson(res, result.ok ? 200 : 422, result);
        } else if (req.method === 'POST' && url.pathname === '/api/start') {
            const body = JSON.parse(await readBody(req));
            if (!body.botDeckId || !body.yourDeckId) return sendJson(res, 400, { ok: false, error: 'botDeckId and yourDeckId are required' });
            const result = startBot({ botDeckId: String(body.botDeckId), yourDeckId: String(body.yourDeckId), mode: String(body.mode ?? 'bo1') });
            sendJson(res, result.ok ? 200 : 422, result);
        } else if (req.method === 'POST' && url.pathname === '/api/stop') {
            sendJson(res, 200, { ok: true, killed: killBot() });
        } else {
            sendJson(res, 404, { error: 'not found' });
        }
    } catch (e) {
        sendJson(res, 500, { error: String(e?.message ?? e) });
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`SWU practice page: http://localhost:${PORT} (client: ${CLIENT_URL})`);
});
