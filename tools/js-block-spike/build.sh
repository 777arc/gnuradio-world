#!/usr/bin/env bash
# Phase-1 spike build. Mirrors the runner's link flags for everything this
# question depends on: MAIN_MODULE=2 + EXPORT_ALL, -pthread, ALLOW_MEMORY_GROWTH,
# -fexceptions at COMPILE time, and the JS runtime delivered with --pre-js.
#
# INITIAL_MEMORY is deliberately small (the runner uses 256 MB) so the growth
# probe crosses a real sbrk boundary in a fraction of a second. The growth
# mechanism is identical at either size.
set -euo pipefail
cd "$(dirname "$0")"
: "${EMSDK:?source deps/env.sh first}"

# MODULARIZE=1 mirrors how Qt links the real runner (`var runner_entry = (() =>
# {...})()`, with `isPthread && runner_entry()` at the tail). Pass --modularize
# to build that shape, which is the one the feature would actually ship in.
MOD=()
OUT=build/spike.js
if [ "${1:-}" = "--modularize" ]; then
  MOD=(-sMODULARIZE=1 -sEXPORT_NAME=spike_entry)
  OUT=build/spike_mod.js
fi

mkdir -p build
emcc spike.cpp -o "$OUT" \
  "${MOD[@]}" \
  -std=c++17 -O2 -fPIC -fexceptions -pthread \
  -sMAIN_MODULE=2 -sEXPORT_ALL=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=2147483648 \
  -sALLOW_TABLE_GROWTH=1 \
  -sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sNO_DISABLE_EXCEPTION_CATCHING \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,stringToUTF8,UTF8ToString \
  -sEXIT_RUNTIME=1 \
  --pre-js js_runtime_spike.js

echo "built tools/js-block-spike/$OUT"
