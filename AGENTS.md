# AGENTS.md

Guide for AI agents working in this repository: architecture, build and test
instructions, and the non-obvious constraints that make the WASM build work.
Everything developer-facing lives here or in `docs/` — `README.md` is a short
user-facing pitch that points back to this file, and `CLAUDE.md` is a symlink to
it.

This file is what you need for almost any change. Per-task detail lives in
`docs/`; read the relevant one *in full* before starting that kind of work:

| doc | read it when |
|-----|--------------|
| [docs/adding-modules.md](docs/adding-modules.md) | adding a GNU Radio component library or vendoring an out-of-tree module — a self-contained checklist for both, plus the gr-satellites rebuilds |
| [docs/recording-viewer.md](docs/recording-viewer.md) | touching File Source, the R2 recording bucket and its CORS policy, recording tabs, or the SigMF viewer under `editor/src/recording/` |
| [docs/editor-ui.md](docs/editor-ui.md) | working on block IDs, auto-arrange, or the narrow-screen/touch layout |
| [docs/gui-layout.md](docs/gui-layout.md) | touching where QT GUI widgets go in the runner window — the GUI Layout block, `editor/src/gui-layout*.ts`, `runner/src/gui_layout.hpp`, or Arrange mode |
| [docs/ci.md](docs/ci.md) | changing a workflow, the deploy, or PR preview deployments |
| [docs/gnuradio-patches.md](docs/gnuradio-patches.md) | changing anything inside the `gnuradio/` submodule or `qtgui/` |
| [docs/double-mapped-buffer.md](docs/double-mapped-buffer.md) | working on the emulated vmcircbuf |
| [docs/diagnostics.md](docs/diagnostics.md) | working on the runner's `__grstats` snapshot, the debug panel, or the Benchmark Tool |
| [docs/embedded-python.md](docs/embedded-python.md) | touching the Embedded Python Block — Pyodide, the Python shim under `runner/src/pyodide/`, `blocks/src/python_block.hpp`, `editor/src/epy.ts`, or the Code field's CodeMirror in `editor/src/code-editor.ts` |

## Project overview

A GNU Radio Companion-style **flowgraph editor** and a **flowgraph runtime** that
run entirely in a browser tab — no Python, no server round-trips. The GNU Radio
DSP C++ stack (gnuradio-runtime, gr-blocks, gr-fft, gr-filter, gr-analog,
gr-digital, gr-fec, gr-dtv, gr-network, gr-pdu, gr-vocoder) and the gr-qtgui
sinks are cross-compiled to WebAssembly with Emscripten and threaded Qt 6 for
WebAssembly.

- `editor/`: a Vite/TypeScript GRC-style flowgraph editor. It started as a 1:1
  port of the `gnuradio/grc/gui_qt` Python GUI but has been adapted since. If any
  edit to the editor requests that it match the native version, use
  `gnuradio/grc/gui_qt` as the reference.
- `runner/`: a browser application that embeds GNU Radio's runtime, compiled as
  WASM. It parses `.grc` (which should be byte-compatible with native GNU Radio),
  creates blocks through a generated/custom registry, runs GNU Radio's
  thread-per-block scheduler, and embeds Qt GUI plots. It does things such as
  binding browser controls (Range widgets) to live block setters.
- `qtgui/`: the GNU Radio Qt GUI sink chain ported to Qt6 WASM. There are a lot
  of wasm-specific aspects to it, but it attempts to look just like the native
  version.
- `gnuradio/`: submodule of the main GNU Radio repo.
- `pyodide/`: CPython for WebAssembly, fetched (not committed) by
  `deps/fetch-pyodide.sh` and served same-origin. This is what makes GRC's
  Embedded Python Block work: a user's `gr.sync_block` subclass runs in a worker
  of its own. Only a flowgraph containing one fetches it, and numpy and scipy are
  vendored beside the interpreter — scipy fetched only by a block whose source
  imports it. See [docs/embedded-python.md](docs/embedded-python.md).
- Vendored out-of-tree GNU Radio modules (e.g. gr-rds) compiled as on-demand WASM
  side modules.
- `deps/`: dependency fetch/build scripts, and any patches needed. Built
  dependencies are installed into the generated, git-ignored `sysroot/`.
- `editor/recording/` + `editor/src/recording/`: a focused recording viewer
  adapted from IQEngine, giving every File Source — and every recording opened on
  its own — a tab showing the signal in a spectrogram-based interface. Part of
  the editor's own Vite build.

The editor passes a serialized `.grc` flowgraph to the runner. The runner is an
Emscripten `MAIN_MODULE`; deferred block categories are ABI-matched
`SIDE_MODULE`s loaded on demand with `dlopen`.

If the stack is already built, just run:

```bash
node server.mjs 8090 "$PWD"
# open http://localhost:8090/
```

## Architecture

```
┌──────────────────────────┐   flowgraph .grc    ┌──────────────────────────────┐
│  Editor  (TypeScript)     │ ──────────────────► │  Runner  (C++ → WASM)         │
│  GRC-style canvas, block   │  runner.html#<grc>  │  parse GRC → block registry   │
│  tree, properties dialog   │ ◄────────────────── │  → GR scheduler → gr-qtgui    │
│  editor/                   │   live plots        │  sinks on <canvas>            │
└──────────────────────────┘                     │  runner/                      │
                                                   └──────────────────────────────┘
```

- **Editor** (`editor/`, Vite + TypeScript): the block tree is generated from GNU
  Radio's `.block.yml` + `.tree.yml` files and follows the native GRC category
  hierarchy. In-tree definitions remain visible; blocks absent from the WASM
  registry are greyed out and cannot be placed. The editor supports
  place/connect/configure, right-click actions (cut/copy/paste, rotate,
  enable/disable, bypass), a Properties dialog, Edit ▸ Auto-Arrange Blocks, and a
  Run button that hands the flowgraph `.grc` to the runner. The editor canvas and
  embedded Qt GUI runner share tabs in the workspace, joined by one *recording
  tab* per File Source and per recording opened on its own. The recording viewer
  is part of this same Vite build, with the console remaining visible below any
  tab.
- **Runner** (`runner/`): a generic C++/WASM "player" — parses the flowgraph
  `.grc`, builds blocks via a `block-id → factory` registry, runs the GNU Radio
  thread-per-block scheduler, and renders gr-qtgui sinks to a canvas. Direct C++
  factories are generated from GRC's `cpp_templates`; handwritten factories in
  `src/registry.cpp` add browser widgets, live setters, and a few composed
  blocks. The generated and custom registries currently expose hundreds of blocks
  from gr-blocks, gr-analog, gr-fft, gr-filter, gr-digital, gr-dtv, gr-network,
  gr-pdu, gr-vocoder and gr-qtgui, plus the vendored out-of-tree modules
  (including but not limited to gr-rds, gr-foo, gr-dvbs2, gr-dvbs2rx,
  gr-satellites, gr-paint, gr-fosphor, gr-droneid, gr-ham, gr-ieee802-11). Stream and
  message-port connections are both serialized by the editor. QT GUI Range
  controls can be referenced by ID from numeric block parameters and update those
  parameters while the graph is running.
- **qtgui** (`qtgui/`): builds the gr-qtgui time/frequency/constellation/
  waterfall sinks (Qt5 upstream) against Qt 6 for WebAssembly, as a static lib
  the runner links.

The gr-fosphor Qt sink is a dual-backend GUI path (its standalone GLFW
counterpart is hidden — a separate desktop window has no browser meaning).
`runner.html` asks for a WebGPU adapter before starting such a flowgraph and
compiles the pipelines in `runner/src/fosphor_webgpu.js`; a C++ sink in
`blocks/overlays/gr-fosphor/` publishes IQ frames through a lock-free double
buffer in shared WASM memory, and WGSL does the window, 1024-point FFT, waterfall
and render without reading signal data back. It reproduces the native fosphor
visual model (persistent 1024x128 density histogram, upstream rise/decay
constants and palette, live and max-hold traces). If adapter, device, pipeline or
canvas setup fails, the registry constructs the Qt6 CPU spectrum/waterfall
hierarchy instead.

### Layout

| path | contents |
|------|----------|
| `deps/` | `env.sh` (pinned emsdk + sysroot), `fetch-deps.sh` (pinned dep sources) and `build-deps.sh` (cross-build VOLK, Boost, spdlog, GMP, FFTW, Qwt → `sysroot/`) |
| `gr/` | out-of-tree build of the GNU Radio C++ modules (generated; git-ignored) |
| `qtgui/` | Qt6 build of the gr-qtgui sink chain |
| `runner/` | the JSON-driven WASM flowgraph runner, generated C++ registry, support manifest, and shared side-module topology in `modules.json`; vendored headers under `third_party/` |
| `editor/` | the TypeScript flowgraph editor; `main.ts` owns browser orchestration while block schemas, validation, generated-library installation, and example/recording catalogs live in focused modules beside it |
| `tools/` | `block_overrides.py`, the browser-only block-metadata overlay loader/merger shared by `gen_registry.py` and `gen_blocklib.py` |
| `blocks/` | everything a human wrote about blocks, as opposed to `runner/`, which is the app plus everything generated. See "Where a block's source lives" |
| `blocks/grc/` | `.block.yml` for runner-only blocks with no upstream GNU Radio equivalent (`wasm_packet_rate_sink`, `wasm_text_sink`); read by *both* generators alongside GNU Radio's own yaml |
| `blocks/src/` | hand-written block implementations not owned by any one vendored module — `browser_file_source.cpp` and the like |
| `blocks/overlays/<module>/` | one directory per module: `metadata.yml` (every browser-only addition to that module's blocks) plus, for an OOT module, its `shims/` and any C++ rebuilt from a Python-only block. This is why the submodules need no fork. `blocks/overlays/gnuradio/` is the in-tree equivalent, metadata only |
| `runner/src/pyodide/` | the Embedded Python Block's worker and the Python shim a user's block runs against (`gnuradio.gr`'s base classes, `pmt`, the introspection and work driver). Copied to `runner/build/pyodide/` and served to both the runner and the editor |
| `docs/` | the per-task docs listed at the top of this file |
| `example_flowgraphs/` | the `.grc` files the editor's "Example Flowgraphs" palette tab lists recursively (nested directories appear as collapsible folders); several are also smoke-test cases. Each is linkable as `#example=<relative path without .grc>`. Test changes with `scripts/run_example.mjs` — see "Run and test" |
| `workers/sigmf-indexer/` | Cloudflare Queue consumer that rebuilds the recordings bucket's `index.json` — see [docs/recording-viewer.md](docs/recording-viewer.md) |
| `server.mjs` | COOP/COEP static dev server (needed for SharedArrayBuffer / pthreads); serves the repo root, falls back to `editor/dist/` for `/`, and synthesizes the `/example_flowgraphs` listing. Recording discovery and objects always come directly from R2 |
| `test/` | `test_smoke.mjs` and `test_lazy_scenarios.mjs` plus the `fixtures/` `.grc` they load; CI gates the deploy on both. `editor/test/` and `runner/test/` hold their own suites |
| `scripts/` | `assemble-site.mjs` (assembles the static site CI deploys to Pages), `serve_site.mjs` (serves it the way Pages does), `run.mjs` (headless-Chromium harness, waits on a page `#result`), `run_example.mjs` (opens an example in the real editor and presses Run), `r2-cors.json` |
| `editor/src/recording/` | the SigMF recording viewer, emitted at `/recording/` by the normal editor build |

## Toolchain and prerequisites

Supported baseline: Ubuntu 24.04. The repo can live anywhere — `deps/env.sh`, the
Qwt config, and the runner/qtgui `CMakeLists.txt` derive the repository root from
their own locations, while `$GR` selects the GNU Radio source submodule (CI sets
it explicitly). Only Qt is assumed to be under `~/Qt`; adjust the `QT_*`
variables if yours differs.

Userspace (no sudo) requirements:

- **emsdk 3.1.70** (matches Qt 6.9).
- **Qt 6.9.1 for WebAssembly (multithread) + host tools**, via `aqtinstall`.
- **Node ≥ 20** (for the editor build and the dev server; Ubuntu 24 ships 18).
- Dependency sources fetched under `deps/src/` (VOLK 3.1.2, Boost 1.83, spdlog
  1.12, GMP 6.3, FFTW 3.3.10, Qwt 6.2, CRCpp 1.2.2, and pinned turbofec).

System packages and toolchains on a fresh machine:

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

**Environment — re-run in every new shell:**

```bash
cd /path/to/gnuradio-world
source deps/env.sh                            # activates emsdk, exports $SYSROOT
export GR="$PWD/gnuradio"
export QT_HOST=~/Qt/6.9.1/gcc_64
export QT_WASM=~/Qt/6.9.1/wasm_multithread
# Optional build-time override; Vite otherwise defaults to
# https://recordings.gnuradioworld.com for the recording bucket.
export VITE_RECORDINGS_R2_BASE=https://recordings.gnuradioworld.com
```

## Build workflow

### 1. Fetch and cross-build the C++ dependencies → `sysroot/`

Two scripts; versions are pinned in `fetch-deps.sh` and nowhere else. Both are
idempotent, so re-running after a failure is cheap. `build-deps.sh` installs the
shared runner dependencies (spdlog, VOLK, Boost, FFTW in both precisions, GMP,
Qwt). The DroneID side module compiles the fetched turbofec C sources and
header-only CRCpp directly, so those two need no separate install step.

```bash
bash deps/fetch-deps.sh         # -> deps/src/   (skips what is present)
bash deps/build-deps.sh         # -> sysroot/    (needs QT_HOST + QT_WASM)
bash deps/fetch-pyodide.sh      # -> pyodide/    (optional; ~30 MB)
```

`fetch-pyodide.sh` is separate and optional: nothing in the C++ build needs it,
and a tree without it builds and runs fine — only a flowgraph containing an
Embedded Python Block notices, and its tests skip with a message. See
[docs/embedded-python.md](docs/embedded-python.md).

`DEPS_MIRROR=https://host/path` makes `fetch-deps.sh` pull the tarballs from a
mirror you control instead of SourceForge/ftp.gnu.org, which rate-limit CI
runners. `SYSROOT=/tmp/scratch bash deps/build-deps.sh` builds into a throwaway
prefix, which is how to test a change to the recipe without risking a working
tree.

### 2. Build GNU Radio and the WASM apps

```bash
# GR C++ modules: no Python, static, emulated (software) double-mapped vmcircbuf.
# -fPIC is required for the MAIN_MODULE/SIDE_MODULE dynamic linking (see below);
# -fexceptions keeps GR's own try/catch alive under Emscripten (see below).
# ENABLE_DEFAULT=OFF also disables gnuradio-runtime, so it has to be re-enabled
# explicitly -- without it every component fails its dependency check with
# "user force-enabled gr-blocks but configuration checked failed".
emcmake cmake -S "$GR" -B gr/build-gr -GNinja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="-pthread -fPIC -fexceptions" -DCMAKE_C_FLAGS="-pthread -fPIC" \
  -DCMAKE_INSTALL_PREFIX="$SYSROOT" -DCMAKE_PREFIX_PATH="$SYSROOT" -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
  -DENABLE_DEFAULT=OFF -DENABLE_PYTHON=OFF -DENABLE_GR_QTGUI=OFF -DENABLE_GR_AUDIO=OFF \
  -DENABLE_GNURADIO_RUNTIME=ON \
  -DENABLE_GR_ANALOG=ON -DENABLE_GR_BLOCKS=ON -DENABLE_GR_DIGITAL=ON \
  -DENABLE_GR_FFT=ON -DENABLE_GR_FILTER=ON -DENABLE_GR_FEC=ON -DENABLE_GR_DTV=ON \
  -DENABLE_GR_NETWORK=ON -DENABLE_GR_PDU=ON -DENABLE_GR_VOCODER=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_libunwind=ON
cmake --build gr/build-gr

# Regenerate direct C++ factories and the matching editor palette.
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json

# gr-qtgui sinks → runner (links core + emits per-category side modules) → editor
(cd qtgui  && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST" -DCMAKE_CXX_FLAGS="-pthread -fPIC" && cmake --build build)
(cd runner && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST" -DCMAKE_BUILD_TYPE=Release && cmake --build build)
(cd editor && npm install && npm run build)

# The editor build also emits /recording/index.html and its lazy viewer bundle;
# there is no separate IQEngine checkout or build.
```

> **Optimized vs. dev build.** `-DCMAKE_BUILD_TYPE=Release` runs the link-time
> `wasm-opt -Oz` pass on the core module (~100 MB → ~18 MB); the side modules are
> always built `-Oz`. Omit `-DCMAKE_BUILD_TYPE=Release` for a fast, unoptimized
> core when iterating (each optimized link adds ~1 min). Switching build type is a
> reconfigure, so re-run the `qt-cmake` line when you change it.

Build invariants to preserve:

- GNU Radio is built static, without Python or gr-audio/gr-qtgui.
- `ENABLE_DEFAULT=OFF` also disables the runtime, so `ENABLE_GNURADIO_RUNTIME=ON`
  must be explicit.
- All GNU Radio, runner, and side-module objects need `-pthread -fPIC`.
- Compile all of them with `-fexceptions`; setting it only at link time does not
  preserve C++ catch blocks under Emscripten.
- Disable `libunwind`; the WASM runtime uses `vmcircbuf_emulated`.
- Side modules must use `WASM_BIGINT` to match Qt's ABI. Existing CMake rules
  already enforce this.

After GNU Radio sources or block metadata change, always regenerate both the
runtime factories and the editor palette before rebuilding:

```bash
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
```

Do not hand-edit generated registry or palette artifacts; change source block
metadata (for a vendored module, its `blocks/overlays/<module>/metadata.yml`
rather than the submodule's own yaml), `runner/gen_registry.py`, or the
handwritten registry as appropriate, then regenerate.

### On-demand category modules

The runner is an Emscripten `MAIN_MODULE` that loads block categories on demand.
`gen_registry.py` splits the block factories into a core registrar
(blocks/analog/fft/filter, linked into the main module) and one self-registering
`generated_registry_<m>.cpp` per deferred category (including but not limited to
digital/dtv/network/pdu/vocoder). The runner CMake compiles each of those into a
`SIDE_MODULE` (`runner/build/<m>.wasm`); at run time `gr_run_json` inspects the
flowgraph and `emscripten_dlopen`s only the categories it uses. Constraints that
make this work (all handled by the build): everything is `-fPIC`; `MAIN_MODULE=2`
+ `EXPORT_ALL` + whole-archived core + a generated `side_exports.rsp` export every
symbol the side modules import; side modules use `-sWASM_BIGINT` to match Qt's
ABI; and `patch_runner_js.py` fixes a Qt+MAIN_MODULE `addFunction` assertion.
Verify with `node test/test_lazy_scenarios.mjs`.

## Run and test

Always serve the site through the repository server, because WASM pthreads and
`SharedArrayBuffer` require its COOP/COEP headers:

```bash
node server.mjs 8090 "$PWD"
# open http://localhost:8090/  → build a flowgraph → press ▶ Run
```

Useful validation:

```bash
node test/test_lazy_scenarios.mjs   # deferred category modules are fetched and dlopen'd
node test/test_smoke.mjs            # blocks actually move samples, not merely that it links
node scripts/run.mjs /runner/build/runner.html RUNNER_PASS
python3 runner/test/test_grworld.py     # the Embedded Python Block's Python contract
node test/test_python_block.mjs         # ... a flowgraph whose work() is Python
node test/test_python_block_editor.mjs  # ... and the editor deriving ports from code
```

The last three cover the Embedded Python Block. The two browser ones skip unless
`deps/fetch-pyodide.sh` has been run, which is why the Python Block is not a case
in `test_smoke.mjs` — the suite the deploy is gated on should not fail over an
optional runtime.

Both browser tests start their own COOP/COEP server on a private port, so they
need no `server.mjs` running; `scripts/run.mjs` does (port 8090 by default, hence
the server command above). `npm test` at the repository root runs the two of them.

For a fast out-of-tree module compile loop:

```bash
cmake --build runner/build --target side_modules
```

Once it compiles, do the full runner relink, rebuild the editor, and run the
headless smoke test. A `RUNNER_PASS` proves module loading, block construction,
and graph startup, but does not by itself prove DSP correctness.

### Example flowgraphs: test them through the editor

**When you add or edit anything in `example_flowgraphs/`, run it through the
actual editor before calling it done.** Those files are opened from the editor's
Example Flowgraphs tab and reach the runner via its Run button, and none of the
headless harnesses take that path — `scripts/run.mjs` and `test/test_smoke.mjs`
both hand the .grc straight to `runner.html`, skipping every step the editor
performs on the way. Two classes of bug live in that gap, and both are silent:

- **Parameter ids.** A hand-written `RUNNABLE` schema in `editor/src/main.ts`
  supersedes the generated one, and parameters it does not declare are dropped
  without a word, leaving the schema default in place. `analog_sig_source_x`
  declares `frequency`/`amplitude`, so a .grc written with GRC's own `freq`/`amp`
  loads with those values silently replaced. The runner reads
  `p.value("frequency", p.value("freq", …))` and accepts either, so such a
  flowgraph is *correct* fed directly to `runner.html` and *wrong* through the
  editor — it still runs, every block still moves samples, it just quietly
  computes something else. Take parameter ids from the hand-written schema for
  any block that has one.
- **Editor-side validation.** Connection type checks, required-parameter checks,
  port connectivity and expression resolution all happen in the editor. A
  flowgraph the runner would execute happily can still be refused before it ever
  gets there. Connectivity is the one that most often catches a hand-written
  file: as in native GRC, every port that is neither `optional` nor hidden needs
  a connection, so a dangling message output — gr-satellites' Message Counter
  emits both `out` and `count`, and upstream marks neither optional — turns its
  block title red and blocks the Run button. Terminate it (Message Debug's
  `store` port swallows a stream of PDUs silently) rather than leaving it open.

One command does it:

```bash
node server.mjs 8090 "$PWD" &                 # the editor has to be served
(cd editor && npm run build)                  # and built
node scripts/run_example.mjs satellites_ax25_afsk.grc
# → RESULT: EXAMPLE_PASS
```

It loads the example from the palette tab, presses Run, and fails on any of: the
editor refusing the flowgraph, `RUNNER_FAIL`, a block sitting at zero items, or a
flowgraph that contains a printing block (Message Debug and friends) yet printed
nothing — that last one being what catches the mis-parameterised case above,
which otherwise looks perfectly healthy. Add `--expect='<substring>'` to assert
specific console output, e.g. the hex of a frame you expect to decode.

`editor/test/example-flowgraphs.test.mjs` covers the cheap half of this in CI
(every example parses, and every arithmetic parameter is one `expr.ts` can
evaluate), but it does not run a browser, so it cannot see either failure above.

**Arrange every new example before committing it.** Open it in the editor, run
Edit ▸ Auto-Arrange Blocks, and save. Hand-placed coordinates — and especially
the ones an upstream GNU Radio example ships with — leave the flowgraph reading
as whatever its author's canvas looked like; arranging makes the whole palette
consistently left-to-right, and it is the one thing a reader sees before anything
else. Nothing but the coordinates changes, so it can never affect what the
flowgraph computes.

Two things to know when doing this in bulk rather than by hand:

- **Save is a lossy round-trip; auto-arrange is not.** The editor drops what its
  schema does not declare, so saving a file returns it without `import` blocks,
  without GRC's `affinity`/`alias`/`comment`/`maxoutbuf`/`minoutbuf`, without
  `gui_hint` (desktop GRC's widget placement, which this build does not
  implement — see the GUI Layout block below), and without most of the options
  block. Saving also *adds* one block, the GUI Layout singleton. That is fine for
  a flowgraph you authored in the editor and destructive for one adapted from
  upstream. When arranging in bulk, take the
  `states.coordinate`/`states.rotation` out of the saved file and merge those
  into the original rather than adopting the saved file wholesale.

**Delete `import` blocks rather than carrying them.** There is no Python in this
build, so an `import` is pure dead weight: the editor skips it on load (one
"skipped unsupported block" line per import, in the console pane where real
output belongs), and it is never placed by auto-arrange. Nothing needs it, either
— [`expr.ts`](../editor/src/expr.ts) resolves `math.*` and `numpy.*` from its own
registry, with no import statement involved. The one thing you give up is
round-tripping that file back into desktop GRC, whose generated Python *does*
need the import for those same expressions; for an example that exists to be run
in a browser, that is the right trade.

### The other suites

The editor suite and type checks run in deploy CI. Run the editor check locally
after changes under `editor/`; run the fast host parser test after changes to
the runner's GRC parsing or lowering headers:

```bash
(cd editor && npm run check)                  # type checks, Node test files, Vite build
(cd runner/test && g++ -std=c++17 -I../src -I../third_party grc_test.cpp -o grc_test && ./grc_test)
```

`editor/test` covers editor logic (`expr.ts`, `grc.ts`, selection/grid geometry)
that the smoke test cannot reach, including byte-exact `.grc` formatting — run it
after any change under `editor/src`. `runner/test/grc_test.cpp` is a host-compiled
regression test for the runner's `.grc` parser and lowering (`grc_yaml.hpp`,
`grc_lower.hpp`); those headers are deliberately GNU-Radio-free so it builds with
a plain host compiler in a second, with no Emscripten involved. `runner/test/`
also holds a few hand-written `.grc` fixtures for loading in the runner by hand;
nothing runs them automatically.

**Do not add a new `*.test.mjs` for every change.** A new suite is for a genuinely
new area of behavior — a new view, a new subsystem, a new file format concern.
Anything smaller belongs in the existing suite that already covers the code it
touches (a Save-path tweak goes in `example-link.test.mjs`, a schema tweak in
`grc.test.mjs`, and so on), and plenty of small changes need no new assertion at
all — running the existing suites is enough. `editor/test/run.mjs` discovers
`*.test.mjs` files automatically. The same restraint applies to `test/` at the
repository root and `runner/test/`.

## Where a block's source lives

One rule decides it: **`blocks/` is what a human wrote about blocks; `runner/` is
the app plus everything generated.** So `generated_registry*.cpp`,
`generated_modules.cpp` and `generated_blocks.json` stay under `runner/` — they
are build outputs — and the `gr-<m>/` submodules stay at the repository root,
because they are pristine checkouts rather than anything of ours.

Within `blocks/`:

| what | where |
|------|-------|
| metadata for a block with no upstream definition | `blocks/grc/<id>.block.yml` |
| its implementation, any browser replacement of an **in-tree** GNU Radio block, and any C++ rebuild of an in-tree Python hier block | `blocks/src/` — `<module>_hier.hpp` per GNU Radio module rebuilt |
| browser-only metadata for one module's blocks | `blocks/overlays/<module>/metadata.yml` |
| a headers-only stand-in for a host-only dependency | `blocks/overlays/gr-<m>/shims/` |
| C++ rebuilt from an **out-of-tree** module's Python-only block | `blocks/overlays/gr-<m>/` |

`blocks/overlays/gnuradio/` is the one directory holding metadata alone. The
GNU Radio submodule is not one module but fifteen, so there is no single module
to attribute its C++ to and no single module its block ids can be checked
against — which is exactly why `blocks/src/` exists and why `validate()` skips
the ownership check for that directory only. Everything else is uniform: a
module is a directory, and `block_overrides.load()` discovers it by name, so
adding a module is adding a directory rather than editing a list.

The overlay directories are on the compiler's include path (`GR_INCLUDE_DIRS` in
`runner/CMakeLists.txt`), so a rebuilt block's header resolves by bare name from
the generated registrar that constructs it. Keep those filenames unique across
modules — they share one flat search path.

## Registry and module conventions

Direct C++ factories are generated from GRC `.block.yml` `cpp_templates`.
The factory *table* — every `block-id → factory` entry, including the
hand-written ones needing browser widgets, live setters, or a browser-specific
composed block — lives in [`runner/src/registry.cpp`](runner/src/registry.cpp).
The classes those factories construct live in `blocks/` per the table above; the
table stays whole because it is the index.

The line between the two is **whether the code reads a flowgraph parameter**.
Anything taking a `const json&` — the `*_from()` decoders, the widget builders,
the `make_*()` factory helpers — is factory-side and stays in `registry.cpp`
beside the table. A block class, and the pure functions it is built out of (the
OFDM sync words, the PSK constellation), take plain C++ arguments and belong in
`blocks/`. That is what lets the block headers stay free of `nlohmann/json` and
of `BuiltBlock`.

- Add handwritten factory IDs to `CUSTOM_IDS` in `runner/gen_registry.py` to
  avoid duplicate generated factories.
- Put block metadata that cannot be rendered in `INVALID_CPP_TEMPLATES`, with a
  reason.
- A block that *builds* fine but should not be offered in the browser goes in
  `EXCLUDED_BLOCKS` instead, mapping its id to the reason the palette shows on
  hover. It stays visible and greyed out like a Python-only block, and its C++
  is left in place so re-enabling it is one line. `satellites_sat_3cat_1_deframer`
  is the worked example: see "Runtime gotchas".
- Python-only `gr.hier_block2` definitions are unavailable unless explicitly
  rebuilt as C++ hierarchies in `blocks/src/<module>_hier.hpp` (or, for
  gr-satellites, `blocks/overlays/gr-satellites/satellites_{hier,deframers}.cpp`).
- Blocks absent from the WASM registry remain visible but disabled in the editor
  palette.
- Symbol exports for side modules are generated automatically by
  `gen_side_exports.py`; do not maintain a manual export list.

`runner/generated_blocks.json` is the authoritative runtime support manifest,
used to mark palette entries runnable or unavailable. Blocks whose constructors
require a separately typed GRC companion object (an OFDM equalizer, packet
formatter, or message queue) are listed under `skipped` with a reason; the runner
has a small typed-object registry for the exceptions it does support —
constellation variables for Constellation Modulator, and gr-fec's CC Decoder
Definition (`variable_cc_decoder_def`), which `fec_async_decoder` and
`fec_extended_decoder` look up by name.

### Hand-written `.grc` fixtures

- Stream connections are arrays: `[block, port, block, port]`.
- Message connections are objects with `src_blk_id`, `src_port_id`,
  `snk_blk_id`, and `snk_port_id` (see `grc_lower.hpp`) — written as a *block*
  mapping, not an inline `{...}` one, which the runner's YAML subset ignores
  silently. See "Runtime gotchas" below.
- Parameter **expressions** depend on how the flowgraph reaches the runner. On
  the editor's Run path they are fine: `resolveParamsForRun()` in
  `editor/src/main.ts` evaluates every numeric/`raw` parameter through
  [`editor/src/expr.ts`](editor/src/expr.ts) — a Python-subset evaluator covering
  arithmetic, `math`/`numpy`/`firdes`, list literals and repetition — and hands
  the runner a *resolved* .grc. `example_flowgraphs/rds/rds_receiver.grc` relies on
  this (`2*math.pi/100`, `samp_rate/(2*math.pi*75e3)`).
  A .grc loaded **straight into `runner.html#<grc>`** gets no such pass: the C++
  side only inlines plain `variable` blocks and coerces numeric strings, so
  `1/8.0` or `255*8` fails there. That is the path `test_smoke.mjs` and
  `scripts/run.mjs` use, so any example added as a smoke case must have its
  arithmetic pre-computed (referencing a `variable` by name is still fine).
  So the split is: `example_flowgraphs/` keeps upstream's expression form (it is
  loaded through the editor) and `test/fixtures/` stays expression-free (it is
  loaded through the headless harness). `editor/test/example-flowgraphs.test.mjs`
  guards the first half — it parses every example and asserts each arithmetic
  parameter evaluates against that flowgraph's own variable scope, which is the
  failure that otherwise only shows up as a dead Run button.
- Enum and string parameters are *not* evaluated on either path; they reach the
  factory as raw text (`gr.GR_MSB_FIRST`, `'"CCSDS"'`), which is what
  `wasm_registry::choice()` normalizes.
- Which parameters get evaluated is `EVALUATED_DTYPES` in `main.ts`: the numeric
  dtypes, `raw`, and the vector dtypes. Vectors matter because GRC's commonest
  idiom of all — filter taps as `firdes.low_pass(...)` or `[1/sps] * sps` — is a
  `*_vector`, and a taps dtype is usually *templated* (`${ type.taps }` resolving
  through the `type` param's `option_attributes`), so `effectiveDtype()` has to
  resolve the template before the lookup. `editor/test/example-flowgraphs.test.mjs`
  re-implements both and asserts its copy of the set still matches main.ts.

## Runtime gotchas

- **Hand-written factories** (blocks needing a `QWidget`, live setters, or a
  browser-safe reimplementation) live in
  [`runner/src/registry.cpp`](runner/src/registry.cpp), over classes in `blocks/`;
  list their ids in `CUSTOM_IDS` in `gen_registry.py` so no duplicate generated
  factory is emitted.
- **A header `registry.cpp` includes is compiled with Qt's macros in scope**,
  and `emit` is one of them — it expands to nothing, so a member function called
  `emit()` compiles to `();` and the error points at the call site with
  "expected expression" rather than at the name. `signals` and `slots` are the
  other two. `blocks/src/text_sink.hpp` calls its line flusher `flush_line()`
  for exactly this reason. A block header pulled in only by a *side* module is
  unaffected: no Qt there.
- **A block that prints text has somewhere to print it.** A byte stream of
  characters — gr-ham's Varicode Decoder, say — goes to `wasm_text_sink`
  ("Text Sink"), which writes lines to the console pane; upstream flowgraphs end
  such a chain in a File Sink and open the file afterwards, which cannot work
  against Emscripten's in-memory filesystem. It is line-oriented because
  Emscripten's print hook only calls out to JS on a newline, so a Max Line Length
  break is what makes a decode that never sends one visible at all.
- **A correlator with a loose threshold can starve the main thread.**
  `satellites_sat_3cat_1_deframer` is in `EXCLUDED_BLOCKS` for this. Its
  syncword search accepts a 32-bit pattern with up to 4 bit errors, so on
  noise-like input it reports a frame constantly and runs a full decode on each
  one. At 200 kS/s the page stops responding altogether — not a crash and not a
  deadlock: the same flowgraph at 2 kS/s finishes in under a second, and
  `syncword_threshold: 0` clears it at full rate, which is what points at the
  search rather than the Reed-Solomon decode that several other deframers also
  use. Worth remembering when judging another block: measure at two rates and
  two thresholds before blaming the arithmetic.
- **Python hier blocks** (`gr.hier_block2` compositions such as PSK Mod or the
  OFDM Transmitter) have no C++ path at all, so the browser gets the same block
  id backed by the same chain rebuilt as a C++ `hier_block2` in
  `blocks/src/digital_hier.hpp` (`digital_psk_mod`, `digital_ofdm_tx`). Where the
  Python block computes defaults with numpy (the OFDM sync words), reproduce them
  exactly: numpy's legacy `RandomState(seed)` is MT19937 seeded identically to
  `std::mt19937(seed)`, and `randint(2)` is one 32-bit draw's low bit.
- **Python GUI blocks** are the same story with a `QWidget` instead of a chain:
  gr-rds's `rds_panel` is a Python QWidget, and it is the only place an RDS
  receiver ever shows its decoded ASCII, so `registry.cpp` rebuilds it as a
  message-sink block whose handler records the parser's `(type, text)` tuples and
  whose QTimer paints them (message handlers run on GR threads; widgets are
  main-thread only). See `example_flowgraphs/rds/rds_receiver.grc`.
- **`gui_hint` does nothing; one block arranges the whole window.** Where a
  widget goes is not a property of the block that owns it here. Every flowgraph
  carries a singleton **GUI Layout** block (`wasm_gui_layout`), auto-inserted
  like Options and undeletable, holding a dashboard-style grid of
  `block ID → [col, row, w, h]`; the runner renders it as a `QGridLayout` so the
  arrangement stretches with the browser tab. Three things follow. The packing
  rules live *only* in [`editor/src/gui-layout.ts`](editor/src/gui-layout.ts) —
  the C++ renders a spec and never edits one, so a drag has one definition and
  it is the one with tests. Whether a block *has* a widget is decided in C++, so
  it is carried to the editor by `GUI_IDS` in `gen_registry.py` → the `gui` flag
  in blocks.json, and a factory that grows a `QWidget` without an entry there
  silently loses its tile (the runner reports what it actually built, so the
  console names the drift). And a widget with no tile gets a full-width row
  *below* everything placed, at the same default height on both sides — an
  unarranged flowgraph must preview as what it runs as. See
  [docs/gui-layout.md](docs/gui-layout.md).
- **A QT GUI control is two objects, not one.** Most of GRC's "GUI Widgets/QT"
  family are Python QWidgets upstream, rebuilt in
  [`blocks/src/qtgui_controls.hpp`](blocks/src/qtgui_controls.hpp). Each is a
  *variable* (it publishes a value under its block ID, which
  `is_variable_control()` in `grc_lower.hpp` marks so run_now() builds it before
  anything else) and usually also a *message* block (a `state`/`value` port), and
  those cannot be the same object: a QWidget is not a `gr::block`. So the factory
  returns a `BuiltBlock` carrying both, and the flowgraph connects the block by
  the control's own name. Three things follow, and none is guessable:
  - **The value model is a double**, so a control's `type: string` option has
    nothing to publish. The factories throw by name and
    `blocks/overlays/gnuradio/metadata.yml` prunes the option, rather than
    letting the palette offer one the runtime always refuses.
  - **A state control announces itself in `start()`**, which upstream's Python
    widgets do not do. Without it a receiver wired to a Toggle Switch has no idea
    which way the switch is set until someone flips it, and gr-qtgui's own C++
    control (`edit_box_msg_impl::start`) already publishes its default this way.
    The Msg Push Button deliberately does not: a momentary trigger announces an
    event, and an event that did not happen must not be announced.
  - **`VARIABLE_CONTROL_IDS` in `editor/src/validation.ts` is a hand-kept copy of
    that C++ rule**, and the two drifting is silent: the editor refuses a
    parameter naming a control it does not know is one, with the wrong reason. A
    case in `editor/test/validation.test.mjs` asserts them equal against
    blocks.json.

  A control's own parameters are read when it is constructed, before any other
  control exists, so they cannot reference one — except QT GUI Label's Value,
  which is *bound* through a numeric setter rather than read, and so may name a
  control and track it. `example_flowgraphs/qtgui/control_widgets.grc` exercises
  every one of them.
- **Python blocks whose dependency is a browser capability** get rebuilt around
  the browser's version of it. gr-paint's `paint_image_source` ("Image File
  Source") decodes an image with PIL upstream; there is neither PIL nor a
  filesystem here, so
  [`blocks/overlays/gr-paint/paint_image_source.cpp`](blocks/overlays/gr-paint/paint_image_source.cpp)
  names a local picture or a URL and lets the platform decode it
  (`__grLoadImageSource` in `runner.html`). Two things generalize from it:
  - **A decode is asynchronous and a GNU Radio constructor is not.** The
    constructor only *starts* the job (returning an id); the wait is a futex in
    `work()`, on the source's own scheduler thread, where blocking stalls
    nothing else — the same split `BrowserFileSource` uses. Do not try to
    resolve it in the constructor: that runs on the browser main thread, which
    cannot block in a non-Asyncify build.
  - **A dimension the decode discovers is not available when buffers are sized.**
    Buffers are sized before any block's `start()`, so unlike the Python this
    block cannot `set_output_multiple(width)`; it emits at line granularity
    instead, tagging `image_width`/`line_num` at each line start.

  A **local picture** rides the same session-only binding a local recording
  does: `LOCAL_FILE_PARAMS` in `main.ts` names the parameter each such block
  keeps its file in, which is what puts a Browse control in its Properties
  dialog and rewrites that parameter to a `/local-files/...` path on the Run
  path. A `.grc` still stores only the file name. An image on another origin
  must be served with permissive CORS headers, which is why the
  `example_flowgraphs/paint/` examples paint same-origin assets from
  `editor/public/example_images/`.
- If a **core** hand-written factory references a **deferred** module's symbols
  (as `digital_psk_mod` uses a few `gr-digital` blocks), link that module's `.a`
  *normally* (not whole-archive) into the main module too, so just those objects
  are pulled into core; the rest stay in the side module. See the `gr-digital`
  entry in `target_link_libraries` for the pattern.
- If a **deferred** module's factory references *another deferred* module's
  symbols, the `.a` trick does not help: `gen_side_exports.py` re-exports with
  `--export-if-defined`, so a symbol nothing in main references is never pulled
  in, never defined, never exported, and the side module fails at `dlopen` with
  `bad export type for '<mangled name>': undefined`. Add the edge to
  `module_deps` in `runner/modules.json` instead — gr-satellites' rebuilt
  hierarchies use `gr::pdu`, hence `"module_deps": {"satellites": ["pdu"]}`.
- **The runner's YAML parser accepts flow *sequences* but not flow *mappings*.**
  A message connection written inline as
  `- {src_blk_id: a, src_port_id: out, ...}` is **silently dropped** — the graph
  builds and runs, and only the missing PDUs give it away. Use the block-mapping
  form GRC and the editor actually emit:
  ```yaml
  -   src_blk_id: a
      src_port_id: out
      snk_blk_id: b
      snk_port_id: in
  ```
- **`pdu_pdu_to_tagged_stream` has zero stream inputs** and in practice is not
  scheduled in this runtime, so a PDU chain terminated with it sits at zero
  items. Terminate with `pdu_pdu_to_stream_x` ("PDU To Stream", a plain
  `sync_block`) instead — that is also how the smoke fixtures make message-only
  chains observable to the item counters.
- **Use `blocks_throttle2` ("Throttle"), never `blocks_throttle`.** Upstream
  deprecated the latter as "Throttle (old)"; both wrap the same
  `gr::blocks::throttle`, but only throttle2 exposes `limit`/`maximum`. Without
  that cap a throttle sleeps in proportion to the whole buffer it is handed, so a
  low rate on a wide stream stalls visibly: a 1200 B/s throttle in front of a
  65536-item buffer emits nothing for ~55 s. `limit: time` with `maximum: 0.1`
  bounds the sleep; `limit: auto` (the default) reproduces the old behavior
  exactly. Also put one throttle at the highest rate in the graph and let
  backpressure pace everything upstream, rather than throttling a slow payload
  stream. The old block is kept registered and loadable for existing .grc files —
  `PALETTE_HIDDEN` in `main.ts` keeps it out of the palette, and `main.ts`'s
  `LEGACY_PARAM_IDS` maps the `samp_rate` spelling this editor used onto GRC's
  own `samples_per_second` on load — but nothing in the repo should use it.
- **Message-only blocks report `items: 0` forever** — `gr_stats_json()` reads
  `nitems_written`/`nitems_read`, which do not exist for a block with no stream
  ports. The snapshot flags them as `msg_only` and `test_smoke.mjs` exempts them
  from its "every block moved items" rule.
- **Exception catching is a compile-time flag.** Emscripten drops landing pads
  unless `-fexceptions` (≡ `-sNO_DISABLE_EXCEPTION_CATCHING`) is on the *compile*
  line — having it only at link makes every `try`/`catch` in that object inert, so
  a bad block parameter escapes as an opaque `Uncaught <pointer>` that kills the
  runtime instead of surfacing as `RUNNER_FAIL: <message>`. Everything is compiled
  with it: the runner target, the side modules, and the `build-gr` GR libraries
  (so GR's `thread_body_wrapper` catches an exception thrown from a block's
  `work()` and logs it instead of killing the worker).
- **What a running flowgraph prints reaches the editor's console pane.** Blocks
  that report to the user do it by printing — Message Debug dumps each PDU, Print
  Header / Print Timestamp annotate frames — and Emscripten sends that to
  console.log, i.e. devtools, where nobody looks. `runner.html` sets Emscripten's
  `print` hook to also batch the lines to the parent frame as a `gr-print`
  message, which `main.ts` appends to `#log` under the canvas. Batched and capped
  at both ends because a Message Debug on a fast frame source emits well over a
  thousand lines a second; the editor reports what it shed. Note this is *stdout*,
  which is separate from the GR logger below.
- **The editor drops parameters its schema does not declare, silently.** See
  "Example flowgraphs" above — this is the same trap from the authoring side, and
  it is worth knowing before hand-writing any `.grc`.
- **GR's logger needs a sink installed by hand.** `gr::logging` picks its sink
  from the `log_file` pref, which is empty in the browser (no config file), so the
  default backend has *no* sinks and silently drops every message — and
  Emscripten's stdout/stderr are not visible here either. `runner.cpp` registers a
  `BrowserLogSink` that mirrors error-level records into the flowgraph window and
  posts them to the editor. Preserve it: without it, a block that throws out of
  `work()` looks like a graph that simply produces nothing.
- **Symbol export is automatic:** `gen_side_exports.py` scans each side module's
  `env`/GOT imports and re-exports them from main with `--export-if-defined`, so
  you don't maintain an export list by hand. Side modules must stay ABI-matched to
  Qt (`-pthread -fPIC -sWASM_BIGINT=1`); the CMake rule already applies these.
- **Enum params** whose `.block.yml` has `cpp_templates: translations` that rewrite
  option strings (e.g. `analog.cpm.` → `analog::cpm::`) just work:
  `wasm_registry::choice` matches with `::`/`.` normalized.
- **A PMT parameter is parsed, not evaluated.** Native GRC renders Message
  Strobe's message or a Tag Object's key by running `pmt.intern("TEST")` as
  Python. There is none here, and [`expr.ts`](editor/src/expr.ts) stops at
  numbers and vectors on purpose, so such a parameter is retyped to the
  browser-only `pmt` dtype in `blocks/overlays/<module>/metadata.yml` and reaches
  the runner as its own source text, which `wasm_registry::pmt_value()` parses
  (`intern`, `from_*`, `cons`, `dict_add`, the `init_*vector`s; anything else
  throws by name rather than being interned as its own text). The .grc keeps the
  Python spelling, so it still round-trips to desktop GRC. Note the parser is the
  *parameter* path only — a PMT crossing into the Embedded Python Block's worker
  is a separate, unbuilt bridge (see [docs/embedded-python.md](docs/embedded-python.md)).
- **Tag Object is a variable, not a block.** `variable_tag_object` builds one
  `gr::tag_t` into `wasm_registry::runtime_tag_objects()` before any block is
  constructed — the same pre-pass `variable_constellation` uses, listed in
  `is_runtime_object()` in `runner.cpp` — and Vector Source's `tags` parameter
  names it. A block that grows a tag-list parameter resolves it the same way,
  through `wasm_registry::tag_objects()`.
- **A block whose work() is not C++ blocks its own scheduler thread and nothing
  else.** The Embedded Python Block runs a user's `work()` in Pyodide in a Web
  Worker, and rendezvous is a futex: the GR thread posts a request into a control
  block in shared memory and `emscripten_futex_wait`s for the answer. Two rules
  fall out of it, and they apply to any future off-thread block. A **constructor
  cannot wait** — it runs on the browser main thread, where `Atomics.wait` is
  illegal — so anything needed at construction (an io signature, `set_history`,
  `set_output_multiple`) is settled in a *prepare* step before any block is built;
  see `prepare_python_then_run` in `runner.cpp`. And a **call back into C++ from
  inside work() cannot be synchronous**, because the thread that would service it
  is the one asleep: `consume`/`produce`/tags are recorded on the far side and
  applied when work() returns, and anything the far side needs to *read* is
  pre-supplied with the request. Same reason the main thread can only ever
  fire-and-forget: a QT GUI Range driving a Python parameter writes a value and
  ORs a dirty bit, and the worker drains it between work() calls. See
  [docs/embedded-python.md](docs/embedded-python.md).
- **A block's parameters and ports are usually a property of its block id — the
  Embedded Python Block's are not.** They come from its own source, so the editor
  reads definitions for an instance through `defFor(inst)` in `main.ts`, never
  `RUNNABLE[inst.id]`, and `validateFlowgraph` takes a `def` accessor for the same
  reason. New code that looks a definition up by id will silently give a Python
  Block the generic schema, losing every parameter and port it declared.
- **No true double-mapped memory.** Emscripten cannot create VM aliases; the
  emulated buffer uses twice the physical memory and copies produced bytes into
  its mirror. See [docs/double-mapped-buffer.md](docs/double-mapped-buffer.md).
- **FFTW** uses `FFTW_ESTIMATE` under WASM because `FFTW_MEASURE` benchmarking
  hangs there.
- **Host-only dependencies** such as UHD, Boost.Asio networking, Boost.Locale, and
  libsndfile need an Emscripten guard, a browser-safe replacement, or exclusion of
  the affected block. See [docs/adding-modules.md](docs/adding-modules.md) for the
  standard fixes.
