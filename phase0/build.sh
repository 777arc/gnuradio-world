#!/usr/bin/env bash
# Build the Phase 0 hello module. Requires: source ~/emsdk/emsdk_env.sh
set -euo pipefail
cd "$(dirname "$0")"
emcc hello.c -O2 -o hello.js \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGrModule \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap \
  -sEXPORTED_FUNCTIONS=_main,_gr_wasm_selftest \
  -sENVIRONMENT=web,worker
echo "built hello.js + hello.wasm"
