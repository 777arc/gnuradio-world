# GNU Radio in the browser (WebAssembly)

A GNU Radio Companion-style **flowgraph editor** and a **flowgraph runtime** that
run entirely in a browser tab — no Python, no server round-trips. The GNU Radio
DSP C++ stack (gnuradio-runtime, gr-blocks, gr-fft, gr-filter, gr-analog) and the
gr-qtgui sinks are cross-compiled to WebAssembly with Emscripten and threaded
Qt 6 for WebAssembly.

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
