#!/usr/bin/env bash
# Reusable headless-browser smoke runner for the GNU Radio WASM port.
# Drives Windows Chrome (via WSL) against the local COOP/COEP dev server and
# greps the page's machine-readable RESULT line out of the dumped DOM.
#
# Usage: wasm/smoke.sh <url-path> [pass-token] [port] [virtual-time-ms]
#   e.g. wasm/smoke.sh /phase0/index.html PHASE0_PASS 8090
# Exits 0 if pass-token found in the RESULT line, else 1.
set -uo pipefail

URLPATH="${1:?usage: smoke.sh <url-path> [pass-token] [port] [vtime-ms]}"
TOKEN="${2:-PASS}"
PORT="${3:-8090}"
VTIME="${4:-8000}"

CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || { echo "SMOKE: chrome.exe not found"; exit 2; }

PROFILE='C:\Temp\gr_wasm_chrome_profile'
DOM=$("$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFILE" \
  --virtual-time-budget="$VTIME" --run-all-compositor-stages-before-draw \
  --dump-dom "http://localhost:${PORT}${URLPATH}" 2>/dev/null)

LINE=$(printf '%s' "$DOM" | grep -oE "RESULT: [A-Z0-9_]+ [^<]*" | head -1)
echo "SMOKE ${URLPATH} -> ${LINE:-<no RESULT line found>}"
printf '%s' "$LINE" | grep -q "$TOKEN"
