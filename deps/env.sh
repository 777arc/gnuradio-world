#!/usr/bin/env bash
# Common environment for cross-building GNU Radio's C++ dependencies to WASM.
# Source this: `source deps/env.sh`
set -euo pipefail

# Pinned Emscripten (matches Qt 6.9).
~/emsdk/emsdk activate 3.1.70 >/dev/null 2>&1 || true
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1

# Derived from this file's location so the checkout can live anywhere (CI clones
# into $GITHUB_WORKSPACE); both are overridable from the environment.
export WASM_ROOT="${WASM_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export SYSROOT="${SYSROOT:-$WASM_ROOT/sysroot}"   # install prefix for all deps
export DEPS_SRC="${DEPS_SRC:-$WASM_ROOT/deps/src}"
mkdir -p "$SYSROOT"

# Every object must be built -pthread so it is ABI-compatible with threaded Qt
# and GNU Radio's thread-per-block scheduler. -fPIC is required too: the runner
# is an Emscripten MAIN_MODULE that dlopens per-category SIDE_MODULEs, and dynamic
# linking rejects any non-PIC input (Qt/VOLK/Boost/GMP are already PIC; our own
# libs — GR, qtgui, qwt, fftw, spdlog — must be built with -fPIC). See the
# WebAssembly lazy-category-module notes.
export WASM_PTHREAD_FLAGS="-pthread -fPIC"

# CMake args shared by all Emscripten dep builds. `emcmake` supplies the
# Emscripten toolchain; we point find_package at our sysroot.
#
# An array, not an echoed string: `$(...)` word-splits the result, which tears
# -DCMAKE_C_FLAGS="-pthread -fPIC" into two arguments and makes cmake reject a
# stray "-fPIC". Use it as: emcmake cmake -S ... "${WASM_CMAKE_ARGS[@]}" ...
WASM_CMAKE_ARGS=(
  -GNinja
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$SYSROOT"
  -DCMAKE_PREFIX_PATH="$SYSROOT"
  -DCMAKE_FIND_ROOT_PATH="$SYSROOT"
  -DBUILD_SHARED_LIBS=OFF
  -DCMAKE_C_FLAGS="$WASM_PTHREAD_FLAGS"
  -DCMAKE_CXX_FLAGS="$WASM_PTHREAD_FLAGS"
)

echo "[env] emcc=$(command -v emcc) ($(emcc --version | head -1 | grep -oE '[0-9.]+' | head -1))"
echo "[env] SYSROOT=$SYSROOT"
