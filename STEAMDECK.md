# SWU Practice on Steam Deck

SteamOS is Arch Linux under the hood, so the Linux package runs on the
Deck as-is: everything installs into your Home folder, nothing touches
SteamOS's read-only system files, and it survives SteamOS updates.

You play in **Game Mode**, handheld, from your Steam library. Desktop
Mode is only for the one-time setup.

> **Disclaimer: launch in Desktop Mode FIRST.** The one-time first run
> downloads dependencies and builds the game server, and that first
> launch must happen in Desktop Mode (expect 10+ minutes, and it needs
> Wi-Fi). Do not make your first launch from Game Mode — you would be
> staring at a loading screen with no way to see what it is doing.

## Setup (one time, Desktop Mode)

1. Hold the power button → Switch to Desktop.
2. Put the Linux (or Steam Deck) package zip in Home and extract it
   there. You get a folder: `swu-practice`. Keep it in Home — not on a
   Steam-formatted SD card.
3. First launch: open Konsole in `Home/swu-practice/swu-forge-app` and
   run `./SWU-Practice.sh`. It downloads dependencies and builds the
   game server; when it opens the game in a browser window, setup is
   done. Stop it with `./SWU-Practice.sh --stop`.
4. Add the Game Mode launcher to Steam: Steam (desktop) → Games →
   Add a Non-Steam Game → Browse → pick
   `Home/swu-practice/swu-forge-app/SWU-Practice-GameMode.sh`.
   If the file does not show in the picker, switch the filter to
   "All Files".

If you cloned this repository instead of using a release zip, the
Game Mode launcher is `SWU-Practice-GameMode.sh` in the repo root —
copy it into `swu-forge-app` next to `SWU-Practice.sh` and run
`chmod +x SWU-Practice-GameMode.sh` once (git snapshots do not carry
the executable bit).

## Play (Game Mode, handheld)

1. Library → Non-Steam → SWU Practice → Play.
2. Give it a moment: the wrapper starts the game stack in the
   background, waits for it, then opens the game full-screen in
   Firefox kiosk mode — one window, tracked by Steam like any game.
3. Controls: the game is click-driven. The touchscreen works (tap to
   click), and the right trackpad is a mouse with right trigger as
   click.
4. Exit like any game (Steam button → Exit Game); the wrapper stops
   the game stack on the way out.

## Notes

- Fully offline in Game Mode once setup is done. Card art loads from
  the internet when you are online; rules, decks and the bot are all
  on the Deck.
- If a launch ever lands on a blank page, the stack was still
  starting — exit and launch again; every launch restarts the stack
  cleanly.
- Bot deck and difficulty picks are set inside the game (dropdowns on
  the home page) and are remembered between launches.
- Tested end-to-end on desktop Linux; a physical Steam Deck run is
  still pending, so the first Deck install doubles as a field test.
  If something misbehaves, `swu-forge-app/launcher.log` says exactly
  where it stopped.
