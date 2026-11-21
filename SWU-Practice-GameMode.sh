#!/bin/bash
# SWU Practice - Steam Deck GAME MODE launcher.
#
# Add THIS file to Steam as the Non-Steam game (Desktop Mode ->
# Steam -> Add a Non-Steam Game -> Browse; if it does not show,
# switch the file filter to "All Files"). It starts the local game
# stack in the background without opening a browser, waits until
# the game page answers, then opens it full-screen in Firefox
# kiosk mode as the one window Steam/gamescope tracks. Closing
# the browser window (or exiting the "game") stops the stack.
set -u
cd "$(dirname "$0")"
URL="http://localhost:3000"

cleanup() { ./SWU-Practice.sh --stop >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# Fresh stack every launch (also clears any stale one left behind
# by a hard kill, which the next launch would restart anyway).
cleanup
SWU_NO_OPEN=1 ./SWU-Practice.sh >/dev/null 2>&1

# Wait for the game page. The first-ever launch downloads and
# builds everything and can take 10+ minutes on the Deck CPU;
# later launches answer in well under a minute.
for i in $(seq 1 360); do
  if curl -sf "$URL" >/dev/null 2>&1; then break; fi
  sleep 2
done

# Foreground: the browser window IS the game window.
if flatpak info org.mozilla.firefox >/dev/null 2>&1; then
  flatpak run org.mozilla.firefox --kiosk "$URL"
elif command -v firefox >/dev/null 2>&1; then
  firefox --kiosk "$URL"
else
  xdg-open "$URL"
fi
