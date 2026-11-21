# SWU Practice

Offline **Star Wars: Unlimited** practice — the open-source Karabast client and
Forceteki engine running entirely on your own machine, plus a bot opponent.
No account, no server, no internet needed after the one-time first-run install.

## Downloads

The playable packages are on the **Releases** page (they are too large for the
repository itself):

- **Mac** — `swu-practicer-mac.zip`: double-click installer that puts
  the app in your Applications folder. Verified working.
- **Linux (x86-64)** — `swu-practicer-linux.zip`: unzip and double-click
  `SWU-Practice.desktop` (or the `SWU-Practice` program inside
  `swu-forge-app`). Tested end-to-end. Works on Arch, Fedora, Mint, Ubuntu
  and other distros with glibc 2.28+. On a Steam Deck it also runs in
  Game Mode — see the Steam Deck section below, and **read its disclaimer
  before your first launch**.
- **Windows** — `swu-practicer-windows.zip`: unzip and double-click
  `SWU-Practice.exe` inside `swu-forge-app`. Assembled and verified, but not
  yet run-tested on real Windows hardware.

## Steam Deck

> **Disclaimer for Steam Deck users: launch in Desktop Mode FIRST.**
> The one-time first run downloads dependencies and builds the game
> server, and that first launch must happen in Desktop Mode (expect
> 10+ minutes, and it needs Wi-Fi). Do not make your first launch from
> Game Mode — you would be staring at a loading screen with no way to
> see what it is doing. After that first Desktop Mode launch, play in
> **Game Mode**: add `swu-forge-app/SWU-Practice-GameMode.sh` to Steam
> as a Non-Steam game and it starts the stack in the background and
> opens the game full-screen from your library (see `STEAMDECK.md`
> for the full steps). Everything installs inside its own folder in
> your home directory: it never touches SteamOS system files, needs
> no sudo and no read-only unlock, and survives SteamOS updates.
> Tested end-to-end on desktop Linux; a physical Steam Deck run is
> still pending, so the first Deck install doubles as a field test —
> if something misbehaves, the launcher writes a `launcher.log` next
> to itself that says exactly where it stopped.

## Playing

- **Quick Game** drops you straight into a match against the bot. Use the
  **Bot deck** dropdown in the form to choose what the bot plays.
- Or **Create Game**, name the lobby `BOT`, and start it yourself — the bot
  joins as player 2. A name suffix picks its deck (`BOT 3`, `BOT vader`).
- **Import your own decks** under Create Game → New Deck by pasting SWUDB
  JSON — it parses locally, so it works fully offline. (Karabast does not
  save pasted decks; paste per game.)

## What's in this repository

The project layer built on top of Karabast (the engine and client are
upstream projects, fetched by the packages' updater — they are not forked
here):

- `SWU-Practice.command` — the Mac launcher: hard-restarts the local stack
  (engine on :9500, client on :3000, bot helper) and opens the game page.
- `bot/` — the bot: `bot-host.mjs` watches for BOT lobbies and the Quick
  Game queue, `queue-bot.mjs` / `join-bot.mjs` seat the bot, `bot.mjs` plays
  the game with simple heuristics. A deck-testing dummy, not a sparring brain.
- `decks/` — deck JSONs (SWUDB format) and the community deck list.
- `update.sh` — pulls engine/card updates and refreshes the community decks.
- `PLAN.md` — the full build record: design decisions, test evidence, and
  the packaging rules learned along the way.

## Credits

Built on the open-source Forceteki engine and Karabast client. Star Wars:
Unlimited is a game by Fantasy Flight Games; this is a personal,
non-commercial fan project for offline practice.
