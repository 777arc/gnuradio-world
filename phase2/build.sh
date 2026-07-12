#!/usr/bin/env bash
# Build the Phase 2 headless flowgraph test: links the WASM gnuradio-runtime and
# runs a hand-written flowgraph through the thread-per-block scheduler.
set -euo pipefail
cd "$(dirname "$0")"
source ../deps/env.sh >/dev/null 2>&1

GRB=/home/marc/gnuradio/wasm/gr/build-runtime
INCS=(
  -I/home/marc/gnuradio/gnuradio-runtime/include
  -I"$GRB/gnuradio-runtime/include"
  -I"$SYSROOT/include"
)
# Static link order: GR libs first, then their deps.
LIBS=(
  "$GRB/gnuradio-runtime/lib/libgnuradio-runtime.a"
  "$GRB/gnuradio-runtime/lib/pmt/libgnuradio-pmt.a"
  "$SYSROOT/lib/libvolk.a"
  "$SYSROOT/lib/libboost_thread.a"
  "$SYSROOT/lib/libboost_program_options.a"
  "$SYSROOT/lib/libboost_regex.a"
  "$SYSROOT/lib/libboost_chrono.a"
  "$SYSROOT/lib/libboost_atomic.a"
  "$SYSROOT/lib/libboost_date_time.a"
  "$SYSROOT/lib/libboost_system.a"
  "$SYSROOT/lib/libspdlog.a"
  "$SYSROOT/lib/libgmpxx.a"
  "$SYSROOT/lib/libgmp.a"
)

# Precompile the SysV-shm stubs to an object first: passed inline as .c, -O2 can
# internalize/drop them before the archive member that needs them is pulled.
emcc -O2 -c shm_stubs.c -o build/shm_stubs.o

em++ -O2 -std=c++17 -pthread -DFORCE_SINGLE_MAPPED "${INCS[@]}" \
  flowgraph.cpp build/shm_stubs.o "${LIBS[@]}" \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 \
  -sEXPORTED_RUNTIME_METHODS=callMain --shell-file ../shell.html \
  -o build/phase2.html
echo "=== artifacts ==="; ls -la build/phase2.{html,js,wasm}
