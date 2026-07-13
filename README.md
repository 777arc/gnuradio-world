# GNU Radio in the browser (WebAssembly)

A GNU Radio Companion-style **flowgraph editor** and a **flowgraph runtime** that
run entirely in a browser tab — no Python, no server round-trips. The GNU Radio
DSP C++ stack (gnuradio-runtime, gr-blocks, gr-fft, gr-filter, gr-analog) and the
gr-qtgui sinks are cross-compiled to WebAssembly with Emscripten and threaded
Qt 6 for WebAssembly.

## Quickstart (fresh Ubuntu 24.04)

Builds the whole stack from source and serves the editor. **Assumes the repo is at
`/home/marc/gnuradio` and Qt installs under `~/Qt`** — `wasm/deps/env.sh`, the Qwt
config, and the runner/qtgui `CMakeLists.txt` hard-code these paths; edit them (and
the `QT_*` vars below) if yours differ.

**1. Toolchains and system packages**

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build git curl \
  python3 python3-venv python3-pip pipx autoconf bzip2 xz-utils

# Node 20 (Ubuntu 24 ships 18; the editor build needs >= 20)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Emscripten 3.1.70 (matches Qt 6.9)
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install 3.1.70 && ~/emsdk/emsdk activate 3.1.70

# Qt 6.9.1: host tools + threaded WebAssembly, into ~/Qt
pipx install aqtinstall
aqt install-qt linux desktop 6.9.1 linux_gcc_64      -O ~/Qt
aqt install-qt all_os wasm    6.9.1 wasm_multithread -O ~/Qt
```

**2. Environment** (re-run in each new shell)

```bash
cd /home/marc/gnuradio
source wasm/deps/env.sh                       # activates emsdk, exports $SYSROOT
export GR=/home/marc/gnuradio
export QT_HOST=~/Qt/6.9.1/gcc_64
export QT_WASM=~/Qt/6.9.1/wasm_multithread
```

**3. Fetch dependency sources** into `wasm/deps/src/`

```bash
mkdir -p wasm/deps/src && cd wasm/deps/src
git clone --branch v1.12.0 --depth 1             https://github.com/gabime/spdlog.git spdlog
git clone --branch v3.1.2  --depth 1 --recursive https://github.com/gnuradio/volk.git  volk
curl -L https://archives.boost.io/release/1.83.0/source/boost_1_83_0.tar.bz2 | tar xj
curl -L https://www.fftw.org/fftw-3.3.10.tar.gz     | tar xz
curl -L https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz | tar xJ
curl -L https://sourceforge.net/projects/qwt/files/qwt/6.2.0/qwt-6.2.0.tar.bz2 | tar xj
cd "$GR"
```

**4. Cross-build the C++ dependencies → `sysroot/`**

```bash
python3 -m venv wasm/.venv && wasm/.venv/bin/pip install mako   # VOLK's kernel generator
bash wasm/deps/build-deps.sh                                    # spdlog, VOLK, Boost

# FFTW — double then single precision
cd wasm/deps/src/fftw-3.3.10
emconfigure ./configure --enable-threads --with-combined-threads --disable-fortran \
  --disable-shared --enable-static --prefix="$SYSROOT" CFLAGS="-pthread -O2"
emmake make -j"$(nproc)" install && emmake make clean
emconfigure ./configure --enable-float --enable-threads --with-combined-threads --disable-fortran \
  --disable-shared --enable-static --prefix="$SYSROOT" CFLAGS="-pthread -O2"
emmake make -j"$(nproc)" install
cd "$GR"

# GMP
cd wasm/deps/src/gmp-6.3.0
emconfigure ./configure --disable-assembly --enable-cxx --disable-shared \
  --prefix="$SYSROOT" CFLAGS="-pthread -O2 -fPIC" CXXFLAGS="-pthread -O2 -fPIC"
emmake make -j"$(nproc)" install
cd "$GR"

# Qwt 6.2 — cross-built with the host qmake pointed at the wasm Qt
cd wasm/deps/src/qwt-6.2.0
printf '\nQWT_INSTALL_PREFIX  = %s\nQWT_INSTALL_HEADERS = %s/include\nQWT_INSTALL_LIBS    = %s/lib\n' \
  "$SYSROOT" "$SYSROOT" "$SYSROOT" >> qwtconfig.pri
"$QT_HOST/bin/qmake6" -qtconf "$QT_WASM/bin/target_qt.conf" qwt.pro
make -j"$(nproc)" && make install                 # if it tries to build the designer plugin,
cd "$GR"                                           # add: QWT_CONFIG -= QwtDesigner QwtExamples QwtPlayground
```

**5. Build GNU Radio and the WASM apps**

```bash
# GR C++ modules: no Python, static, emulated (software) double-mapped vmcircbuf
emcmake cmake -S "$GR" -B wasm/gr/build-gr -GNinja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-pthread -DCMAKE_C_FLAGS=-pthread \
  -DCMAKE_INSTALL_PREFIX="$SYSROOT" -DCMAKE_PREFIX_PATH="$SYSROOT" -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
  -DENABLE_PYTHON=OFF -DENABLE_GR_QTGUI=OFF -DENABLE_GR_AUDIO=OFF \
  -DENABLE_GR_ANALOG=ON -DENABLE_GR_BLOCKS=ON -DENABLE_GR_FFT=ON -DENABLE_GR_FILTER=ON \
  -DTRY_SHM_VMCIRCBUF=OFF -DCMAKE_DISABLE_FIND_PACKAGE_libunwind=ON
cmake --build wasm/gr/build-gr

# gr-qtgui sinks → runner (links everything) → editor
(cd wasm/qtgui  && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST" && cmake --build build)
(cd wasm/runner && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST" && cmake --build build)
(cd wasm/editor && npm install && npm run build)
```

**6. Run**

```bash
node wasm/server.mjs 8090 wasm
# open http://localhost:8090/editor/dist/index.html  → build a flowgraph → press ▶ Run
```

The sections below explain the architecture and each component in more detail.

## Architecture

```
┌──────────────────────────┐   flowgraph JSON    ┌──────────────────────────────┐
│  Editor  (TypeScript)     │ ──────────────────► │  Runner  (C++ → WASM)         │
│  GRC-style canvas, block   │  runner.html#<json> │  parse JSON → block registry  │
│  tree, properties dialog   │ ◄────────────────── │  → GR scheduler → gr-qtgui    │
│  wasm/editor/              │   live plots        │  sinks on <canvas>            │
└──────────────────────────┘                     │  wasm/runner/                 │
                                                   └──────────────────────────────┘
```

- **Editor** (`editor/`, Vite + TypeScript): the block tree is generated from GNU
  Radio's `.block.yml` + `.tree.yml` files; supports place/connect/configure,
  right-click menu (cut/copy/paste, rotate, enable/disable, bypass), a Properties
  dialog, and a Run button that hands the flowgraph JSON to the runner.
- **Runner** (`runner/`): a generic C++/WASM "player" — parses the flowgraph JSON,
  builds blocks via a `block-id → factory` registry (`src/registry.cpp`), runs the
  GNU Radio thread-per-block scheduler, and renders gr-qtgui sinks to a canvas.
  Type-parameterized blocks (sources, throttle/head, add/sub/multiply/divide,
  multiply-const, time sink) take a `type` param (`complex`/`float`); converters
  (complex↔float, complex-to-mag) bridge the two.
- **qtgui** (`qtgui/`): builds the gr-qtgui time/frequency sinks (Qt5 upstream)
  against Qt 6 for WebAssembly, as a static lib the runner links.

## Layout

| path | contents |
|------|----------|
| `deps/` | `env.sh` (pinned emsdk + sysroot) and `build-deps.sh` (cross-build VOLK, Boost, spdlog, GMP, FFTW, Qwt → `sysroot/`) |
| `gr/` | out-of-tree build of the GNU Radio C++ modules (generated; git-ignored) |
| `qtgui/` | Qt6 build of the gr-qtgui sink chain |
| `runner/` | the JSON-driven WASM flowgraph runner |
| `editor/` | the TypeScript flowgraph editor |
| `tools/` | `generate_cpp.py` (host-side GRC → C++ generation, optional) |
| `server.mjs` | COOP/COEP static dev server (needed for SharedArrayBuffer / pthreads) |
| `run.mjs` | headless-Chromium test harness (waits on a page `#result`) |

## Prerequisites (userspace, no sudo)

- **emsdk 3.1.70** (matches Qt 6.9): `~/emsdk/emsdk install 3.1.70 && ~/emsdk/emsdk activate 3.1.70`.
- **Qt 6.9.1 for WebAssembly (multithread) + host tools**, via `aqtinstall`:
  `aqt install-qt linux desktop 6.9.1 linux_gcc_64` and
  `aqt install-qt all_os wasm 6.9.1 wasm_multithread` (into `/home/marc/Qt`).
- **Node ≥ 20** (for the editor build and the dev server).
- Dependency sources fetched under `deps/src/` (VOLK 3.1.2, Boost 1.83, spdlog
  1.12, GMP 6.3, FFTW 3.3.10, Qwt 6.2). Paths are currently hard-coded to this
  checkout; see `deps/env.sh`.

## Build

```bash
source wasm/deps/env.sh                 # pinned emsdk + $SYSROOT
bash   wasm/deps/build-deps.sh          # VOLK/Boost/spdlog/GMP/FFTW/Qwt → sysroot
# GNU Radio C++ modules → wasm/gr/build-gr  (emcmake, ENABLE_PYTHON=OFF, static,
#   -DTRY_SHM_VMCIRCBUF=OFF; see git history / env.sh for the exact configure line)
(cd wasm/qtgui  && $QT_WASM/bin/qt-cmake -S . -B build -GNinja -DQT_HOST_PATH=$QT_HOST && cmake --build build)
(cd wasm/runner && $QT_WASM/bin/qt-cmake -S . -B build -GNinja -DQT_HOST_PATH=$QT_HOST && cmake --build build)
(cd wasm/editor && npm install && npx vite build)
```

## Run

```bash
node wasm/server.mjs 8090 wasm          # COOP/COEP dev server
# open http://localhost:8090/editor/dist/index.html  → build a flowgraph → ▶ Run
```

`node wasm/run.mjs /runner/build/runner.html RUNNER_PASS` runs the runner headless.

## GNU Radio source changes (all guarded, desktop build unaffected)

- `gnuradio-runtime/lib/thread/thread.cc` — `__EMSCRIPTEN__` branch (no prctl/affinity).
- `gnuradio-runtime/lib/constants.cc.in` — fixed prefix under WASM (no `boost::dll`).
- `gnuradio-runtime/lib/CMakeLists.txt` — libunwind made optional.
- `gnuradio-runtime/lib/pmt/CMakeLists.txt`, `gr-fft`, `gr-blocks`, `gr-analog`
  `lib/CMakeLists.txt` — register libs for install/export in static builds too.
- `gr-fft/lib/fft.cc` — use `FFTW_ESTIMATE` under WASM (`FFTW_MEASURE` benchmarking
  hangs there).

Build without `FORCE_SINGLE_MAPPED`, with `-DTRY_SHM_VMCIRCBUF=OFF` and
`-DCMAKE_DISABLE_FIND_PACKAGE_libunwind=ON`. The runtime selects
`vmcircbuf_emulated`: a contiguous 2N-byte software mirror that preserves the
native double-mapped scheduler and pointer behavior, then synchronizes completed
writes before publishing them to readers. It uses twice the physical buffer memory
and one mirror copy per produced byte because WebAssembly cannot create true VM
aliases. See [docs/double-mapped-buffer.md](docs/double-mapped-buffer.md).
