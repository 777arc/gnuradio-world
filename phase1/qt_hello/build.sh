#!/usr/bin/env bash
# Build the Phase 1 Qt widget app for WebAssembly (threaded Qt 6.9.1).
set -euo pipefail
cd "$(dirname "$0")"
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
QT_WASM=/home/marc/Qt/6.9.1/wasm_multithread
QT_HOST=/home/marc/Qt/6.9.1/gcc_64
"$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST"
cmake --build build
echo "=== artifacts ==="; ls -la build/qt_hello.* 2>/dev/null
