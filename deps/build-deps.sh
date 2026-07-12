#!/usr/bin/env bash
# Cross-build GNU Radio's C++ dependencies to WASM into $SYSROOT.
# Idempotent-ish: rebuilds each dep. Requires sources already fetched under deps/src
# (spdlog v1.12.0, volk v3.1.2, boost_1_83_0). Run: bash wasm/deps/build-deps.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

# --- spdlog (bundled fmt), static, threaded ---------------------------------
emcmake cmake -S src/spdlog -B build/spdlog $(wasm_cmake_common_args) \
  -DSPDLOG_BUILD_SHARED=OFF -DSPDLOG_FMT_EXTERNAL=OFF \
  -DSPDLOG_BUILD_EXAMPLE=OFF -DSPDLOG_BUILD_TESTS=OFF -DSPDLOG_BUILD_BENCH=OFF
cmake --build build/spdlog --target install

# --- VOLK (generic kernels only; neon probe forced off for wasm) ------------
emcmake cmake -S src/volk -B build/volk $(wasm_cmake_common_args) -Wno-dev \
  -DPYTHON_EXECUTABLE="$WASM_ROOT/.venv/bin/python" \
  -DENABLE_TESTING=OFF -DENABLE_PROFILING=OFF -DENABLE_MODTOOL=OFF \
  -Dneon_compile_result=FALSE
cmake --build build/volk --target install

# --- Boost (custom clang-emscripten toolset; bundled emscripten.jam is the
#     obsolete fastcomp/bitcode flow and does not work with modern emsdk) -----
cd src/boost_1_83_0
cat > user-config.jam <<'JAM'
using clang : emscripten : em++ : <archiver>emar <ranlib>emranlib ;
JAM
[ -x ./b2 ] || ./bootstrap.sh
./b2 --user-config=./user-config.jam toolset=clang-emscripten \
  link=static variant=release threading=multi \
  --with-system --with-program_options --with-thread --with-regex --with-chrono \
  --with-atomic --with-date_time \
  cxxflags="-pthread -fPIC" cflags="-pthread -fPIC" \
  --prefix="$SYSROOT" -j"$(nproc)" install

echo "=== deps installed into $SYSROOT ==="
ls "$SYSROOT"/lib/lib{spdlog,volk,boost_thread,boost_program_options}.a
