#!/usr/bin/env bash
# Common environment for cross-building GNU Radio's C++ dependencies to WASM.
# Source this: `source wasm/deps/env.sh`
set -euo pipefail

# Pinned Emscripten (matches Qt 6.9).
~/emsdk/emsdk activate 3.1.70 >/dev/null 2>&1 || true
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1

export WASM_ROOT="/home/marc/gnuradio/wasm"
export SYSROOT="$WASM_ROOT/sysroot"          # install prefix for all deps
export DEPS_SRC="$WASM_ROOT/deps/src"
mkdir -p "$SYSROOT"

# Every object must be built -pthread so it is ABI-compatible with threaded Qt
# and GNU Radio's thread-per-block scheduler.
export WASM_PTHREAD_FLAGS="-pthread"

# CMake args shared by all Emscripten dep builds. `emcmake` supplies the
# Emscripten toolchain; we point find_package at our sysroot.
wasm_cmake_common_args() {
  echo "-GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=$SYSROOT \
    -DCMAKE_PREFIX_PATH=$SYSROOT \
    -DCMAKE_FIND_ROOT_PATH=$SYSROOT \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_C_FLAGS=$WASM_PTHREAD_FLAGS \
    -DCMAKE_CXX_FLAGS=$WASM_PTHREAD_FLAGS"
}

echo "[env] emcc=$(command -v emcc) ($(emcc --version | head -1 | grep -oE '[0-9.]+' | head -1))"
echo "[env] SYSROOT=$SYSROOT"
