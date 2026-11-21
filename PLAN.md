# SWU Offline Practice App ("Forge for Star Wars: Unlimited") — build plan

Requested by Tyler, 2026-11-20. Goal: a macOS app like Forge (the Magic app) but for
Star Wars: Unlimited — launch it, play his decks against an AI, fully offline.

## Tyler's spec (his words, 2026-11-20)
- Offline app for macOS to play Star Wars: Unlimited against an AI, "like Forge".
- Cards drawn from the online database (card data + art from the SWU card DB).
- Rules and cards must be able to UPDATE as the game ages: a script checks for
  updates automatically when the application launches (when online), then the
  app runs offline for practice.
- Prefer ONE file to launch (he doesn't mind the internals; one launcher).
- Include an IMPORT section for decks (his SWUDB JSON files).
- Include a list of TOP COMMUNITY DECK BUILDS as a selectable option (dropdown) —
  decks to pick from / practice against, refreshed by the updater.

## Foundation (verified 2026-11-20)
- Engine: Forceteki (github.com/SWU-Karabast/forceteki) — Karabast's open-source
  SWU rules engine, MIT, actively maintained. Needs Node >=26.12.1 <27.
- Client: forceteki-client (Next.js, serves at localhost:3000, socket.io to engine).
- Card data: `npm run get-cards` in forceteki downloads card definitions from the
  online card database. Card art comes from the card CDN; pre-cache for offline.
- NO AI ships with the stack (Karabast is PvP) — the bot is custom work:
  a socket client that answers engine prompts with heuristics (Forge-AI tier).

## Stage 1 — DONE on Gord's VM (2026-11-20)
- Node v26.13.1 installed at ~/workspace/node26 (tarball; extract with --no-same-owner).
- forceteki: npm install OK; `npm run get-cards` downloaded 2,560 card definition
  files to forceteki/test/json/ (from the online card DB — Tyler's requirement, proven).
- Build needs a bigger heap on small machines: NODE_OPTIONS=--max-old-space-size=5120
  or tsc dies with a JavaScript heap OOM. Same fix will apply on the 8 GB MacBook Air.
- Server: `npm run dev` (auto-creates .env, builds, then serves) — healthy at
  http://localhost:9500/api/health -> {"success":true}. Warnings about missing
  Discord/AWS/SWUStats keys are optional external services; irrelevant locally.
  The build-dev copy step takes ~2-3 min at 0% CPU before the server answers — be patient.
- Client: npm install OK (npm blocked some postinstall scripts — esbuild etc.;
  harmless so far). .env.local needs NEXT_PUBLIC_ROOT_URL=http://localhost:9500,
  NEXTAUTH_URL=http://localhost:3000, and NEXTAUTH_SECRET copied from the server's
  auto-generated .env. `npm run dev` serves the Karabast home page at
  http://localhost:3000 (HTTP 200). First page compile is slow on small CPUs.
- Still open for later stages: local login flow (NextAuth/Dynamo in prod; dev mode
  behavior TBD), card art caching for offline, the bot, packaging.

## Stage 2 recon (2026-11-20) — bot design settled
- Protocol: the web client holds ONE socket.io connection to the game server
  (NEXT_PUBLIC_ROOT_URL, :9500). Server -> client events: `gamestate`, `lobbystate`,
  `queueHeartbeat`, `matchmakingFailed`. Client -> server: two channels,
  emit('lobby', <msg>, ...) and emit('game', <msg>, ...) (see forceteki-client
  src/app/_contexts/Game.context.tsx, sendGameMessage ~line 459).
- Anonymous users are a first-class server concept (server/utils/user/UserFactory.ts
  creates AnonymousUser with generated ID + name; Lobby.ts references anonymous
  senders/opponents). Local play should not need real accounts/DynamoDB.
- The engine's own tests drive full games programmatically
  (test/helpers/PlayerInteractionWrapper.ts: clickCard/clickPrompt) — proof the
  prompt model is machine-answerable.
- BOT PLAN: a standalone Node program using socket.io-client that connects like a
  second web client, joins/creates the lobby game, and answers `gamestate` prompts
  with heuristics: mulligan (keep curve), resource (shed highest-cost/least-useful),
  play units on curve, attack (favorable trades, else base), deploy leader on time,
  resolve optional prompts by simple value rules, pass when nothing useful remains.
  Forge-tier: legal + sensible, beatable.

## Stage 2 protocol map — COMPLETE (2026-11-20)
- Socket: io(ROOT_URL, { path: '/ws', query: { user: JSON{id, username},
  lobby: JSON{lobbyId}, spectator: 'false' } }). Signed-in users send auth:{token};
  ANONYMOUS users send only the query identity — no token, no account. The bot
  connects as anonymous username e.g. "Practice Bot".
- 'game' channel answers (from client callers): ['cardClicked', cardUuid];
  [button.command, button.arg, button.uuid] — prompt buttons carry their own
  command/arg/uuid in the gamestate; ['menuButton', value, uuid] for dropdowns/
  numbers; ['chat', text]; ['concede', name]. So the bot loop = read my prompt
  from each `gamestate` event, pick a button or card by heuristic, emit it back.
- 'lobby' channel: 'setReadyStatus', 'startGameAsync', 'updateDeck' ('Deck'|'Sideboard',
  cardId), 'rematch', 'sendChatMessage', 'updateSetting'.
- HTTP API on the game server: POST /api/create-user (NO auth — local provisioning
  for both human and bot), POST /api/join-lobby {lobbyId, user}, GET
  /api/available-lobbies, POST /api/lobby/:lobbyId/change-deck, deck CRUD
  (/api/get-decks, /api/save-deck, /api/resolve-deck-link). Dev-only:
  /api/test-game-setups + /api/start-test-game load saved game-state files
  (debugging tool, NOT an AI opponent).
- PROBE RESULTS (2026-11-20, bot/probe.mjs — full flow WORKS against the VM server):
  * POST /api/create-lobby {user:{id,username}, deck:<SWUDB JSON>, isPrivate:true,
    format:'eternal', cardPool:'current', gamesToWinMode:'bestOfOne', lobbyName}
    -> 200. NOTE: cardPool 'unlimited' is REJECTED for eternal (contract assert);
    'current' is the Eternal pairing. SWUDB-format deck JSON (Tyler's files) is
    accepted as-is by the `deck` field.
  * Server IGNORES client-supplied anonymous usernames — it assigns its own
    ("anonymous xxxxxx"); the client-supplied id is honored.
  * Host discovers its lobbyId from the first `lobbystate` after socket connect
    (connect with lobbyId null). Joiner: POST /api/join-lobby {lobbyId, user},
    THEN socket connect, THEN POST /api/lobby/:id/change-deck {user, deck} —
    change-deck fails "user not found in lobby" if called before the socket
    connects. Lobby start refuses a deckless player ("invalid deck size").
  * Both ready (emit 'lobby','setReadyStatus',true) + host emit
    ('lobby','startGameAsync') -> game starts; `gamestate` flows to both sockets.
  * GAMESTATE SHAPE: players[<id>].promptState = {menuTitle, promptTitle,
    promptType, buttons:[{text, arg, command, uuid}], displayCards,
    perCardButtons, dropdownListOptions, selectOrder, promptUuid}. Each socket
    gets its own view (hidden info protected). First real prompt captured:
    promptType 'initiative', buttons Yourself/Opponent with command 'menuButton' —
    answer = emit('game', button.command, button.arg, button.uuid).
  * Captures in bot/captures/*.jsonl. NEXT: write bot.mjs — auto-answer prompts
    (v1 heuristics keyed on promptType/menuTitle), prove a full game completes
    bot-vs-bot, then wire the human seat via the web client.

## Tyler add-on request (2026-11-20 18:06): Nostr identity layer
Tyler asked for: (1) login with his Nostr account, (2) deck/card backup tied to
that login, (3) playing against people over Nostr. "If that is too much then
disregard." Feasibility, verified against the source:
- LOGIN — YES, clean. The game server only verifies a NextAuth session JWT
  against NEXTAUTH_SECRET (server/utils/user/UserFactory.ts ~line 206). Any
  NextAuth provider works with ZERO server changes. Nostr login = a credentials
  provider verifying a signed challenge event (signer-based: NIP-07/NIP-46 —
  the key never enters the app).
- BACKUP — YES, and better than stock: stock deck saving uses DynamoDB
  (server/utils/deck/DeckService.ts). Nostr-native design: publish each deck as
  a signed replaceable event (app-data kind) to relays; login anywhere with the
  key -> decks pull down. Backup lives on relays, not in the app's local DB.
- PLAY VS PEOPLE — PARTIAL. Nostr = identity (kind:0 name/avatar) + invite
  layer (signed open-game events / shareable lobby links) works. The MATCH
  still runs on a game server both players can reach — relays are store-and-
  forward mailboxes, not a real-time game wire. Home/Tailscale: fine as-is.
  Open internet: server needs a tunnel or small VPS (hosting choice, not code).
- SECURITY (Tyler's own threat model): his @Argutus nsec is compromised/public.
  Login must be signer-based only, and he should use a FRESH keypair in a
  signer for this — never the compromised key, never pasted anywhere.
- DECISION (Tyler, 2026-11-20 18:09): keep the app OFFLINE ONLY. Nostr layer is
  DEFERRED, not killed — "we can add nostr later if necessary." The design
  leaves the door open (server auth is token-based, so a Nostr provider can be
  added later without touching the game). Original Stages 1-5 stand unchanged.

## QoL features — shared with the Armada app (Tyler, 2026-11-20)
Tyler's rule: "I want the QOL stuff in both if they are relevant to the other"
— the QoL list built for the separate SWU Armada app (~/workspace/swu-armada-app/)
applies here too, wherever it makes sense for a solo offline vs-bot app.
RELEVANT here, added to this app's spec:
- Resume after close: an in-progress game vs the bot is saved locally and can
  be resumed on next launch (the launcher offers Resume before New Game).
- One-tap rematch vs the bot (same decks, swap initiative) at game end.
- Undo: free single-player undo (no agreement needed vs a bot) — rewind to
  the start of your last turn at minimum.
- Win/loss counter over time: a local record book — W/L per player deck and
  per bot deck, kept on the Mac, shown in the launcher/client. Solo analogue
  of the Armada app's in-copy group record.
- Best-of-3 with sideboarding vs the bot, with a match score tracker.
- Replay: step through a finished game's move/prompt log.
- Match summary (Tyler, 2026-11-20): at game end, a plain-text play-by-play
  recap generated from the game log — turn-by-turn plays, damage, winner —
  that can be copied or saved for record keeping. Every game app gets this.
- Saved decks: imported decks persist in a My Decks list (no re-import);
  community decks dropdown already in Stage 4 is part of this.
- Card zoom: click a card for full art + full text.
- Optional turn timer: off by default; a practice-clock option.
NOT relevant here (Armada-only, do not port): spectate mode (no audience in a
solo app), "it's your turn" chat notification (the bot moves immediately; a
clear turn/phase indicator in the UI covers the need), result-post-to-chat
(no chat; the local record book + replay export cover it), undo-by-agreement
(no second human to agree).

## Stage 2 — DONE (2026-11-20): bot plays complete games
- `bot/bot.mjs` drives both seats (anonymous socket clients, Tyler's real
  Vader vs Jabba decks) with v1 heuristics: mulligan for a curve (2+ cards
  costing <=3, one mulligan max), resource the most expensive cards first
  (costs from forceteki/test/json/_cardMap.json), action window = play the
  highest-cost playable card, else attack (killable target first, then base,
  then weakest), damage-to-a-player goes to the opponent.
- PROOF: 3 complete bot-vs-bot games with winners (captures 23:55, 23:58,
  00:00 EST, 457-840 events each). One stall diagnosed and fixed en route.
- Protocol lessons (hard-won, all verified in captures):
  - The BASE is `player.base`, a card object with a uuid — NOT in cardPiles.
    Missing it stalls every attack-target prompt with no space/ground target.
  - `selectable` flags on cards (across ALL players' piles + bases) are the
    engine's legal-target truth. Never filter targets by side: indirect
    damage from an attack is distributed by the DEFENDER among their own.
  - Confirm-style buttons arrive `disabled: true` until the selection is
    complete; never click disabled buttons.
  - Distribute prompts are STATEFUL: one message,
    emit('game', 'statefulPromptResults', {type, valueDistribution:
    [{uuid, amount}]}, promptUuid). No cardClicked, no 'done' string — the
    client accumulates locally (forceteki-client Game.context.tsx ~560,
    useDistributionPrompt.ts). A malformed result is rejected SILENTLY
    (no gamestate re-send) — the stall signature is "answer sent, then
    nothing, forever".
  - Damage distributions are capped per target at remaining HP (hp - damage);
    overflow must walk to the next target or the server rejects the whole
    submission silently.
  - Regroup resource prompt reads "Select between 0 and 1 cards to resource"
    — parse the between X and Y form (needed = Y).
  - Empty transitional prompts (menuTitle "", no buttons) resolve on their
    own as the other seat acts; don't treat them as errors.

## Stage 3 — DONE (2026-11-20): update.sh orchestrator
- `update.sh` (bash, fail-soft, ALWAYS exits 0, logs to update.log): connectivity
  check first (offline -> log + exit 0) -> per-repo `git pull --ff-only` ONLY on
  a clean working tree (dirty repos skipped with the changed files logged; local
  changes never stashed/reset/discarded; `npm install` only in a repo that
  actually pulled new commits) -> `npm run get-cards` in forceteki ->
  `node refresh-community-decks.mjs`. Runs under Node 26 (~/workspace/node26)
  with NODE_OPTIONS=--max-old-space-size=5120.
- TEST RUN (2026-11-20, end-to-end, exit 0): connectivity OK; forceteki clean ->
  pulled, already up to date at 191ae59 (no npm install needed);
  forceteki-client SKIPPED as designed (dirty: package-lock.json); community
  decks refreshed and re-validated — 12 decks, each exactly 50 main + 10
  sideboard, 1 leader + 1 base, all ids in SET_NNN form.
- CAVEAT — the get-cards step failed in the test run and on 4 retries:
  forceteki's fetchdata.js dies at its first download from
  admin.starwarsunlimited.com with AxiosError "aborted" / ECONNRESET inside
  BrotliDecompress. Diagnosis: the API intermittently serves brotli-encoded
  responses and those streams get cut through this VM's egress proxy; plain
  uncompressed requests succeed (curl 200 / 1.4 MB; axios identity 5/5). NOT an
  update.sh defect — the step was invoked with the correct Node/heap env and
  the failure was logged and absorbed exactly as designed; existing card data
  untouched (2,560 files in test/json/Card/, forceteki tree still clean).
  Stage 1 proved get-cards succeeds on this VM when the upstream serves
  uncompressed responses, and the brotli/proxy path is specific to Gord's VM —
  the Mac (Stage 5) connects directly. Possible future hardening: retry the
  get-cards step inside update.sh (not yet added).

## Stage 4 — DONE on Gord's VM (2026-11-20): launcher + deck library + practice page
- `SWU-Practice.command` — the one-file launcher (bash, chmod +x). Resolves
  paths from its own location (expects <root>/{forceteki, forceteki-client,
  node26, swu-forge-app}), picks Node 26 (bundled node26/ first, system node
  if in range), exports NODE_OPTIONS=--max-old-space-size=5120. Flow:
  update.sh first (fail-soft: backgrounded on a warm start; waited on up to
  SWU_UPDATE_WAIT=240s on a cold start, never blocks past that) -> start the
  game server if :9500 is unhealthy (waits up to 360s; first build is slow)
  -> create the client's .env.local ONCE if missing (NEXTAUTH_SECRET synced
  from the server's auto-generated .env; never overwritten) -> start the
  client if :3000 is down -> start the practice page -> open the browser at
  the client AND the practice page (macOS `open`; SWU_NO_OPEN=1 skips;
  SWU_DRY_RUN=1 prints the resolved plan; --status / --stop included;
  pidfiles + *-launcher.log in swu-forge-app/).
- `decks/library.mjs` — the deck library module + CLI behind import and the
  dropdowns. My Decks live in decks/my/ with a registry (my-decks.json);
  Tyler's four decks are pre-loaded (copied from the goal files, so the app
  folder is self-contained): Vader/Coaxium, Jabba/Daimyo's, Trance, Rites.
  Community decks are read LIVE from community-decks.json (12 decks), so the
  dropdown tracks the updater's refreshes. Validation: SWUDB shape, leader/
  base exactly 1, main exactly 50, sideboard <=10, every id checked against
  the local card data. Two real-world id lessons baked in: (1) a card's
  alternate printings live in `setCodes`, not `setId` (Betrayed Trust is
  IC27_055 primarily but LAW_130 in Tyler's Jabba deck) — existence checks
  accept every printing; (2) set codes can contain digits and numbers are
  not always zero-padded (Trance carries TS26_57 = Mechanize) — imports are
  normalized to canonical padded SET_NNN on save.
- `bot/opponent.mjs` — the single-seat practice bot (reuses bot.mjs's Seat
  heuristics; bot.mjs now exports { Seat, post } and takes --host-deck /
  --guest-deck file args, defaults unchanged). Creates a private lobby with
  the chosen deck, writes {lobbyId, joinUrl} to a state file, readies up,
  and when the human joins in the client and readies, starts the game and
  plays its seat. The human join URL is
  http://localhost:3000/lobby?lobbyId=<id> (the client reads lobbyId from
  the query string and auto-joins on socket connect; the human picks their
  deck in the lobby UI and readies there).
- `practice-server.mjs` — zero-dependency local web server on
  http://localhost:9777 (binds 127.0.0.1, no external assets, offline-safe):
  the app's front door. Start-a-game section (bot deck dropdown grouped
  My Decks / Community Decks -> spawns opponent.mjs -> shows the lobby join
  link + live bot status), deck import section (paste SWUDB JSON -> validate
  -> save to My Decks), My Decks list (leader/base/counts, Copy-JSON button
  for pasting into the client lobby, "Bot plays this"), community deck list.
  APIs: GET /api/decks, GET /api/deck?id=, POST /api/import, POST /api/start,
  GET /api/status.
- TESTS (all on Gord's VM, 2026-11-20): library list/get/validate across all
  16 decks (4 mine + 12 community) OK; bad deck rejected with reasons, via
  CLI and via the practice API; import through the API persisted (test entry
  removed afterwards). Bot-vs-bot: Tyler's Vader vs community #0 (Wicket) —
  complete game, winner, 551 events; Trance (as stored, TS26_57 and all) vs
  Vader — complete game, winner, 625 events (the engine accepts the deck
  exactly as stored). Opponent flow end-to-end (bot/test-opponent.mjs): the
  practice bot (community deck) created a lobby, a scripted "human" seat
  joined via the client's own API+socket sequence, the bot started the game
  on ready-up, both seats played to a winner, exit 0. Practice API /api/start
  produced a waiting lobby with a well-formed joinUrl. Launcher: bash -n OK;
  SWU_DRY_RUN printed the correct plan; a real run (warm server) backgrounded
  the updater (which completed: decks refreshed), started the client and the
  practice page, exited 0, and --status showed all three services UP; the
  client serves /lobby?lobbyId=... with HTTP 200.
- DEFERRED TO STAGE 5 (Mac-only, not faked): the .command's double-click
  behavior + Gatekeeper prompt; installing the darwin-arm64 Node 26 tarball
  as node26/; browser auto-open via `open`; a human clicking through the
  client lobby in a real browser (join -> pick deck -> ready -> play);
  cold-start timing on the MacBook Air (server build from scratch + client
  first compile on the M1/8 GB); card-art pre-cache for offline play.
  Note: background daemons started from Gord's exec sandbox get reaped when
  the session ends — the stack does not stay up on the VM between sessions;
  that is a sandbox artifact, not a launcher behavior (on the Mac the
  launcher runs in a real Terminal and the daemons persist).

## Stage 6 — DONE on Gord's VM (2026-11-20/21): QoL layer + single command page + own window

Tyler's two additions after his first live run: (1) the QoL layer itself,
(2) the flow was too clunky — everything must live on ONE page, and
(3) the app must open in its OWN window, not browser tabs.

**Audit first (what already existed vs what was built).** Already in the
stack, only verified/wired: saved decks (Stage 4 library persists imports);
card zoom (client hover preview in GameCard/cardHooks.tsx); undo (engine
snapshots; private lobbies default to free undo; the client's chat drawer
has a quick-undo button — vs the bot this just works, nothing built);
rematch / Bo3 / sideboard engine primitives (lobby requestRematch +
RematchMode, GamesToWinMode.BestOfThree, updateDeck, proceedToNextBo3Game).
Newly built: the play-by-play pipeline (bot/gamelog.mjs over the engine's
own game-log message stream, with retransmit gap recovery), the record
book (records.mjs + records.json), Bo3 series flow in the opponent bot,
the replay viewer, the single command page, and the auto-join below.

**Single command page (practice-server.mjs, localhost:9777).** Labeled
sections on one page: YOUR DECK picker, BOT DECK picker, Best-of-1 /
Best-of-3 choice, one START GAME button; below, the live match box, the
last match's play-by-play with a Copy button, the record book, and a
replay stepper. On Start the page does the whole setup: the opponent bot
creates the lobby and readies; when Tyler's browser opens the game, the
bot sets HIS deck via POST /api/lobby/:id/change-deck (the call the Stage
4 harness proved) and starts the game itself — the server's
startGameAsync gates on deck size only, not ready flags, so there is no
deck picking and no ready click for game 1. The page then sends the same
window into the game (auto-navigate once live + a big ENTER YOUR GAME
button as the manual path; the button is also the rejoin path). The game
board stays in the unmodified Karabast client. Level achieved: FULL
auto-join (proven by bot/test-autostart.mjs: deck applied, game started,
human ready flag false throughout). Between Bo3 games the engine's own
design applies: both sides confirm proceed → the server advances to the
next game's lobby (that lobby IS the sideboard window; updateDeck asserts
before it) → Tyler sideboards and clicks Ready in the client → the bot
starts the next game.

**Own window (launcher).** SWU-Practice.command now opens ONLY the
practice page. On macOS it launches it in a Chromium app-mode window
(`--app=http://localhost:9777`, chromeless, own window) detecting in
order Google Chrome, Chromium, Microsoft Edge, Brave (both /Applications
and ~/Applications); no --user-data-dir, so the game client keeps its
saved identity/decks in the default profile. If none is installed it
falls back to the default browser and says so in the launcher output.
SWU_NO_OPEN=1 still skips opening. NOT verifiable from Gord's Linux VM —
Tyler-verifies on the Mac. For the future Windows/Linux packages: reuse
the same approach (Chromium app mode exists on both; Windows: chrome.exe
--app=<url>, Linux: google-chrome --app=<url>).

**Per-feature notes and honest caveats.**
- Play-by-play: generated from the engine's actual game log (setup,
  round-by-round plays/attacks/damage, result), same standard as the
  WebXDC apps' summaries; written per game to summaries/, series summary
  for Bo3; shown on the page with a Copy button. Tyler's standing rule
  (every match ends with a copyable summary) is now met by all three apps.
- Record book: records.json at the app root; overall + per-deck W/L and
  recent results on the page. Bo3 bookkeeping is driven by the lobby
  winHistory, NOT the gamestate winners stream (see bugs below).
- Resume: the honest version only. The game lives on the server and the
  client persists its anonymous id, so reopening the game within the
  server's ~20-second disconnect grace reattaches to the seat (server
  re-sends lobby + game state). There is NO close-the-laptop-and-return
  resume and no save-file resume in the engine; the page surfaces the
  live rejoin link prominently instead of pretending otherwise.
  Proven by bot/test-resume.mjs (10s drop, reconnect, game completed).
- Timer: display only. The engine's enforced action timers exist only
  for Quick/Public matchmaking, not private practice lobbies. The page
  shows match time, time since last action, whose move the bot is
  waiting on, and an optional per-turn target that only highlights when
  exceeded. Nothing is enforced; the page says so.
- Replay: step-through viewer on the page over the bot seat's captures
  (bot/captures/*.jsonl): per prompt, the board piles, the bot's answer,
  and the play-by-play up to that step.
- Rematch: the bot offers one after every game (Bo1 regular; Bo3 a fresh
  set) and auto-confirms the human's requests from the client.

**Bugs found by the tests and fixed (all in our code, none upstream).**
- Bo3 proceed deadlock: the phase flip to betweengames could happen in
  the poll loop, after which no lobbystate arrived to trigger the
  handler-only proceed emit. Proceed is now emitted from both paths.
- The opponent's game-start safety net flipped betweengames → 'playing'
  on the finished game's stale gameOngoing flag and tripped the stall
  watchdog; the net is now gated to the waiting phase.
- Bo3 game recording via gamestate winners/id silently lost a whole game
  mid-series (id changes and winners delivery are not reliable there);
  recording is now winHistory-driven (see above).
- A bot Seat that reconnects mid-game deadlocked on its own
  answered-prompt dedupe (an answer lost with the old socket blocked
  re-answering forever); the dedupe maps now clear on connect.
- The stall watchdog fired while the human was merely disconnected;
  it now stands down while the lobby shows the human disconnected.
- The practice page's inline script contained two '\n' sequences inside
  the server's template literal, which served as literal newlines and
  broke the page's script; escaped, and the served script is now
  syntax-checked as part of testing.

**Test evidence (all against the real engine on Gord's VM).**
bot/test-summary.mjs (full game → 168-line play-by-play summary);
bot/test-autostart.mjs (auto-join centerpiece, PASS);
bot/test-opponent.mjs (manual Stage 4 flow regression, PASS);
bot/test-bo3.mjs (full series, real sideboard swap verified in the
decklist — 50 main / 10 sideboard, moved cards confirmed — series +
per-game records and summaries, PASS); bot/test-resume.mjs (PASS);
practice page endpoints exercised live (start/status/records/captures/
replay/summary/stop) and the served page script syntax-checked.
Mac-side behavior (Gatekeeper, real browser, app-mode window) remains
Tyler-verifies, as with Stage 5.

## Stage 7 — DONE on Gord's VM (2026-11-20/21): everything inside Karabast

Tyler's FINAL spec, after the Stage 6 single page failed live on his Mac
("the link isn't generating and it isn't setting up the game"): "I just
want the Karabast page with the ability to play with a bot and import my
decks, and do it all offline — no separate page if it can be helped."
Scope was exactly that: no record book, replay, Bo3, or summary work in
this flow. The Stage 6 practice page (practice-server.mjs, :9777) is
RETIRED — the launcher no longer starts or opens it; its files stay in
place, unused.

**Design — the bot comes to Tyler's lobby.** A new always-on helper,
`bot/bot-host.mjs` (started by the launcher), polls the game server's
GET /api/available-lobbies every 2s. That endpoint lists PUBLIC lobbies
with an open seat (server-side filter: not private, not filled, no
ongoing game, host connected) including each lobby's name. When a lobby
appears whose name starts with **BOT**, bot-host spawns
`bot/join-bot.mjs` for it. join-bot is a deliberately thin wrapper over
the proven Seat heuristics (bot.mjs, unchanged play logic): POST
/api/join-lobby -> socket connect -> POST /api/lobby/:id/change-deck
(sets the bot's deck) -> ready up -> the HOST starts the game from their
own lobby screen (join-bot never starts games) -> play -> exit when the
host leaves after the game (or a 90s linger). One bot-host handles any
number of games; each game is a fresh lobby and a fresh join-bot.
opponent.mjs was NOT reused: it creates its own lobby and carries the
whole retired Stage 6 lifecycle (summaries/records/Bo3/rematch).

**Deck choice from the lobby name:** `BOT` = default deck (community:0,
Wicket); `BOT 3` = community deck #3; `BOT krennic` = first deck whose
name/slug contains the word (Tyler's own decks searched first, so
`BOT vader` picks his Vader deck); a full library id (`BOT community:7`)
also works. Unrecognized keys fall back to the default and are logged.
The bot plays Best-of-1 lobbies; leave Games to Win on Best of One.

**Tyler's exact steps (all inside Karabast, localhost:3000):**
1. Double-click SWU-Practice.command (opens Karabast when ready).
2. Create Game -> New Deck -> paste your SWUDB deck JSON -> leave the
   format on Eternal / Current, Best of One.
3. Lobby visibility: **Public** (the default — the Game Name field only
   exists for public lobbies; "public" here only means listed on his own
   machine's server). Game Name: `BOT` (optionally `BOT 3`, `BOT vader`,
   ... to pick the bot's deck).
4. Create Game. Within a few seconds the Practice Bot appears in the
   lobby with its deck set, readied. Click Start Game. Play.

**Deck import — what actually works OFFLINE (verified by test, see
bot/test-import-offline.mjs):**
- **Paste SWUDB JSON into the Create Game (or Quick Game) form: WORKS
  offline.** The client's own checkJson.ts (compiled with the client's
  tsc and run against all four of Tyler's deck files) parses the JSON
  purely locally (`parseInputAsDeckData` -> type 'json'), and the form's
  submit sequence (POST /api/create-lobby with the deck object inline)
  returned 200 with the localhost server as the only machine involved.
  Caveat: the UI refuses to SAVE a pasted-JSON deck to the deck list
  ("We do not support saving JSON decks at this time") — the deck is
  pasted per game. Tyler's decks are local .json files, so this is:
  open file, copy, paste.
- **Add Deck dialog (Decks page) with a swudb.com link: NEEDS INTERNET.**
  The dialog is link-only (it explicitly rejects pasted JSON) and
  resolves the link via POST /api/resolve-deck-link; the server's
  SwuDbDeckFetcher then fetches `https://swudb.com/api/getDeckJson/<id>`
  live (no cache). Test evidence: resolving a bogus link returned
  swudb.com's own mapped 404 ("Deck not found. Make sure the deck exists
  on swudb.com") — proof the server asked swudb.com. Offline, this call
  simply fails.
- **Saved Deck dropdown in Create Game: also NEEDS INTERNET at game
  creation time** — even though the deck data is stored (localStorage /
  server), the submit flow carries only the deck LINK and re-resolves it
  through fetchDeckData -> the same live fetch. Non-obvious; documented
  here so nobody re-discovers it.
- QuickGameForm (matchmaking queue) has no bot counterpart — the queue
  would wait forever. Create Game is the path.

**ROOT CAUSES of the Stage 6 Mac failure (found in Stage 7):**
1. **bot.mjs crashed at import time in the install layout.** Its
   top-level code read `../../goals/star-wars-unlimited-decks-and-
   collection/files/*.json` (Gord-workspace-only paths) with bare
   readFileSync. Tyler's install has no goals/ folder, so opponent.mjs
   (which imports bot.mjs) died instantly on his Mac — before creating
   any lobby, hence "link isn't generating / game isn't setting up".
   Proven by running join-bot from a bare staging copy in the install
   layout (ENOENT at bot.mjs import). FIX: those reads (and the
   _cardMap.json read) are now fail-soft (`readJsonSoft`); the two decks
   are only standalone bot-vs-bot defaults, which now demand explicit
   --host-deck/--guest-deck files. The heuristics themselves are
   untouched (costs fall back to printed card costs if the map is ever
   missing; in the real install forceteki/test/json/_cardMap.json is
   present and loads as before).
2. **bot dependencies were install-dependent.** The Stage 5 launcher's
   first-run install loop omitted bot/, so bot/node_modules (the single
   dep socket.io-client) was never installed by that package. Stage 7
   designs the failure out: bot/node_modules is BUNDLED in the patch
   (socket.io-client is pure JS, platform-independent), the launcher's
   install loop covers only forceteki/forceteki-client, and it warns if
   bot/node_modules/socket.io-client is ever missing.
3. **Stale processes kept serving old code.** The launcher now
   HARD-RESTARTS on every launch: stop pidfile processes (children
   first), sweep listeners on :9500/:3000 (lsof, ss fallback), sweep
   leftover processes by install path plus the bot host's exact relative
   invocation ("node bot-host.mjs" — an orphaned duplicate bot host is
   otherwise invisible to the path sweep), wait for the ports to go
   quiet, then start fresh. start_bg now records the DAEMON's own pid
   (the old version recorded a wrapper shell's pid — killing just the
   pidfile pid orphaned the real bot host; found when a test did
   exactly that and two bot hosts raced the same lobbies). Updater:
   bounded 90s wait, then it finishes in the background. The launcher
   opens ONLY http://localhost:3000. --stop also kills a legacy Stage 6
   practice server via its old pidfile. NOTE: relaunching mid-game ends
   the game — deliberate; a launch always means a fresh stack.

**Tests (all against the real stack on Gord's VM, 2026-11-21):**
- (a) Fresh launcher run: server + client + bot-host up, pidfiles point
  at the real daemons, --status shows all three UP. PASS (multiple runs).
- (b)+(d) bot/test-bot-host.mjs: a scripted human host performs the
  client's own sequence (create PUBLIC lobby "BOT 3" with a pasted-JSON
  deck -> socket connect -> bot appears ready -> host emits
  startGameAsync) -> full game to a winner -> host disconnects ->
  join-bot exits code 0; then a SECOND fresh lobby "BOT" (default deck
  community:0) -> full game -> clean exit. PASS (three full runs; the
  run-2 verdict line was lost to a test-harness bug — the test tracked
  the bot-host log by BYTE offsets while the log contains multi-byte
  characters, so its log window silently froze; the bot-host log itself
  proved both games and both code-0 exits. Fixed to text-length
  tracking; run 3 is a clean PASS).
- (c) bot/test-import-offline.mjs: PASS (see import verdicts above;
  run twice).
- (e) Launcher re-run while the stack is up: old PIDs stopped via
  pidfiles, listener children swept by port, a planted orphaned bot
  host swept by invocation pattern, fresh PIDs everywhere, no port
  conflicts, exit 0. PASS.
- Staging smoke test: join-bot run from the bare patch tree in the
  install layout (no goals/, no sibling forceteki/) loads the bundled
  deps, validates its deck, and exits cleanly (code 5, "Lobby not
  found") against a bogus lobby id. PASS — this is the test that caught
  root cause 1.

**Package:** ~/workspace/swu-practice-stage7-patch.zip (874 KB, 346
entries) — unzips over ~/Downloads/swu-practice, replacing
swu-forge-app/ code only: new launcher, bot/ INCLUDING node_modules,
bot-host.mjs, join-bot.mjs, the bot.mjs fix, decks/library.mjs. It
contains NO forceteki/forceteki-client files (his Mac-built deps stay),
NO decks/my data and no my-decks.json (his deck registry is never
clobbered), no logs/pidfiles/records. Verified on disk after building:
socket.io-client present in bot/node_modules, launcher contains no
9777 reference and no app-mode remnants, launcher executable bit set.

## Stage 7.1 — DONE on Gord's VM (2026-11-21): Quick Game queue bot + in-page bot-deck picker

Two same-night additions at Tyler's direction. (1) Trying Stage 7 he
landed in Quick Game's matchmaking queue with nobody to play: "can you
have the bot just automatically queue up when i do." (2) He rejected
the lobby-name trick for choosing the bot's deck: "I want to be able to
change the deck the bot plays as, in a much easier way." The Stage 7
BOT-lobby path is untouched by both.

**Queue mechanism (from the client + server code).** QuickGameForm
POSTs /api/enter-queue {user, deck, format, cardPool, gamesToWinMode,
matchmakingCompetitivenessPreference}, then the client navigates to
/quickGame and opens a socket with lobbyId null. GameServer's
onConnectionAsync routes a lobby-less socket to the caller's queue
entry (QueueHandler.connectPlayer); matchmaking pairs any two
connected players in the same format queue; on a match the server
creates a "Quick Game" lobby with BOTH decks taken from the queue
entries, attaches both sockets to it, and the lobby auto-starts the
game after a ~6s countdown (Lobby.quickLobbyCountdownAsync) — nobody
readies or presses start. The client learns of the match from the
lobbystate on that same socket, and of queue liveness from 1s
queueHeartbeat events. Leaving the queue is a socket 'manualDisconnect'
emit (the Leave Queue button), which the server turns into an immediate
queue removal. There is NO HTTP API for queue contents — the only
observable surface is the server log (winston console output, which the
launcher redirects to server-launcher.log): QueueHandler logs each
queue join with structured meta {event:"queueJoin", userId, format,
cardPool, gamesToWinMode, preference}, each removal with a reason, and
GameServer logs "Matched players … in lobby …".

**Design — bot-host watches the log; queue-bot plays the queue.**
bot-host (same always-on process) tails server-launcher.log (offset
tracked in bytes, truncation-safe, history skipped at startup). On a
human's queueJoin it spawns bot/queue-bot.mjs with the SAME format key
and the SAME matchmaking preference copied from the log meta (a
same-preference pairing is rank 0, so the match is immediate, with no
preference-expansion wait). queue-bot performs the client's exact
sequence (POST /api/enter-queue -> lobby-less socket connect -> get
matched -> countdown -> game) and plays the seat with the unchanged
Stage 2 Seat heuristics. bot-host tracks one queue-bot per waiting
human; a bot that dies before matching is retried with a fresh random
deck, max 3 attempts per queue session.

**Cancel safety.** If the human leaves before a match forms (removal
log line with a genuine reason — "Player connected…" and "Rejoining
into queue" removals are connectPlayer/addPlayer bookkeeping, not
leaves, and are filtered out), bot-host writes "withdraw" to the bot's
stdin and the bot leaves exactly like the client's Leave Queue button
('manualDisconnect' emit). The bot NEVER queues unprompted: spawns
happen only on a human queueJoin. Two more traps are covered: if the
human disconnects during the pre-game countdown, the server
auto-requeues the remaining player (Lobby.handleMatchmakingDisconnect)
— the bot detects the renewed heartbeats while matched and withdraws
itself, and bot-host independently spots a matched bot's second
queueJoin and orders the withdraw; and if two humans match each other,
any bot still waiting for either of them is withdrawn.

**Bot-deck picker (the deck-choice fix).** A shared client component,
BotDeckPicker.tsx, renders a "Bot deck" dropdown in BOTH the Quick Game
form and the Create Game form, listing "Random community deck",
Tyler's decks, and every community deck (the list currently holds 13;
the picker shows whatever decks/library.mjs returns). The choice
persists in localStorage (key swuPracticeBotDeckId) AND in bot-host,
via a tiny HTTP endpoint bot-host serves on http://127.0.0.1:9778
(GET /bot-deck-options, GET /bot-deck, POST /bot-deck; persisted to
bot-deck-choice.json in the app dir; localhost-only bind, permissive
CORS — it is a single-machine helper). Choice states: unset -> queue
bots play a random community deck and a bare "BOT" lobby keeps the
Stage 7 default deck; "random" -> random on both paths; a deck id ->
that deck on both paths. A BOT-lobby name suffix (BOT 3, BOT vader)
still overrides the choice for that lobby only.

**Client patch + what it means for updates.** The launcher runs the
client with `next dev`, so the shippable unit is patched SOURCES —
three files: BotDeckPicker.tsx (new), QuickGameForm.tsx and
CreateGameForm.tsx (one import + one render line each). `tsc --noemit`
is clean with the patch applied, and the dev server picks the files up
on the launcher's hard restart; Tyler's Mac builds nothing (same as
every client file today). EXPECTED SIDE EFFECT, by design: update.sh
only pulls repos whose working tree is clean (dirty -> SKIP, logged),
so the patched client tree is dirty and upstream client pulls PAUSE
until the patch is re-applied onto a fresh tree. The engine tree is
unpatched and keeps updating normally. Do not "fix" the dirty tree
with a reset/checkout — that would silently delete the picker.

**Tests (real stack, headless, scripted humans using the client's own
API/socket sequence):**
- (a) Human queues -> bot-host spawns a queue-bot into the same queue
  -> matched -> full game to a winner -> queue-bot exits code 0,
  queue empty. PASS (test-queue-bot.mjs, two full runs: pre- and
  post-picker code).
- (b) Human queues, then leaves the moment their bot spawns (before it
  can connect, so no match has formed) -> bot-host orders the withdraw
  -> bot exits code 0, zero queue-bot processes; a probe human then
  proves no stale bot is waiting (it is not matched before bot-host
  spawns a fresh bot for it) and that the watcher still works (the
  probe's bot is withdrawn after the probe leaves). PASS. (Run 1 of
  this test failed on harness artifacts only: a pgrep pattern that
  matched the test's own file name, and a cancel timed after the
  ~1.5s spawn->match cycle, which exercised the countdown-disconnect
  cleanup instead — that path also cleaned up correctly.)
- (c) A second queued game after (a)+(b) completes end-to-end. PASS.
- (d) Regression: bot/test-bot-host.mjs (the Stage 7 BOT-lobby suite)
  on the final code. PASS — lobby path intact, including the bare-BOT
  default deck when no picker choice is set.
- Picker verification in the install layout (staging tree at
  /tmp/stage71, stack launched from the patched copies): the served
  home-page JS chunk contains the picker ("Bot deck",
  bot-deck-options); options endpoint returns random + 4 of Tyler's
  decks + 13 community decks; POST community:3 persists (GET + choice
  file); a scripted queue match then plays community:3 — proven by the
  opponent leader's setId in the human's gamestate (LOF_002, Mother
  Talzin = community:3's leader); with the choice set to
  my:vader-coaxium-mine, a bare "BOT" lobby gets a join-bot with that
  deck; clearing the choice works. PASS.

**Tyler's steps now:** launch -> Karabast -> (once) set the Bot deck
dropdown on the home page -> Quick Game -> pick his deck -> Join Queue
-> the bot queues with him, the game auto-starts. The Create Game /
BOT-lobby route works exactly as in Stage 7.

**Package:** ~/workspace/swu-practice-stage7-1-patch.zip — unzips over
~/Downloads/swu-practice. Contents: the Stage 7 patch set with the new
bot-host.mjs (queue watcher + picker endpoint), bot/queue-bot.mjs,
bot/test-queue-bot.mjs, updated PLAN.md, PLUS the three patched client
source files under forceteki-client/src/... (the client runs `next
dev`, so sources are the runnable form; still NO client node_modules
and no .next). NO decks/my data, no my-decks.json, no
bot-deck-choice.json (his picker choice is never clobbered), no
logs/pidfiles/records. Launcher unchanged from Stage 7 (hard restart,
opens only localhost:3000, no 9777, no app-mode). Verified on disk
after building (see the Stage 7.1 entry in the build report).

## Stages
1. ~~Stack running locally on Gord's VM~~ DONE 2026-11-20 (see above).
2. ~~AI bot client (heuristic player 2)~~ DONE 2026-11-20 (see above).
3. ~~Update-on-launch script (git pull engine/client + get-cards + refresh
   community deck list; fail-soft when offline)~~ DONE 2026-11-20 (see above).
4. ~~One-file macOS launcher (.app/.command) + deck import + community decks
   dropdown~~ DONE 2026-11-20 (see above).
5. Install on Tyler's MacBook Air — PIVOTED 2026-11-20 to a self-install
   unzip-and-launch zip Tyler runs himself (Mac Node 26 bundled; launcher
   self-installs dependencies on first run). PACKAGING RULE learned the
   hard way: Node's bin/npm and bin/npx are SYMLINKS into lib/node_modules —
   a plain `zip -r` dereferences them and the copies break (npm loses its
   own files: "Cannot find module '../lib/cli.js'"). In the package, replace
   both symlinks with shim scripts that exec the real npm-cli.js/npx-cli.js
   via the bundled node, and build with `zip -y`. Tyler's first run of the
   pre-fix zip failed exactly this way; fixed zip re-issued the same night.
6. ~~QoL layer (see section above): resume, rematch, undo, local W/L record book,
   Bo3 + sideboard vs bot, replay, saved decks, card zoom, optional timer~~
   DONE 2026-11-20/21 (see Stage 6 section above — includes the single
   command page with full auto-join and the launcher's own-window open).
   SUPERSEDED the same night by Stage 7 at Tyler's direction.
7. ~~Everything inside Karabast: bot host sends the bot into Tyler's own
   lobbies (named "BOT..."), launcher hard-restarts and opens only
   localhost:3000, practice page retired, bot deps bundled~~ DONE
   2026-11-20/21 (see Stage 7 section above).
7.1. ~~Quick Game queue bot (bot queues when Tyler queues, cancel-safe)
   + in-page bot-deck picker in the patched client (Quick Game and
   Create Game forms), wired to a bot-host endpoint~~ DONE 2026-11-21
   (see Stage 7.1 section above).
8. ~~Linux + Windows packages (same complete-tree design as the Mac
   full package; Linux tested end-to-end on the VM, Windows assembled
   and statically verified)~~ DONE 2026-11-21 (see Stage 8 section
   below).

## Tyler's decks (SWUDB JSON, in the SWU goal files folder)
- vader-deck-holoscan.json, jabba-deck-holoscan.json,
  trance-deck-holoscan.json (Trance — Palpatine Recursion),
  rites-deck-holoscan.json (Rites — Thrawn Death Payoffs).

## Stage 6 follow-up (2026-11-20, same night) — own-window REVERTED
The Chromium app-mode own-window shipped in Stage 6 failed live on Tyler's
Mac: it opened once, then did not open again (the app-window request is
swallowed when the browser stays resident). Tyler dropped the own-window
requirement ("i just want it to work in the browser now"). The launcher's
open step is reverted to a plain default-browser open of the practice page
(single tab; the page navigates itself into the game). Delivered as a
single-file fix zip (swu-practice-launcher-fix.zip). Do NOT reintroduce
app-mode opening in the Windows/Linux packages unless Tyler asks again.

## PATCH PACKAGING RULE (2026-11-21, learned the hard way)
The Stage 7.1 patch was the first to include forceteki-client files — only the
3 patched sources. Tyler copied the folders in with Finder Replace, which
swapped his entire forceteki-client folder for the 3-file skeleton: no
package.json, no node_modules — client dead, launcher install failed ENOENT.
RULES for every future patch: (1) any top-level folder a patch touches ships
COMPLETE (full tree minus node_modules/.next), never a partial skeleton;
(2) delivery instructions always use the Terminal `unzip -o` route into
~/Downloads/swu-practice (it cannot delete files), and if Finder is mentioned,
Merge is mandatory, Replace is called out as destructive. Repair zip
(swu-practice-client-repair.zip, full patched client + his 4 deck JSONs)
shipped 2026-11-21.

## Stage 8 — DONE (2026-11-21): Linux + Windows packages

Authorized by Tyler 2026-11-21, after the Mac full package earned his
"works perfect". Both packages replicate the Mac full package: the
same complete `swu-practice/` tree (forceteki incl. .git and the
test/json card data; forceteki-client WITHOUT .git, with the 3-file
bot-deck-picker patch; swu-forge-app with bot/ incl. bundled
node_modules and Tyler's decks). Verified by file-list diff against
the Mac zip: the ONLY differences are node26, the launcher, the
updater (Windows) and README-FIRST.txt. Per-platform READMEs cover
install, the Quick Game flow, the Create Game BOT flow, the
paste-JSON deck import (and its offline verdicts from Stage 7), and
stop/delete.

**Linux — ~/workspace/swu-practice-linux.zip (105,191,160 bytes).**
- node26 = Node v26.13.1 linux-x64 (the workspace build); bin/npm and
  bin/npx kept as symlinks via `zip -y`. PROOF from the extracted zip:
  `node --version` v26.13.1, `npm --version` / `npx --version` 11.20.0.
- Launcher: swu-forge-app/SWU-Practice.sh — the .command with the
  macOS-only pieces removed (no quarantine/xattr block; the browser
  open is xdg-open). update.sh ships unchanged. Exec bits preserved.
- TESTED FOR REAL on Gord's VM, from the extracted zip staged into a
  clean directory (no pre-existing node_modules anywhere):
  * Launcher run (SWU_NO_OPEN=1): exit 0. First-run npm installs for
    engine and client completed; the hard restart stopped the stack
    that was already running; the updater ran; server + client +
    bot-host all UP (`--status` all UP — one transient client "down"
    was observed during the client's first dev compile and it was
    healthy on recheck seconds later; same 3s-health-check behavior
    as the Mac launcher).
  * bot/test-queue-bot.mjs against the staged stack: **TEST PASS** —
    two full queued games played to winners, the cancel case withdrew
    the bot, queue left empty, exit 0.
  * Launcher re-run (hard-restart check): exit 0, fresh PIDs
    (server 12800→13769, client 12972→13955, bot-host 13087→14188),
    all UP afterwards. `--stop` then stopped everything cleanly and
    freed ports 9500/3000/9778.
  * Note: the staged test's hard restart stopped the workspace dev
    stack that was running on the VM (the port sweep is global by
    design); it was relaunched after testing.

**Windows — ~/workspace/swu-practice-windows.zip (81,716,765 bytes).**
- node26 = official Node v26.13.1 win-x64 from nodejs.org (.zip
  distribution), SHA-256
  `e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7`
  — matches nodejs.org's SHASUMS256.txt entry for
  node-v26.13.1-win-x64.zip (verified at download time).
- Launcher: swu-forge-app/SWU-Practice.bat (double-click entry;
  passes -Stop/-Status through; pauses on error so messages stay
  readable) → SWU-Practice.ps1, a section-by-section port of the bash
  launcher: Node >=26.12.1 <27 selection (bundled node.exe, system
  fallback), health checks (REST /api/health, HTTP 200 on :3000,
  bot-host pidfile), pidfile stops via `taskkill /T /F` (tree kill —
  the wrapper-pid lesson from Stage 7), port sweeps via
  Get-NetTCPConnection with a netstat -ano fallback, leftover-process
  sweep via Win32_Process command lines (engine/client/bot dirs +
  the bot-host.mjs invocation; the launcher cannot match itself),
  first-run npm install via the bundled npm.cmd, .env.local creation
  (secret synced from the server's .env, once, never overwritten),
  updater with a bounded 90s wait then background, server/client
  started hidden via `cmd /c npm run dev` with output redirected to
  <name>-launcher.log / <name>-launcher.err.log, bot host started
  directly via node.exe, Karabast opened with Start-Process.
  -Stop / -Status (also --stop / --status), SWU_NO_OPEN,
  SWU_DRY_RUN, SWU_UPDATE_WAIT, SWU_ROOT, SWU_NODE_DIR all supported.
  The .bat and .ps1 ship with CRLF line endings.
- Updater: update.sh is PORTED to update.mjs (invoked by the .ps1;
  update.sh itself is not in the Windows tree). Faithful port:
  connectivity check (same three endpoints); git pull --ff-only on
  clean trees only, npm install only in a repo that actually
  updated; get-cards with the same 3-attempt retry; community deck
  refresh; logs to update.log; ALWAYS exits 0. Windows specifics:
  git is OPTIONAL — if git is absent the repo step is skipped with a
  log line and cards/decks still refresh; npm is invoked as
  `node <node26>\node_modules\npm\bin\npm-cli.js` because Node
  cannot spawn .cmd shims without a shell. update.mjs passes
  `node --check`.
- NOT run-tested — there is no Windows on Gord's VM. Verified
  statically instead: full zip checklist (node.exe, npm.cmd,
  npx.cmd and npm's npm-cli.js present; SWU-Practice.bat/.ps1 and
  update.mjs present; bot/node_modules/socket.io-client bundled;
  picker sources present; exactly 4 decks in decks/my; ZERO
  forceteki/forceteki-client node_modules, ZERO .next, ZERO
  .env/.env.local, ZERO logs/pidfiles/test artifacts/bot-deck-choice;
  no .command, no update.sh, no .sh in the tree); every path the
  .ps1 references exists in the tree; the .ps1 was reviewed line by
  line and three defects were found and fixed before shipping (a
  taskkill pid cast that is fragile in PowerShell argument mode,
  single-element array unrolling that could silently skip a port
  sweep, and a fallback log line that named the wrong node dir).
- Expected first-run prompts on real Windows (documented in the
  README): SmartScreen "unrecognized app" for the .bat (More info →
  Run anyway) and a possible Windows Firewall prompt for node.exe
  (allow on Private networks).
