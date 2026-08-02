# AGENTS.md

Guide for AI agents working in this repository: build instructions, architecture,
per-task checklists, and the non-obvious constraints that make the WASM build
work. Everything developer-facing lives here — `README.md` is a short
user-facing pitch that points back to this file, and `CLAUDE.md` is a symlink to
it.

## Project overview

A GNU Radio Companion-style **flowgraph editor** and a **flowgraph runtime** that
run entirely in a browser tab — no Python, no server round-trips. The GNU Radio
DSP C++ stack (gnuradio-runtime, gr-blocks, gr-fft, gr-filter, gr-analog,
gr-digital, gr-fec, gr-dtv, gr-network, gr-pdu, gr-vocoder) and the gr-qtgui
sinks are cross-compiled to WebAssembly with Emscripten and threaded Qt 6 for
WebAssembly.

- `editor/`: a Vite/TypeScript GNU Radio Companion-style flowgraph editor. It
  started as a 1:1 port of the gnuradio/grc/gui_qt Python-based GUI but has been
  adapted since. If any edit to the editor requests that it match the native
  version, use `gnuradio/grc/gui_qt` as the reference.
- `runner/`: a browser application that embeds GNU Radio's runtime, compiled as
  WASM. It parses `.grc` (which should be byte-compatible with native GNU Radio),
  creates blocks through a generated/custom registry, runs GNU Radio's
  thread-per-block scheduler, and embeds Qt GUI plots. It does things such as
  binding browser controls (Range widgets) to live block setters.
- `qtgui/`: the GNU Radio Qt GUI sink chain ported to Qt6 WASM. There are a lot
  of wasm-specific aspects to it, but it attempts to look just like the native
  version.
- `gnuradio/`: submodule of the main GNU Radio repo.
- Vendored out-of-tree GNU Radio modules (e.g., gr-rds) compiled as on-demand WASM side modules.
- `deps/`: dependency fetch/build scripts, and any patches needed. Built
  dependencies are installed into the generated, git-ignored `sysroot/`.
- `editor/recording/` + `editor/src/recording/`: the focused recording viewer
  adapted from IQEngine, which gives every File Source a recording tab showing
  the signal in a spectrogram-based interface. It is a second entry of the
  editor's own Vite build and includes only the SigMF URL/blob reader,
  spectrogram, Time/Frequency/IQ plots, settings, annotations and the metadata
  summary used here — no backend, plugins, Cyclostationary UI, Pyodide, or
  metadata editors.

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
  enable/disable, bypass), a Properties dialog, Edit ▸ Auto-Arrange Blocks (see
  below), and a Run button that hands the flowgraph `.grc` to the runner. The editor canvas and embedded Qt GUI runner
  share tabs in the workspace, joined by one *recording tab* per File Source
  (see below). The recording viewer is part of this same Vite build, with the
  console remaining visible below any tab.
- **Runner** (`runner/`): a generic C++/WASM "player" — parses the flowgraph
  `.grc`, builds blocks via a `block-id → factory` registry, runs the GNU Radio
  thread-per-block scheduler, and renders gr-qtgui sinks to a canvas. Direct C++
  factories are generated from GRC's `cpp_templates`; handwritten factories in
  `src/registry.cpp` add browser widgets, live setters, and a few composed
  blocks. The generated and custom registries currently expose hundreds of blocks from
  gr-blocks, gr-analog, gr-fft, gr-filter, gr-digital, gr-dtv, gr-network,
  gr-pdu, gr-vocoder and gr-qtgui, plus the vendored out-of-tree modules (including but not limited to gr-rds, gr-foo, gr-dvbs2, gr-dvbs2rx, gr-satellites, gr-paint). Stream and message-port connections are both
  serialized by the editor. QT GUI Range controls can be referenced by ID from
  numeric block parameters and update those parameters while the graph is
  running.
- **qtgui** (`qtgui/`): builds the gr-qtgui time/frequency/constellation/waterfall sinks
  (Qt5 upstream) against Qt 6 for WebAssembly, as a static lib the runner links.

### Layout

| path | contents |
|------|----------|
| `deps/` | `env.sh` (pinned emsdk + sysroot), `fetch-deps.sh` (pinned dep sources) and `build-deps.sh` (cross-build VOLK, Boost, spdlog, GMP, FFTW, Qwt → `sysroot/`) |
| `gr/` | out-of-tree build of the GNU Radio C++ modules (generated; git-ignored) |
| `qtgui/` | Qt6 build of the gr-qtgui sink chain |
| `runner/` | the JSON-driven WASM flowgraph runner, generated C++ registry, and support manifest |
| `editor/` | the TypeScript flowgraph editor |
| `tools/` | `block_overrides.py` (the browser-only block-metadata overlay loader/merger shared by `gen_registry.py` and `gen_blocklib.py`) and `generate_cpp.py` (host-side GRC → C++ generation, optional) |
| `runner/oot_cpp_templates/` | one `gr-<m>.yml` per out-of-tree module, holding every browser-only addition to its blocks (`cpp_templates`, retyped params, pruned enum options). This is why the OOT submodules need no fork; `runner/block_overrides.yml` is the same thing for blocks in the `gnuradio/` submodule |
| `blocks/grc/` | `.block.yml` for runner-only blocks with no upstream GNU Radio equivalent (`wasm_packet_rate_sink`); read by *both* `gen_registry.py` and `gen_blocklib.py` alongside GNU Radio's own yaml |
| `docs/` | `double-mapped-buffer.md` (the emulated vmcircbuf) and `diagnostics.md` (the runner's `__grstats` snapshot and debug panel, which the smoke test asserts against) |
| `example_flowgraphs/` | the `.grc` files the editor's "Example Flowgraphs" palette tab lists recursively (files may be organized in nested directories, which appear as collapsible folders); several are also smoke-test cases. Each is directly linkable as `#example=<relative path without .grc>` (the 🔗 on its palette entry copies that link). Test changes here with `scripts/run_example.mjs`, which drives the real editor — see "Run and test" |
| `example_recordings/` | Historical/local recording copies used by a few tests and the one-time R2 metadata migration utility. Do not add production recordings here. The application and site assembly do not discover, copy, or serve this directory. Production discovery comes exclusively from R2's generated `index.json`. |
| `workers/sigmf-indexer/` | Scheduled Cloudflare Worker bound to the recordings R2 bucket. Daily at 09:00 UTC (4:00 AM EST) it pairs `.sigmf-data`/`.sigmf-meta` keys, derives the searchable metadata and byte/sample counts, and atomically replaces the bucket's `index.json`. It also has a bearer-protected manual rebuild endpoint. |
| `server.mjs` | COOP/COEP static dev server (needed for SharedArrayBuffer / pthreads); serves the repo root, falls back to `editor/dist/` for `/`, and synthesizes the `/example_flowgraphs` listing. Recording discovery and objects always come directly from R2. |
| `test/` | `test_smoke.mjs` (runs example flowgraphs headlessly and asserts samples actually move) and `test_lazy_scenarios.mjs` (verifies on-demand category side modules are fetched and `dlopen`'d), plus the `fixtures/` `.grc` they load; CI gates the deploy on both. `editor/test/` and `runner/test/` hold their own suites — see "Run and test" |
| `scripts/` | `assemble-site.mjs` (assembles the static site CI deploys to Pages), `serve_site.mjs` (serves an assembled site the way Cloudflare Pages does), `run.mjs` (headless-Chromium test harness, waits on a page `#result`), `run_example.mjs` (opens an example in the real editor and presses Run), `r2-cors.json` (CORS policy for the recordings bucket) |
| `editor/recording/` | HTML shell for the built-in recording view, emitted at `/recording/` by the normal editor build |
| `editor/src/recording/` | Focused IQEngine-derived SigMF URL/blob reader, bounded range loader, FFT/spectrogram DSP, plots and recording-view UI. Its `features/ui/canvas-plot/` is repo-owned, not IQEngine's |

### Auto-arrange (Edit ▸ Auto-Arrange Blocks)

Rewrites every block coordinate so the flowgraph reads as a left-to-right
flowchart. The engine is [`editor/src/layout.ts`](editor/src/layout.ts), which
takes measured boxes and returns coordinates and touches neither the DOM nor the
editor's own types; `autoArrangeBlocks()` in `main.ts` does the measuring (box
size from `geom()`, port tab overhang from `portWidth()`, port offsets from
`portPos()`), applies the result, and records one history entry so the whole
arrangement undoes in a single Ctrl+Z. Nothing about it reaches the `.grc` beyond
the coordinates GRC already stores.

There is no automated test for it: whether an arrangement reads well is a
judgement for the eye, so check a change here by arranging a few of the busier
examples (`rds/rds_receiver.grc`, `ofdm/ofdm.grc`,
`gr-satellites/satellites_ax25_afsk.grc`) in the editor and looking at them.

## Toolchain and prerequisites

Supported baseline: Ubuntu 24.04. The repo can live anywhere — `deps/env.sh`, the
Qwt config, and the runner/qtgui `CMakeLists.txt` derive the repository root from
their own locations, while `$GR` selects the GNU Radio source submodule (CI sets
it explicitly). Only Qt is assumed to be under `~/Qt`; adjust the `QT_*`
variables if yours differs.

Userspace (no sudo) requirements:

- **emsdk 3.1.70** (matches Qt 6.9): `~/emsdk/emsdk install 3.1.70 && ~/emsdk/emsdk activate 3.1.70`.
- **Qt 6.9.1 for WebAssembly (multithread) + host tools**, via `aqtinstall`:
  `aqt install-qt linux desktop 6.9.1 linux_gcc_64` and
  `aqt install-qt all_os wasm 6.9.1 wasm_multithread` (into `~/Qt`).
- **Node ≥ 20** (for the editor build and the dev server; Ubuntu 24 ships 18).
- Dependency sources fetched under `deps/src/` (VOLK 3.1.2, Boost 1.83, spdlog
  1.12, GMP 6.3, FFTW 3.3.10, Qwt 6.2). `deps/env.sh` derives paths from the
  checkout root; its environment variables remain overridable.

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
# Optional override for the production recording bucket custom domain. Vite
# defaults to https://recordings.gnuradioworld.com; only this stable base is
# embedded, while discovery, metadata, and data are fetched live from R2.
export VITE_RECORDINGS_R2_BASE=https://recordings.gnuradioworld.com
```

## Build workflow

### 1. Fetch and cross-build the C++ dependencies → `sysroot/`

Two scripts; versions are pinned in `fetch-deps.sh` and nowhere else. Both are
idempotent, so re-running after a failure is cheap. `build-deps.sh` produces
everything the runner links that is not GNU Radio itself (spdlog, VOLK, Boost,
FFTW in both precisions, GMP, Qwt).

```bash
bash deps/fetch-deps.sh         # -> deps/src/   (skips what is present)
bash deps/build-deps.sh         # -> sysroot/    (needs QT_HOST + QT_WASM)
```

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
metadata (for a vendored out-of-tree module, its `runner/oot_cpp_templates/`
file rather than the submodule's own yaml), `runner/gen_registry.py`, or the
handwritten registry as appropriate, then regenerate.

### On-demand category modules

The runner is an Emscripten `MAIN_MODULE` that loads block categories on demand.
`gen_registry.py` splits the block factories into a core registrar
(blocks/analog/fft/filter, linked into the main module) and one self-registering
`generated_registry_<m>.cpp` per deferred category
(including but not limited to digital/dtv/network/pdu/vocoder). The runner CMake compiles each of those into a
`SIDE_MODULE` (`runner/build/<m>.wasm`); at run time `gr_run_json` inspects the
flowgraph, `emscripten_dlopen`s only the categories it uses. Constraints that make
this work (all handled by the build): everything is `-fPIC`; `MAIN_MODULE=2` +
`EXPORT_ALL` + whole-archived core + a generated `side_exports.rsp` export every
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
node test/test_lazy_scenarios.mjs
node test/test_smoke.mjs
node scripts/run.mjs /runner/build/runner.html RUNNER_PASS
```

- `test/test_lazy_scenarios.mjs` verifies deferred category modules are fetched
  and loaded.
- `test/test_smoke.mjs` verifies blocks actually move samples, not merely that
  the runner links or starts.
- `scripts/run.mjs` is the headless Chromium harness and waits for a page
  `#result`.

Both browser tests start their own COOP/COEP server on a private port, so they
need no `server.mjs` running; `scripts/run.mjs` does (port 8090 by default, hence
the server command above). `npm test` at the repository root runs the two of them.

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
- **Editor-side validation.** Connection type checks, required-parameter checks
  and expression resolution all happen in the editor. A flowgraph the runner
  would execute happily can still be refused before it ever gets there.

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

Two more suites exist and are *not* run by CI — run them by hand when you touch
the code they cover:

```bash
(cd editor && npm test)                       # 24 node tests: shortcuts, selection, grid,
                                              # canvas scroll, workspace/recording tabs,
                                              # validation, time sink, expr,
                                              # .grc round-trip, recordings, real-valued
                                              # recordings, polyphase channelizer,
                                              # contribute,
                                              # block categories, note block, example
                                              # filter/search.
                                              # No browser, no WASM build.
(cd runner/test && g++ -std=c++17 -I../src grc_test.cpp -o grc_test && ./grc_test)
```

`editor/test` covers editor logic (`expr.ts`, `grc.ts`, selection/grid geometry)
that the smoke test cannot reach, including byte-exact `.grc` formatting — run it
after any change under `editor/src`.

**Do not add a new `*.test.mjs` for every change.** A new suite is for a genuinely
new area of behavior — a new view, a new subsystem, a new file format concern.
Anything smaller belongs in the existing suite that already covers the code it
touches (a Save-path tweak goes in `example-link.test.mjs`, a schema tweak in
`grc.test.mjs`, and so on), and plenty of small changes need no new assertion at
all — running the existing suites is enough. Every new file also has to be added
to the `test` script in `editor/package.json` and to the list above, so a suite
per change turns into a long tail of near-empty files nobody reads. Same rule for
`test/` at the repository root and `runner/test/`.

`runner/test/grc_test.cpp` is a host-compiled
regression test for the runner's `.grc` parser and lowering (`grc_yaml.hpp`,
`grc_lower.hpp`); those headers are deliberately GNU-Radio-free so it builds with a
plain host compiler in a second, with no Emscripten involved. `runner/test/` also
holds a few hand-written `.grc` fixtures (analog/digital hierarchies, OFDM RX) for
loading in the runner by hand; nothing runs them automatically.

For a fast out-of-tree module compile loop:

```bash
cmake --build runner/build --target side_modules
```

Once it compiles, do the full runner relink, rebuild the editor, and run the
headless smoke test. A `RUNNER_PASS` proves module loading, block construction,
and graph startup, but does not by itself prove DSP correctness.

`runner/generated_blocks.json` is the authoritative runtime support manifest,
used to mark palette entries runnable or unavailable. The runner has a small
typed-object registry for constellation variables used by Constellation
Modulator. Other blocks whose constructors require a separately typed GRC
companion object (for example an OFDM equalizer, packet formatter, or message
queue) remain listed under `skipped`. It also holds a typed-object entry for
gr-fec's CC Decoder Definition (`variable_cc_decoder_def`), which
`fec_async_decoder` and `fec_extended_decoder` look up by name. Python-only
hierarchy definitions are supported when their chain has been explicitly rebuilt
as a C++ `hier_block2` in `registry.cpp`; the rest remain unavailable.

gr-satellites is the largest such rebuild. Its hierarchies, demodulators and
deframers are all Python with no C++ path upstream, so they live in
[`runner/src/satellites_wasm_hier.cpp`](runner/src/satellites_wasm_hier.cpp)
(`hier/` scramblers, `sync_to_pdu*`, `rms_agc`, `ccsds_viterbi`, and the AFSK /
FSK / BPSK demodulator components) and
[`runner/src/satellites_wasm_deframers.cpp`](runner/src/satellites_wasm_deframers.cpp)
(`hdlc_deframer` plus ~29 deframer components). Each class mirrors the block set
and connection order of the Python file named in its comment, so the two stay
diffable; syncwords and packet lengths are copied verbatim. The GRC `options`
parameter is an argparse command line for the `gr_satellites` tool — nothing in
the browser supplies one, so the rebuilds hard-code the defaults those parsers
declare (collected as named constants at the top of the hier file).

The deframers still missing are the ones whose Python defines extra
protocol-specific helper blocks inline (`diy1`, `hades`, `hsu_sat1`, `ideassat`,
`ax5043`, `mobitex`, `k2sat`, `openlst`, `sanosat`, `smogp_ra`, `spino`, `yusat`,
`eseo`, `snet`, `aausat4`, `usp`): a UART decoder, a packet cropper, a 4x4
interleaver and so on. Each needs its own C++ block before its deframer can be
assembled, which is why they are not simply compositions like the rest.

## Registry and module conventions

Direct C++ factories are generated from GRC `.block.yml` `cpp_templates`.
Factories needing browser widgets, live setters, or browser-specific composed
blocks live in [`runner/src/registry.cpp`](runner/src/registry.cpp).

- Add handwritten factory IDs to `CUSTOM_IDS` in `runner/gen_registry.py` to
  avoid duplicate generated factories.
- Put block metadata that cannot be rendered in `INVALID_CPP_TEMPLATES`, with a
  reason.
- Python-only `gr.hier_block2` definitions are unavailable unless explicitly
  rebuilt as C++ hierarchies in `runner/src/registry.cpp` (or, for gr-satellites,
  `satellites_wasm_hier.cpp` / `satellites_wasm_deframers.cpp`).
- Blocks absent from the WASM registry remain visible but disabled in the editor
  palette.
- Symbol exports for side modules are generated automatically by
  `gen_side_exports.py`; do not maintain a manual export list.

In handwritten `.grc` test fixtures:

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
  the runner a *resolved* .grc. `example_flowgraphs/rds_receiver.grc` relies on
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

## Adding a category (module) of blocks

A "category" here is one GNU Radio component library (`gr-<m>`) exposed as either
part of the always-loaded core or an on-demand side module. To add one (say
`gr-foo`):

1. **Build the GR library** with `-fPIC`. Add `-DENABLE_GR_FOO=ON` to the
   `gr/build-gr` configure line and rebuild, producing
   `gr/build-gr/gr-foo/lib/libgnuradio-foo.a`. Every object must be `-fPIC`
   (the shared flags already ensure this); a non-PIC object fails the dynamic
   link with `relocation R_WASM_MEMORY_ADDR_* … recompile with -fPIC`.

2. **Register its blocks** in [`runner/gen_registry.py`](runner/gen_registry.py):
   - add `"gr-foo"` to `MODULES` so its `.block.yml` files are parsed;
   - add its short name `"foo"` to **either** `CORE_MODULES` (always linked into
     the main module) **or** `DEFERRED_MODULES` (fetched on demand);
   - if a *deferred* module needs symbols from *another deferred* module, add the
     edge to `MODULE_DEPS` (e.g. `{"foo": ["bar"]}`) so the loader fetches them in
     order. Depending only on core modules needs no entry.

3. **Wire the build** in [`runner/CMakeLists.txt`](runner/CMakeLists.txt):
   - make sure `gr-foo/include` is in `GR_INCLUDE_DIRS` (add it if new);
   - **deferred:** add `foo` to the `DEFERRED_MODULES` list. That builds
     `foo.wasm` as a `SIDE_MODULE`, folds its imports into `side_exports.rsp`, and
     the editor/loader do the rest — nothing else to touch.
   - **core:** add `libgnuradio-foo.a` to the whole-archived block in
     `target_link_libraries` (the `$<LINK_LIBRARY:WHOLE_ARCHIVE,…>` list) so its
     full symbol set is present for `EXPORT_ALL`.

4. **Regenerate and rebuild:**
   ```bash
   python3 runner/gen_registry.py
   python3 editor/gen/gen_blocklib.py editor/public/blocks.json
   (cd runner && cmake --build build)   # builds side modules + main + patch
   (cd editor && npm run build)
   ```
   The editor palette picks up the new blocks automatically: `gen_blocklib.py`
   stamps each block with its `module`.

5. **Test lazy loading** with `node test/test_lazy_scenarios.mjs`.

## Adding an out-of-tree (OOT) module (step-by-step)

The recipe above assumes an in-tree `gr-<m>` built by `gr/build-gr`. A
third-party OOT module (already done for [`gr-rds/`](gr-rds), [`gr-foo/`](gr-foo),
[`gr-dvbs2/`](gr-dvbs2), [`gr-dvbs2rx/`](gr-dvbs2rx), [`gr-satellites/`](gr-satellites),
and [`gr-paint/`](gr-paint)) is **not** part of that
umbrella build, so there is no `libgnuradio-<m>.a`; instead its own `lib/*.cc` are
compiled straight into an on-demand `<m>.wasm` side module. This is a
**self-contained checklist** — following it needs no investigation beyond the
module itself. Copy an existing OOT module (gr-foo is the simplest, gr-dvbs2 the
most complex) as a working reference for every step.

**1. Add it as a submodule** at the world-repo top level, beside the `gnuradio/`
submodule. Pin **upstream's own** GNU Radio-compatible default or maintenance
branch, not a fork:
```bash
git submodule add -b <branch> https://github.com/<upstream>/gr-<m>.git gr-<m>
```
Steps 3 and 5 exist so this stays possible: block metadata and generated headers
both live in this repository, so a normal OOT module needs no branch of its own
and bumping it is a plain `fetch` + `checkout` with nothing to rebase. Of all the
vendored modules only gr-dvbs2 is a fork, and it is upstream plus exactly one
commit: a WASM buffer-wrap fix that had to go in its `lib/`. Do not create a fork
to hold yaml or a generated header.

**2. Triage the blocks** — which have a C++ path, and what they depend on:
```bash
ls gr-<m>/lib/*.cc                                   # C++ blocks have an impl here
ls gr-<m>/python/*.py                                # gr.hier_block2 / GUI = Python-only
grep -rHn 'static sptr make' gr-<m>/include/*/*.h    # constructor signatures
grep -rho '#include *<[a-z].*>' gr-<m>/lib/*.cc | sort -u   # spot host-only deps
```
A block is directly generator-buildable only if it has a C++ impl. **Python-only
blocks** — a `gr.hier_block2` (e.g. gr-foo's `selector`/`valve`) or a GUI QWidget
(e.g. `rds_panel` = `rds.rdsPanel`) — have no automatic C++ path. Give them no
step 3 entry unless the block is rebuilt by hand (a C++ `hier_block2` for a
hierarchy, a `QWidget` message sink for a GUI panel — `rds_panel` in
`registry.cpp` is the worked example, with its id added to `CUSTOM_IDS`; the ~60
gr-satellites rebuilds instead keep a step 3 entry whose `make` calls into
`satellites_wasm_*.cpp`). Without one they show greyed-out in the palette. **Host-only deps** not in
the WASM sysroot (UHD, Boost.Asio networking, Boost.Locale, libsndfile, …) must be
dealt with in step 4.

**3. Add `cpp_templates` for each C++ block** in a new
`runner/oot_cpp_templates/gr-<m>.yml`. This is what the generator turns into a
factory. **Never edit the submodule's own `.block.yml`** — every browser-only
addition goes in this one file, which is what lets the submodule stay pinned to a
pristine upstream commit instead of a fork you have to rebase and push:
```yaml
<m>_<block>:
    flags: [python, cpp]
    cpp_templates:
        includes: ['#include <<m>/<block>.h>']
        declarations: '<m>::<block>::sptr ${id};'
        make: 'this->${id} = <m>::<block>::make(${arg1}, ${arg2});'
        link: ['gnuradio-<m>']
```
The file is picked up by its name alone — no loader, generator, or build change.
[`tools/block_overrides.py`](tools/block_overrides.py) documents every supported
key and is imported by *both* `runner/gen_registry.py` and
`editor/gen/gen_blocklib.py`, so the runtime factory and the palette entry
describing it always come from the same merge. Its in-tree counterpart is
[`runner/block_overrides.yml`](runner/block_overrides.yml), for overlays on blocks
in the `gnuradio/` submodule itself.

Mirror the arg order of the existing Python `templates: make:`, resolved against
the C++ `make()` signature from step 2 — the two are no longer adjacent in one
file, so read the block's yaml alongside what you write. If the module has an
in-tree analogue, copy that block's `cpp_templates` verbatim (gr-dvbs2's blocks ≈
gr-dtv's `dtv_dvb*`). Three generator constraints, each with a standard fix:
  - **Foreign-namespace enum values.** When `${param.val}` expands to
    `<m>.SOMETHING`, add `translations: {<m>\.: '<m>::'}` under `cpp_templates`
    (the generated file has `using namespace gr;`, so `<m>::SOMETHING` resolves).
    This mirrors gr-dtv's `dtv\.: 'dtv::'`.
  - **`raw` params the generator can't type** make the whole block *skip* (watch
    for it in the `gen_registry.py` "skipped" output). Retype with
    `parameter_dtypes` / `parameter_defaults`: a PMT (`pmt.intern("x")`) →
    `dtype: string` default `x`, with the `make` wrapping it in `pmt::intern(...)`
    itself (gr-foo's `burst_tagger`); a bare numeric expression → `int`/`real`.
  - **Stale enum options (yaml vs. header drift).** If the generated code names an
    enumerator the vendored C++ enum lacks (`no member named '<m>::FOO'`), list
    that option under `prune_options: {<param id>: [FOO, ...]}`. It drops the
    matching entry from `options`, `option_labels` and every `option_attributes`
    list at once, so the three stay index-aligned (they pair positionally) without
    you editing them by hand. gr-dvbs2's `bbheader_bb` is the worked example.

A typo'd or misfiled block id is rejected rather than silently ignored:
`gen_registry.py` fails if an overlay matches no known block, names a block from a
different module, uses an unknown key, or duplicates an id in another file.

**4. Handle host-only deps** so the desktop build stays intact. Unlike step 3,
these can need a real source change, which is the only reason left to fork a
submodule at all (gr-dvbs2 is forked solely for a WASM buffer-wrap fix):
  - Prefer a runner-owned shim include directory over touching the source, which
    keeps the submodule pristine: gr-rds
    calls `boost::locale::conv::to_utf` once, to convert RadioText from
    ISO-8859-2, and Boost.Locale is not in the WASM sysroot, so
    [`runner/src/rds_wasm_shims/boost/locale.hpp`](runner/src/rds_wasm_shims/boost/locale.hpp)
    implements exactly that one call inline and the rds side-module rule
    prepends `-I${RDS_WASM_SHIMS}` ahead of the normal include flags, **or**
  - if it's already behind a feature macro, just leave that undefined (gr-foo's
    UHD `tx_time` tagging under `#ifdef FOO_UHD`), **or**
  - if a whole block is unusable in the browser (host networking, etc.), drop its
    source from step 6 and simply give it no entry in step 3's file, which leaves
    it Python-only and greyed out (gr-dvbs2's `bbheader_source` = a Boost.Asio UDP
    source), **or**
  - only if none of those work, fork the submodule and guard the offending code
    with `#ifdef __EMSCRIPTEN__`.
  - **Header-only SIMD libraries** that dispatch on `__AVX2__` / `__SSE4_1__` /
    `__ARM_NEON__` (gr-dvbs2rx's LDPC/BCH decoder) need nothing: Emscripten defines
    none of those, so they fall back to their generic scalar path and compile as-is
    (slower, still correct). Don't add `-msimd128`/`-msse4.1`.

**5. Supply an empty `config.h`** if the impls include the file generated by the
module's own CMake. Put it in a runner-owned `runner/src/<m>_wasm_shims/`, the
same place as step 4, and add `-I${<M>_WASM_SHIMS}` to the module's side-module
rule *ahead of* `${SIDE_INCLUDE_FLAGS}`. The impls include it as `"config.h"`, so
with no copy beside the sources it resolves from there; nothing else on the
include path defines one. All but one vendored modules do this — no submodule
holds a `config.h` of its own; gr-paint is the exception, guarding its include
behind `#ifdef HAVE_CONFIG_H`, which nothing defines, so it needs no shim — and [`runner/src/rds_wasm_shims/`](runner/src/rds_wasm_shims/)
additionally holds gr-rds's `boost/locale.hpp` replacement. Together with step 3
this is what lets the submodules stay pinned to pristine upstream. (Any real
per-module constants header that ships in the repo, e.g. `dvbs2_config.h`, is used
as-is.)

**6. Register and wire the build:**
  - [`runner/gen_registry.py`](runner/gen_registry.py): add `"gr-<m>"` to
    `MODULES` and the short name `"<m>"` to `DEFERRED_MODULES`.
  - [`runner/CMakeLists.txt`](runner/CMakeLists.txt): add `${WORLD}/gr-<m>/include`
    to `GR_INCLUDE_DIRS`, then copy an existing OOT `add_custom_command` (the
    `rds` / `foo` / `dvbs2` block) — list `generated_registry_<m>.cpp` plus the
    module's `lib/*.cc` (minus any source excluded in step 4) and append
    `<m>_out` to `SIDE_MODULE_OUTPUTS`. **Do not** add `<m>` to the CMake
    `DEFERRED_MODULES` list — that loop links a `build-gr` `.a` the OOT module
    doesn't have. `side_exports`/palette/on-demand fetch then work unchanged.

**7. Generate, compile-check, build, verify:**
```bash
python3 runner/gen_registry.py                      # expect "<m>=N" in the deferred list, and no new skips
source ~/emsdk/emsdk_env.sh                          # emsdk 3.1.70 on PATH
cmake --build runner/build --target side_modules    # FAST: builds <m>.wasm only, no main relink
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
(cd runner && cmake --build build)                  # side modules + main relink (~2 min: wasm-opt)
(cd editor && npm run build)
```
The `side_modules` target is the fast inner loop for iterating on `cpp_templates`
/ source fixes; only do the full `cmake --build build` (which relinks the ~18 MB
main module) once the side module compiles clean.

`gen_registry.py` ends with one summary line — `generated core=N (+M custom);
deferred: digital=38, dtv=52, …; skipped K`. `skipped` is a *count*, not a list,
and it is never zero: the in-tree blocks needing a typed GRC companion object are
permanently skipped (see `generated_blocks.json`'s `skipped` map for the names and
reasons). What matters is that your module appears in the deferred list with the
block count you expect and that `K` does not grow.

**8. Smoke-test headless** — build a tiny `.grc` that forces the module to load
and construct a block, then expect `RESULT: RUNNER_PASS`:
```bash
node server.mjs 8090 "$PWD" &                        # COOP/COEP dev server
URL="/runner/build/runner.html#$(node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(process.argv[1],"utf8")))' my.grc)"
node scripts/run.mjs "$URL" RUNNER_PASS 8090 45000   # headless chrome; prints the RESULT line
```
`RUNNER_PASS` confirms the side module fetched + `dlopen`'d and every block
constructed and the graph started — it does **not** verify DSP correctness of the
chain.

## Runtime gotchas (in-tree and OOT alike)

- **Hand-written factories** (blocks needing a `QWidget`, live setters, or a
  browser-safe reimplementation) live in
  [`runner/src/registry.cpp`](runner/src/registry.cpp); list their ids in
  `CUSTOM_IDS` in `gen_registry.py` so no duplicate generated factory is emitted.
  A block whose `cpp_templates` can't be rendered goes in `INVALID_CPP_TEMPLATES`
  with a reason.
- **Python hier blocks** (`gr.hier_block2` compositions such as PSK Mod or the
  OFDM Transmitter) have no C++ path at all, so the browser gets the same block
  id backed by the same chain rebuilt as a C++ `hier_block2` in `registry.cpp`
  (`digital_psk_mod`, `digital_ofdm_tx`). Where the Python block computes defaults
  with numpy (the OFDM sync words), reproduce them exactly: numpy's legacy
  `RandomState(seed)` is MT19937 seeded identically to `std::mt19937(seed)`, and
  `randint(2)` is one 32-bit draw's low bit.
- **Python GUI blocks** are the same story with a `QWidget` instead of a chain:
  gr-rds's `rds_panel` is a Python QWidget, and it is the only place an RDS
  receiver ever shows its decoded ASCII, so `registry.cpp` rebuilds it as a
  message-sink block whose handler records the parser's `(type, text)` tuples and
  whose QTimer paints them (message handlers run on GR threads; widgets are
  main-thread only). See `example_flowgraphs/rds_receiver.grc`.
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
  `MODULE_DEPS` instead. gr-satellites' rebuilt hierarchies wrap their message
  ports with `gr::pdu::{pdu_to_tagged_stream,tagged_stream_to_pdu}`, hence
  `MODULE_DEPS = {"satellites": ["pdu"]}`.
- **gr-satellites is the only module with `grc/` subdirectories**
  (`components/deframers`, `components/demodulators`, `hier`, `ccsds`, `usp`,
  `core`, ...), which is why `gen_registry.py` and `gen_blocklib.py` both walk
  `grc/` recursively. It ships no `.tree.yml`; every block carries an explicit
  `category: '[Satellites]/...'`, so the palette categories come for free.
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
  message, which `main.ts` appends to `#log` under the canvas. Batched (~10
  posts/second, 200 lines each) and capped at both ends because a Message Debug
  on a fast frame source emits well over a thousand lines a second; the editor
  reports what it shed. Note this is *stdout*, which is separate from the GR
  logger below.
- **The editor drops parameters its schema does not declare, silently.** A
  hand-written `RUNNABLE` entry supersedes the generated one, and its parameter
  ids win: `analog_sig_source_x` declares `frequency`/`amplitude`, so a .grc
  written with GRC's own `freq`/`amp` loads with those values replaced by the
  schema defaults. The runner accepts both spellings, so such a flowgraph runs
  correctly when handed straight to `runner.html` and silently wrong through the
  editor. When authoring a .grc by hand, take parameter ids from the hand-written
  schema in `main.ts` for any block that has one.
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
- **No true double-mapped memory.** Emscripten cannot create VM aliases; the
  emulated buffer uses twice the physical memory and copies produced bytes into
  its mirror. See [docs/double-mapped-buffer.md](docs/double-mapped-buffer.md).
- **FFTW** uses `FFTW_ESTIMATE` under WASM because `FFTW_MEASURE` benchmarking
  hangs there.
- **Host-only dependencies** such as UHD, Boost.Asio networking, Boost.Locale, and
  libsndfile need an Emscripten guard, a browser-safe replacement, or exclusion of
  the affected block.

## GNU Radio source changes (all guarded, desktop build unaffected)

- `gnuradio-runtime/lib/thread/thread.cc` — `__EMSCRIPTEN__` branch (no
  prctl/affinity); `set_thread_name()` is a silent no-op there rather than an
  error log, which would otherwise fire once per block thread and show up in the
  runner's error banner.
- `gnuradio-runtime/lib/constants.cc.in` — fixed prefix under WASM (no
  `boost::dll`).
- `gnuradio-runtime/lib/CMakeLists.txt` — libunwind made optional.
- `gnuradio-runtime/lib/pmt/CMakeLists.txt`, `gr-fft`, `gr-blocks`, `gr-analog`
  `lib/CMakeLists.txt` — register libs for install/export in static builds too.
- `gnuradio-runtime/lib/vmcircbuf.cc` — `__EMSCRIPTEN__` branch that returns the
  `vmcircbuf_emulated` factory directly instead of probing the mmap /
  shared-memory / temp-file backends, none of which can work in one flat linear
  memory (`all_factories()` is narrowed the same way).
- `gr-fft/lib/fft.cc` — use `FFTW_ESTIMATE` under WASM (`FFTW_MEASURE`
  benchmarking hangs there).

gr-qtgui is not built by `gr/build-gr` (`ENABLE_GR_QTGUI=OFF`) — `qtgui/`
compiles its sources against Qt 6 instead — but they carry WASM guards too, all
`#ifdef __EMSCRIPTEN__`:

- `gr-qtgui/lib/displayform.cc`, `include/gnuradio/qtgui/form_menus.h` — the
  context menu and its dialogs use `popup()`/`open()` rather than `exec()`.
  `exec()` runs a nested event loop, which cannot block the browser main thread in
  a non-Asyncify build. The screenshot dialog keeps the captured pixmap alive and
  saves it from the dialog's accepted signal instead of after `exec()` returns.
- `gr-qtgui/lib/time_sink_c_impl.cc`, `time_sink_f_impl.cc` — drop an already
  queued update event before posting a new one, so a display that paints slower
  than the flowgraph produces shows the newest frame instead of accumulating
  latency.
- `gr-qtgui/lib/TimeDomainDisplayPlot.cc`, its header — `QwtPlotCanvas::ImmediatePaint`
  plus antialiasing off and `FilterPointsAggressive` on the curves; Qwt's backing
  pixmap and Qt's antialiased polyline rasterizer are both disproportionately
  expensive on the browser canvas.

Build with `-DCMAKE_DISABLE_FIND_PACKAGE_libunwind=ON`. The WASM runtime selects
`vmcircbuf_emulated`: a contiguous 2N-byte software mirror that preserves the
native double-mapped scheduler and pointer behavior, then synchronizes completed
writes before publishing them to readers. It uses twice the physical buffer
memory and one mirror copy per produced byte because WebAssembly cannot create
true VM aliases. See [docs/double-mapped-buffer.md](docs/double-mapped-buffer.md).

### Browser-backed File Source

The WASM registry replaces GNU Radio's POSIX-backed `blocks_file_source` with
`runner/src/browser_file_source.cpp`. A File Source can be bound either to a
local `File` selected with the editor's Properties → Browse control or to a
recording URL from R2. The binding is session-only: `.grc` files
keep the human-readable filename or `/recordings/...` path and never serialize a
browser file handle.

Each running source owns a `browser_file_reader.js` worker. It reads local files
with bounded `File.slice()` calls and remote recordings with required HTTP Range
requests, then feeds a fixed 16 MiB ring in shared WASM memory. Individual reads
are capped at 2 MiB, so source memory is independent of recording size. Servers
must return `206` with a matching `Content-Range`; a `200` response is rejected
before its body is consumed. Keep R2's CORS policy in `scripts/r2-cors.json`
configured to allow the `Range` request header and expose `Content-Range`.

`test/test_smoke.mjs` covers both backends. Its local-file case selects a sparse
file larger than 4 GiB through the actual editor and reads beyond the 32-bit
boundary; its HTTP endpoint refuses non-Range requests and verifies the exact
range consumed.

### R2 recording source of truth

Production recordings live only in the Cloudflare R2 bucket
`gnuradio-wasm-recordings`, whose public custom domain is
`https://recordings.gnuradioworld.com`. The browser cannot address an R2 bucket
by its bucket name; it uses that HTTPS domain. The editor defaults to this base,
with `VITE_RECORDINGS_R2_BASE` available as a build-time override.

[`workers/sigmf-indexer/`](workers/sigmf-indexer/) is bound to the bucket as
`RECORDINGS`. At 09:00 UTC daily (4:00 AM fixed EST) it lists every object,
pairs keys with the same base and `.sigmf-data`/`.sigmf-meta` suffixes, reads
the SigMF metadata, derives byte and sample counts, and replaces the bucket's
`index.json`. Its authenticated `POST /rebuild` endpoint performs the same job
on demand. The editor fetches that live index with `cache: no-store`, then
constructs both object URLs from each base key. `server.mjs`,
`scripts/assemble-site.mjs`, and Cloudflare Pages never build or serve a
recording manifest and never inspect `example_recordings/`.

To publish a recording, upload both matching objects directly to R2 using the
dashboard, the S3-compatible API, rclone, or another R2 client, then wait for
the daily run or invoke the manual rebuild. Collection prefixes are part of the
base key: `estevez/ao73.sigmf-data` pairs with
`estevez/ao73.sigmf-meta`. No checkout, commit, editor rebuild, or Pages deploy
is part of this workflow.

Keep [`scripts/r2-cors.json`](scripts/r2-cors.json) applied to the bucket. It
allows the production origins and `http://localhost:8090`, permits GET/HEAD and
Range requests, and exposes `Content-Length`/`Content-Range`. Local testing must
use `http://localhost:8090/`, matching that exact allowed origin.

### Recording tabs

Every File Source with something to show gets its own workspace tab holding the
built-in recording view for it — added when a recording is clicked in the
palette, when an example that references one is opened, or when a file is picked
with Properties → Browse. Each tab is an `<iframe>` on the focused viewer emitted
by the editor build at `/recording/`, driven through its base64url URL route
(`recordingViewUrl()` in `editor/src/main.ts` builds it). The rules that keep it
working:

- **The tab set is derived state.** `syncRecordingTabs()` rebuilds it from
  `insts` at the end of every `render()`, so no mutation path has to remember to
  update it, and nothing about a tab reaches the `.grc`. It must stay synchronous
  and network-free: a remote tab's label comes from the `/recordings/...` path,
  not from the R2 recording index.
- **The iframe is created on first activation, never at sync time.** That defers
  both the viewer bundle (later tabs hit the HTTP cache) and the recording's
  samples. Once created it is kept, so revisiting a tab refetches nothing.
- **Inactive recording panes hide with `visibility:hidden`, not the `hidden`
  attribute.** `display:none` collapses an iframe to zero size, and the viewer sizes
  its spectrogram off the window it is in; it would come back sized for nothing.
  Panels are also never re-inserted into the DOM when tabs reorder — moving an
  iframe reloads the document inside it — so only the buttons are reordered.
- **A local file has no SigMF metadata**, so `synthesizedSigmfMeta()` writes a
  minimal one from the File Source: datatype from its `type` param (a `short`
  or `byte` source whose only sink is an interleaved-to-complex converter is
  `ci16_le`/`ci8`, the chain the recordings tab builds), sample rate from the
  flowgraph's `samp_rate` when it is numeric, and the sample count from the
  file size. Both it and the file itself are handed over as `blob:` URLs, which
  Chrome answers with `206`/`Content-Range` exactly like an HTTP recording, so a
  multi-gigabyte local file is still read in bounded pieces. The pane labels the
  metadata as inferred.
- **Real-valued recordings** (SigMF's `r*` datatypes — an `rf32_le` File Source
  of type `float`, an `ri16_le` one of type `short`, and so on) are supported by
  widening each sample to the interleaved I/Q the rest of the viewer works on,
  with Q = 0, in `convertToFloat32()`. That is deliberately the *only* place the
  difference lives: the FFT of a signal with no imaginary part is
  Hermitian-symmetric, so the spectrogram and frequency plot show the negative
  half mirroring the positive one — which is exactly what a real recording should
  look like — with no changes to either. `dataTypeToBytesPerIQSample()` is the
  other half: a real sample is one component, not two, so `ri16_le` is 2 bytes
  where `ci16_le` is 4, and every byte offset, sample count and range read
  follows from it. The Time plot drops its Q trace and labels the remaining one
  "Real", and the IQ plot says why every point is on the I axis — unless the
  frequency shift is on, which mixes a real signal down to a genuinely complex
  one and makes both meaningful again. `editor/test/real-recordings.test.mjs`
  pins the datatype table, the widening, and the mirrored spectrum.
- The viewer is deliberately a narrow slice: URL/blob SigMF sources,
  spectrogram plus Time/Frequency/IQ plots, recording settings, annotations and
  the metadata summary bar under the plot. IQEngine's plugins, Cyclostationary
  view, backends/authentication and Pyodide path are not included, and neither
  are its Global Properties and Raw Metadata editors — nothing here writes a
  `.sigmf-meta` back. The settings pane is a plain always-open panel, not a
  `<details>`; Annotations is the only collapsible section left.
- **The viewer has exactly one text size**: the editor's own chrome font,
  system-ui at 13px. The rules are the un-layered block at the top of
  [`editor/src/recording/features/ui/styles/tailwind_index.css`](editor/src/recording/features/ui/styles/tailwind_index.css)
  — un-layered because daisyUI hard-codes a font-size on `.input`, `.label-text`,
  `.btn`, `.tab`, `.menu` and `.table` from the components layer, which any
  `@layer base` rule loses to. Size is set on `body` in px and never on `:root`,
  so tailwind's rem-based spacing and widths (the sidebar's `w-64`, and the px
  offsets in `recording-view.tsx` hand-tuned against it) stay put. Text drawn on
  a canvas inherits none of that, so the konva labels (rulers, selectors,
  annotations) and `CanvasPlot`'s axes read `APP_FONT_FAMILY`/`APP_FONT_SIZE`
  from [`editor/src/recording/utils/constants.ts`](editor/src/recording/utils/constants.ts)
  instead. Prefer those over a new `text-*` utility.
- **The viewer's colors are the editor's, not IQEngine's.** The daisyUI theme in
  [`editor/tailwind.config.cjs`](editor/tailwind.config.cjs) maps every token onto
  a color taken from `editor/index.html` (`base-100` = the `#20232f` panel fill,
  `base-200` the recessed strip, `base-300` the divider, `neutral`/`secondary` the
  slate button and its border, `primary` the `#3fae63` green, `accent` the
  `#58a6ff` blue), plus an `extend.colors` set — `field`, `line`, `raised`,
  `selected`, `muted` — for the chrome colors daisyUI has no token for. Style with
  those tokens rather than a literal hex, and if the editor's chrome changes,
  change them here too. Two places CSS cannot reach need the values spelled out:
  `CanvasPlot`'s theme constants and colorway, and the konva chrome (rulers, the
  minimap scrollbar) which reads `APP_TEXT_COLOR`/`APP_TICK_COLOR`/
  `APP_WELL_COLOR`/`APP_MARK_COLOR` from `utils/constants.ts`. Konva overlays
  drawn *on the spectrogram* — annotation boxes, the freq/time cursors — keep
  their high-contrast white/red/blue instead, because they sit over an arbitrary
  colormap.
- **The Time/Frequency/IQ tabs draw on a plain 2D canvas, not plotly.** Upstream
  uses `react-plotly.js`, which is ~4.7 MB — several times the rest of the viewer
  — for one trace type, and its size is why upstream loads those three tabs
  lazily. [`editor/src/recording/features/ui/canvas-plot/CanvasPlot.tsx`](editor/src/recording/features/ui/canvas-plot/CanvasPlot.tsx)
  replaces it: same theme, ticks, hover readout, mode bar, legend and range
  slider, plus pan/wheel-zoom/double-click-autoscale and plotly's `uirevision`
  rule (new data re-autoranges only while the reader has not zoomed). Dense
  traces use min/max decimation, one vertical segment per pixel column, which is
  what keeps the Time tab's ~650k points per trace at a few ms a frame. It is
  repo-owned code, so it is the one file under `src/recording/` that has no
  upstream counterpart to diff against.

`editor/test/recording-tabs.test.mjs` pins all of the above. It does not run a
browser, so a change here also wants the manual pass in "Run and test".

## Continuous integration

`.github/workflows/deploy-wasm.yml` builds the whole stack from source and
deploys to Cloudflare Pages on every merge to `main`. Nothing is prebuilt, so the
deployed artifacts can never disagree with the source tree. Two caches keep that
affordable:

- **`sysroot`** — Boost/FFTW/GMP/Qwt/VOLK/spdlog, cached as an *output* keyed on
  `deps/env.sh` + `fetch-deps.sh` + `build-deps.sh` and the emsdk/Qt versions.
  Rebuilt only when one of those changes (~25 min), a hit otherwise.
- **`ccache`** — GNU Radio, qtgui and the runner are recompiled every run, with
  ccache absorbing the cost. Caching `gr/build-gr` instead does *not* work:
  `actions/checkout` stamps every source file with a fresh mtime, so a restored
  ninja build dir rebuilds all ~520 objects anyway. ccache keys on preprocessed
  content, so a one-file GR change recompiles one file.

Before deploying, CI runs `test/test_smoke.mjs` and `test/test_lazy_scenarios.mjs`
in headless Chromium. This is a gate, not a formality: a cleanly linked runner can
still be dead on arrival (an unpatched VOLK once made `volk_malloc()` return NULL,
so every flowgraph threw `std::bad_alloc` while CI stayed green). The smoke test
requires every block in the runner's diagnostics snapshot to have moved items, so
a graph that starts but stalls fails too. Changes should leave both tests
passing; a successful link alone is not adequate validation.

`assemble-site.mjs` then version-locks the runner: `runner.js`, `runner.wasm` and
the category side modules are one indivisible build (emcc bakes that link's
`EM_ASM` string addresses into `runner.js`'s `ASM_CONSTS` table), but none of the
names carry a version. A browser that reuses a cached `runner.js` from the
previous deploy while fetching this deploy's `runner.wasm` dies in `main()` with
`ASM_CONSTS[code] is not a function` — the 1.2 MB script is small enough to come
back from the in-memory cache, the 19.5 MB wasm is not. So the assembler hashes
the runner build and stamps `?v=<hash>` onto the `<script>` srcs in `runner.html`,
whose `locateFile` hook passes the same stamp to `runner.wasm` and every
`dlopen`'d side module. `runner.html` itself is always fetched fresh (the editor
appends a unique `recordingToken`), so it is the carrier. Served unstamped — dev
server, smoke tests — the hook is inert.

Because those URLs now change with their content, `_headers` gives them
`Cache-Control: public, max-age=86400`, replacing the `max-age=0,
must-revalidate` Pages defaults. That is worth doing: the runner iframe reloads on
every Run, and revalidating costs 9 conditional requests per repeat visit (the
pthread workers re-request `runner.js` too) where a warm cache costs zero. It is a
day rather than `immutable` because `_headers` matches paths, not query strings,
so the rules also cover the *unstamped* URLs that `/runner/build/runner.html`
requests when opened directly instead of through the editor — freezing those for a
year would let that one hand-debugging path pin a stale `runner.js` across deploys
and recreate the crash the stamp prevents.

Other triggers: `workflow_dispatch` builds without deploying unless you tick
`deploy`, and `rebuild_sysroot` forces the cold path (~1 h) to test the dep
scripts end to end. A weekly `schedule` run exists purely to keep the caches
alive — GitHub evicts anything unused for 7 days, and it never deploys.

This replaced a prebuilt `sysroot` + GR libs + qtgui tarball attached to a
`deps-vX` GitHub release. That artifact had to be repacked by hand after any GNU
Radio C++ change; when someone forgot, CI silently linked stale libraries and the
deployed site behaved differently from every developer's machine.
