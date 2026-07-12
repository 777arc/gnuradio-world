#!/usr/bin/env bash
# Build the Phase 3 real-gr-blocks flowgraph for WASM.
set -euo pipefail
cd "$(dirname "$0")"
source ../deps/env.sh >/dev/null 2>&1
mkdir -p build
GRB=/home/marc/gnuradio/wasm/gr/build-gr

emcc -O2 -c ../phase2/shm_stubs.c -o build/shm_stubs.o

INCS=(
  -I/home/marc/gnuradio/gnuradio-runtime/include
  -I/home/marc/gnuradio/gr-blocks/include
  -I/home/marc/gnuradio/gr-fft/include
  -I"$GRB/gnuradio-runtime/include"
  -I"$SYSROOT/include"
)
LIBS=(
  "$GRB/gr-blocks/lib/libgnuradio-blocks.a"
  "$GRB/gr-fft/lib/libgnuradio-fft.a"
  "$GRB/gnuradio-runtime/lib/libgnuradio-runtime.a"
  "$GRB/gnuradio-runtime/lib/pmt/libgnuradio-pmt.a"
  "$SYSROOT/lib/libvolk.a"
  "$SYSROOT/lib/libfftw3f.a"
  "$SYSROOT"/lib/libboost_{thread,program_options,regex,chrono,atomic,date_time,system}.a
  "$SYSROOT/lib/libspdlog.a"
  "$SYSROOT/lib/libgmpxx.a" "$SYSROOT/lib/libgmp.a"
)

em++ -O2 -std=c++17 -pthread -DFORCE_SINGLE_MAPPED "${INCS[@]}" \
  flowgraph.cpp build/shm_stubs.o "${LIBS[@]}" \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 \
  --shell-file ../shell.html \
  -o build/phase3.html
echo "=== artifacts ==="; ls -la build/phase3.wasm
