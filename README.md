# SWU Practice

Offline **Star Wars: Unlimited** practice — the open-source Karabast client and
Forceteki engine running entirely on your own machine, plus a bot opponent.
No account, no server, no internet needed after the one-time first-run install.

## Downloads

The playable packages are on the **Releases** page (they are too large for the
repository itself):

- **Mac** — `swu-practice-mac-installer.zip`: double-click installer that puts
  the app in your Applications folder. Verified working.
- **Linux (x86-64)** — `swu-practice-linux.zip`: unzip and double-click
  `SWU-Practice.desktop` (or the `SWU-Practice` program inside
  `swu-forge-app`). Tested end-to-end. Works on Arch, Fedora, Mint, Ubuntu
  and other distros with glibc 2.28+; on a Steam Deck, use Desktop Mode.
- **Windows** — `swu-practice-windows.zip`: unzip and double-click
  `SWU-Practice.exe` inside `swu-forge-app`. Assembled and verified, but not
  yet run-tested on real Windows hardware.

## Steam Deck

> **Disclaimer for Steam Deck users:** use **Desktop Mode** — Game Mode
> can't run this, because the game opens in a web browser. Everything
> installs inside its own folder in your home directory: it never touches
> SteamOS system files, needs no sudo and no read-only unlock, and survives
> SteamOS updates. The first run needs Wi-Fi for the one-time install.
> Tested end-to-end on desktop Linux; a physical Steam Deck run is still
> pending, so the first Deck install doubles as a field test — if something
> misbehaves, the launcher writes a `launcher.log` next to itself that says
> exactly where it stopped.

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
