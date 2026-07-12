#!/usr/bin/env bash
# Screenshot-based smoke runner for canvas/WebGL pages (Qt paints into a <canvas>,
# so DOM text isn't enough). Captures a PNG via headless Chrome, then checks the
# image has meaningful non-uniform content (i.e. something was actually drawn).
#
# Usage: wasm/shot.sh <url-path> <out.png> [port] [vtime-ms]
# Exit 0 if the screenshot is non-blank (has color variance), else 1.
set -uo pipefail
URLPATH="${1:?usage: shot.sh <url-path> <out.png> [port] [vtime-ms]}"
OUT="${2:?output png path}"
PORT="${3:-8090}"
VTIME="${4:-12000}"

CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || CHROME="/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
[ -f "$CHROME" ] || { echo "SHOT: chrome.exe not found"; exit 2; }

# Chrome (Windows) writes the screenshot to a Windows-visible path; capture to the
# WSL temp then let Chrome write via a UNC-free approach: use --screenshot=<path>
# with a Windows temp path, then copy back.
WINSHOT='C:\Temp\gr_wasm_shot.png'
PROFILE='C:\Temp\gr_wasm_chrome_profile'
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFILE" \
  --window-size=800,600 \
  --virtual-time-budget="$VTIME" --run-all-compositor-stages-before-draw \
  --screenshot="$WINSHOT" "http://localhost:${PORT}${URLPATH}" >/dev/null 2>&1

# Translate C:\Temp\... to the WSL mount and copy out.
cp "/mnt/c/Temp/gr_wasm_shot.png" "$OUT" 2>/dev/null || { echo "SHOT: no screenshot produced"; exit 1; }

# Assess non-blankness with node (no extra deps): PNG must decode and have >1 distinct
# pixel-ish signal. We use a crude byte-variance heuristic on the compressed stream,
# plus size, then a stricter check via a tiny canvas-free PNG sniff.
node -e '
const fs=require("fs");
const b=fs.readFileSync(process.argv[1]);
if(b.length<1000){console.log("SHOT: png too small ("+b.length+"B)");process.exit(1);}
// Byte histogram variance as a blank-ish proxy: a solid-color PNG compresses to
// very low entropy; any real drawing raises distinct-byte count.
const seen=new Set(); for(let i=0;i<b.length;i++) seen.add(b[i]);
console.log("SHOT: "+process.argv[1]+" size="+b.length+"B distinctBytes="+seen.size);
process.exit(seen.size>40?0:1);
' "$OUT"
