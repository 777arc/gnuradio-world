# AGENTS.md

Guide for AI agents working in this repository: architecture, where everything
lives, and the shortest path to a built, tested change. Everything
developer-facing lives here or in `docs/` — `README.md` is a short user-facing
pitch that points back to this file, and `CLAUDE.md` is a symlink to it.

This file is the map. Per-task detail lives in `docs/`; read the relevant one *in
full* before starting that kind of work:

| doc | read it when |
|-----|--------------|
| [docs/building.md](docs/building.md) | setting a machine up, changing the build, the deps, the GNU Radio configure line, the side-module split, or Help ▸ Software Versions |
| [docs/blocks.md](docs/blocks.md) | implementing or rebuilding a block — the registry line, hand-written factories, Python hier/GUI rebuilds, QT GUI controls |
| [docs/flowgraph-files.md](docs/flowgraph-files.md) | writing or editing a `.grc` by hand — anything in `example_flowgraphs/` or `test/fixtures/`, parameter dtypes, expressions, PMTs |
| [docs/adding-modules.md](docs/adding-modules.md) | adding a GNU Radio component library or vendoring an out-of-tree module — a self-contained checklist for both, plus the gr-satellites rebuilds |
| [docs/recording-viewer.md](docs/recording-viewer.md) | touching the four source blocks that read a file (File Source, SigMF Source, GR World Recording, Public HTTP Recording), the one that writes one (SigMF Sink), the R2 recording bucket and its CORS policy, recording tabs, or the SigMF viewer under `editor/src/recording/` |
| [docs/rtlsdr.md](docs/rtlsdr.md) | touching RTL-SDR Source — the WebUSB reader worker, the RTL2832U/tuner drivers, the device-permission flow, or anything that has to reach USB hardware from a tab |
| [docs/plutosdr.md](docs/plutosdr.md) | touching PlutoSDR Source or Sink — stock-firmware USB IIOD, WebUSB transport, IIO discovery, 1R1T/2R2T, device permission, or Pluto hardware testing |
| [docs/audio.md](docs/audio.md) | touching Audio Sink or Audio Source — the Web Audio worklet, the sound-card ring, microphone permission, or the browser's autoplay policy |
| [docs/hackrf.md](docs/hackrf.md) | touching HackRF Source or Sink — the stock vendor-control protocol, signed 8-bit IQ streaming, half-duplex ownership, TX safety, or HackRF hardware testing |
| [docs/editor-ui.md](docs/editor-ui.md) | working on block IDs, auto-arrange, the narrow-screen/touch layout, or the embedded layout another site frames (`?embed=1`) |
| [docs/gui-layout.md](docs/gui-layout.md) | touching where QT GUI widgets go in the runner window — the GUI Layout block, `editor/src/gui-layout*.ts`, `runner/src/gui_layout.hpp`, or Arrange mode |
| [docs/ci.md](docs/ci.md) | changing a workflow, the deploy, PR preview deployments, or the PR security gate (`security-analysis.yml`, `scripts/pr-security-scan.mjs`) |
| [docs/gnuradio-patches.md](docs/gnuradio-patches.md) | changing anything inside the `gnuradio/` submodule or `qtgui/` |
| [docs/double-mapped-buffer.md](docs/double-mapped-buffer.md) | working on the emulated vmcircbuf |
| [docs/diagnostics.md](docs/diagnostics.md) | working on the runner's `__grstats` snapshot, the debug panel, or the Benchmark Tool |
| [docs/embedded-python.md](docs/embedded-python.md) | touching the Embedded Python Block — Pyodide, the Python shim under `runner/src/pyodide/`, `blocks/src/python_block.hpp`, `editor/src/epy.ts`, or the Code field's CodeMirror in `editor/src/code-editor.ts` |
| [docs/js-blocks.md](docs/js-blocks.md) | touching the JavaScript Block — `runner/src/js_runtime.js`, `blocks/src/js_block.hpp`, `editor/src/js-block.ts`, `editor/src/code-modal.ts`, or anything under `blocks/js/` |
| [docs/ai-copilot.md](docs/ai-copilot.md) | touching Flowgraph Copilot — the two-upstream shared-key proxy in `workers/ai-proxy/`, any of the four providers, structured graph tools, the agent loop, visible-run diagnostics, consent/key storage, or hardware authorization rows |

## Project overview

A GNU Radio Companion-style **flowgraph editor** and a **flowgraph runtime** that
run entirely in a browser tab — no Python, no server round-trips. The GNU Radio
DSP C++ stack (gnuradio-runtime, gr-blocks, gr-fft, gr-filter, gr-analog,
gr-digital, gr-fec, gr-dtv, gr-network, gr-pdu, gr-vocoder, gr-channels) and
the gr-qtgui sinks are cross-compiled to WebAssembly with Emscripten and
threaded Qt 6 for WebAssembly.

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
- `blocks/js/`: blocks whose `work()` is **JavaScript**, running on the block's own
  GNU Radio scheduler thread against GNU Radio's own buffers — no worker, no copy,
  no runtime to fetch. The same mechanism backs the inline JS Block a user writes
  in the editor. See [docs/js-blocks.md](docs/js-blocks.md).
- Vendored out-of-tree GNU Radio modules (e.g. gr-rds) compiled as on-demand WASM
  side modules.
- `deps/`: dependency fetch/build scripts, and any patches needed. Built
  dependencies are installed into the generated, git-ignored `sysroot/`.
- `editor/recording/` + `editor/src/recording/`: a focused recording viewer
  adapted from IQEngine, giving every block that reads a recording — and every
  recording opened on its own — a tab showing the signal in a spectrogram-based
  interface. Part of the editor's own Vite build.

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
  tab* per recording-reading block and per recording opened on its own. The
  recording viewer is part of this same Vite build, with the console remaining
  visible below any tab.
- **Runner** (`runner/`): a generic C++/WASM "player" — parses the flowgraph
  `.grc`, builds blocks via a `block-id → factory` registry, runs the GNU Radio
  thread-per-block scheduler, and renders gr-qtgui sinks to a canvas. Direct C++
  factories are generated from GRC's `cpp_templates`; handwritten factories in
  `src/registry.cpp` add browser widgets, live setters, and a few composed
  blocks. The generated and custom registries currently expose hundreds of blocks
  from gr-blocks, gr-analog, gr-fft, gr-filter, gr-digital, gr-dtv, gr-network,
  gr-pdu, gr-vocoder, gr-channels and gr-qtgui, plus the vendored out-of-tree modules
  (including but not limited to gr-rds, gr-foo, gr-dvbs2, gr-dvbs2rx,
  gr-satellites, gr-paint, gr-fosphor, gr-droneid, gr-ham, gr-ieee802-11). Stream
  and message-port connections are both serialized by the editor. QT GUI Range
  controls can be referenced by ID from numeric block parameters and update those
  parameters while the graph is running.
- **qtgui** (`qtgui/`): builds gr-qtgui's sink chains (Qt5 upstream) against Qt 6
  for WebAssembly, as a static lib the runner links —
  time/frequency/constellation/waterfall, the eye/histogram/time-raster/vector/
  matrix/BER-curve sinks, and `sink_x`, the four-pane one. Only the last needs
  `uic`, and its `.ui` file is why: see the `--connections string` comment in
  `qtgui/CMakeLists.txt` and the `spectrumdisplayform.cc` entry in
  [docs/gnuradio-patches.md](docs/gnuradio-patches.md). The sinks with no C++
  upstream at all (Number Sink, and the gauges and other Python QWidgets) are
  rebuilt in `blocks/src/` instead.
- **gr-fosphor** is a dual-backend GUI path: WebGPU compute (window, 1024-point
  FFT, waterfall and render, with no readback) when `runner.html` gets an adapter,
  falling back to the Qt6 CPU spectrum/waterfall hierarchy when any of adapter,
  device, pipeline or canvas setup fails. See "The fosphor sink" in
  [docs/blocks.md](docs/blocks.md).

### Layout

| path | contents |
|------|----------|
| `deps/` | `env.sh` (pinned emsdk + sysroot), `fetch-deps.sh` (pinned dep sources) and `build-deps.sh` (cross-build VOLK, Boost, spdlog, GMP, FFTW, Qwt → `sysroot/`) |
| `gr/` | out-of-tree build of the GNU Radio C++ modules (generated; git-ignored) |
| `qtgui/` | Qt6 build of the gr-qtgui sink chain |
| `runner/` | the JSON-driven WASM flowgraph runner, generated C++ registry, support manifest, and shared side-module topology in `modules.json`; vendored headers under `third_party/` |
| `editor/` | the TypeScript flowgraph editor; `main.ts` owns browser orchestration while block schemas, validation, generated-library installation, and example/recording catalogs live in focused modules beside it |
| `editor/gen/` | build-time generators: `gen_blocklib.py` (the palette) and `gen_versions.mjs`, which scrapes every dependency pin into the `virtual:versions` module behind Help ▸ Software Versions — see [docs/building.md](docs/building.md) |
| `tools/` | `block_overrides.py`, the browser-only block-metadata overlay loader/merger shared by `gen_registry.py` and `gen_blocklib.py` |
| `blocks/` | everything a human wrote about blocks, as opposed to `runner/`, which is the app plus everything generated. See "Where a block's source lives" |
| `blocks/grc/` | `.block.yml` for runner-only blocks with no upstream GNU Radio equivalent (`wasm_packet_rate_sink`, `wasm_text_sink`); read by *both* generators alongside GNU Radio's own yaml |
| `blocks/src/` | hand-written block implementations not owned by any one vendored module — `browser_file_source.cpp` and the like |
| `blocks/js/` | repo **JavaScript** blocks: one `.js` per `flags: [js]` block in `blocks/grc/`, fetched by id at run time rather than linked in — so *editing* one is a file copy. Adding one still relinks (its id is baked into the generated registrar). See [docs/js-blocks.md](docs/js-blocks.md) |
| `blocks/overlays/<module>/` | one directory per module: `metadata.yml` (every browser-only addition to that module's blocks) plus, for an OOT module, its `shims/` and any C++ rebuilt from a Python-only block. This is why the submodules need no fork. `blocks/overlays/gnuradio/` is the in-tree equivalent, metadata only |
| `runner/src/pyodide/` | the Embedded Python Block's worker and the Python shim a user's block runs against (`gnuradio.gr`'s base classes, `pmt`, the introspection and work driver). Copied to `runner/build/pyodide/` and served to both the runner and the editor |
| `docs/` | the per-task docs listed at the top of this file |
| `example_flowgraphs/` | the `.grc` files the editor's "Example Flowgraphs" palette tab lists recursively (nested directories appear as collapsible folders); several are also smoke-test cases. Each is linkable as `#example=<relative path without .grc>`. Test changes with `scripts/run_example.mjs` — see [docs/flowgraph-files.md](docs/flowgraph-files.md) |
| `workers/sigmf-indexer/` | Cloudflare Queue consumer that rebuilds the recordings bucket's `index.json` — see [docs/recording-viewer.md](docs/recording-viewer.md) |
| `workers/ai-proxy/` | Cloudflare Worker holding one OpenAI key and one OpenRouter key for every visitor, each metered per IP and per day, behind Flowgraph Copilot's two free providers — see [docs/ai-copilot.md](docs/ai-copilot.md). Both Workers deploy by hand with `wrangler`; no CI deploys them |
| `server.mjs` | COOP/COEP static dev server (needed for SharedArrayBuffer / pthreads); serves the repo root, falls back to `editor/dist/` for `/`, and synthesizes the `/example_flowgraphs` listing. Recording discovery and objects always come directly from R2 |
| `test/` | `test_smoke.mjs` and `test_lazy_scenarios.mjs` plus the `fixtures/` `.grc` they load; CI gates the deploy on both. `test_pr_security_scan.mjs` covers the PR security gate's diff scan and runs in that gate's own workflow. `editor/test/` and `runner/test/` hold their own suites |
| `scripts/` | `assemble-site.mjs` (assembles the static site CI deploys to Pages), `serve_site.mjs` (serves it the way Pages does), `run.mjs` (headless-Chromium harness, waits on a page `#result`), `run_example.mjs` (opens an example in the real editor and presses Run), `arrange_example.mjs` (auto-arranges examples through that same editor), `pr-security-scan.mjs` + `sarif-gate.mjs` (the PR security gate — see [docs/ci.md](docs/ci.md)), `r2-cors.json` |
| `editor/src/recording/` | the SigMF recording viewer, emitted at `/recording/` by the normal editor build |

## Build

First-time setup (emsdk 3.1.70, Qt 6.9.1 WASM multithread, Node ≥ 20, the
dependency cross-build into `sysroot/`), the GNU Radio configure line, the build
invariants, and the on-demand side-module split are all in
[docs/building.md](docs/building.md). Read it before changing anything about how
the tree is built.

**Environment — re-run in every new shell:**

```bash
cd /path/to/gnuradio-world
source deps/env.sh                            # activates emsdk, exports $SYSROOT
export GR="$PWD/gnuradio"
export QT_HOST=~/Qt/6.9.1/gcc_64
export QT_WASM=~/Qt/6.9.1/wasm_multithread
```

The everyday loop, once `sysroot/` and `gr/build-gr` exist:

```bash
python3 runner/gen_registry.py                       # after any block metadata change
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
cmake --build runner/build --target side_modules     # fast: one side module, no relink
(cd runner && cmake --build build)                   # side modules + main relink (~2 min)
(cd editor && npm run build)
```

Never hand-edit a generated registry or palette artifact — change the block
metadata (`blocks/overlays/<module>/metadata.yml` for a vendored module, never
the submodule's own yaml), `runner/gen_registry.py`, or the handwritten registry,
then regenerate.

**`editor/public/blocks.json` and `runner/generated_blocks.json` are not
committed.** They are build outputs, they are regenerated by CI before anything
is built, and committing them put a regenerated 2 MB artifact in the diff of
every block change. `npm run blocks` in `editor/` runs both generators in order,
and `npm test` there runs it first, so the editor suite always reads a fresh
palette. `npm run build` and `npm run dev` fail with a clear message rather than
shipping an editor with an empty palette if the generators have not been run.

## Run and test

Always serve the site through the repository server, because WASM pthreads and
`SharedArrayBuffer` require its COOP/COEP headers:

**Keep the app running.** Never stop, kill, or replace an existing repository
server unless the user explicitly asks. If port 8090 is already in use, assume
that server is intentional and reuse it. If the app is not running, start it and
leave it running after the task is complete.

```bash
node server.mjs 8090 "$PWD"
# open http://localhost:8090/  → build a flowgraph → press ▶ Run
```

Useful validation:

```bash
node test/test_lazy_scenarios.mjs   # deferred category modules are fetched and dlopen'd
node test/test_smoke.mjs            # blocks actually move samples, not merely that it links
node scripts/run.mjs /runner/build/runner.html RUNNER_PASS
node runner/test/audio_worklet.test.mjs  # Audio Sink/Source's worklet, on plain Node
node runner/test/browser_file_writer.test.mjs  # SigMF Sink's writer worker, likewise
node runner/test/js_runtime.test.mjs    # the JS Block harness, on plain Node in a second
node test/test_js_block.mjs             # ... a flowgraph whose work() is JavaScript
node test/test_js_block_editor.mjs      # ... and the editor deriving ports as you type
python3 runner/test/test_grworld.py     # the Embedded Python Block's Python contract
node test/test_python_block.mjs         # ... a flowgraph whose work() is Python
node test/test_python_block_editor.mjs  # ... and the editor deriving ports from code

node test/test_pr_security_scan.mjs     # the PR security gate's diff scan still detects
node scripts/pr-security-scan.mjs --base origin/main --head HEAD   # ... over your own branch
```

The three Embedded Python tests: the two browser ones skip unless
`deps/fetch-pyodide.sh` has been run, which is why the Python Block is not a case
in `test_smoke.mjs` — the suite the deploy is gated on should not fail over an
optional runtime. Both browser tests start their own COOP/COEP server on a
private port, so they need no `server.mjs` running; `scripts/run.mjs` does (port
8090 by default, hence the server command above). `npm test` at the repository
root runs the two of them.

A `RUNNER_PASS` proves module loading, block construction, and graph startup, but
does not by itself prove DSP correctness.

**Anything under `example_flowgraphs/` must be run through the actual editor
before it is done** — `node scripts/run_example.mjs <file>.grc`, expecting
`EXAMPLE_PASS`. The headless harnesses hand the `.grc` straight to `runner.html`
and skip every editor pass, and two classes of silent bug live in that gap. New
examples also need auto-arranging before they are committed
(`node scripts/arrange_example.mjs <file>.grc`). See
[docs/flowgraph-files.md](docs/flowgraph-files.md), which also covers writing
`test/fixtures/` `.grc` by hand.

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

| what | where |
|------|-------|
| metadata for a block with no upstream definition | `blocks/grc/<id>.block.yml` |
| its implementation, any browser replacement of an **in-tree** GNU Radio block, and any C++ rebuild of an in-tree Python hier block | `blocks/src/` — `<module>_hier.hpp` per GNU Radio module rebuilt |
| browser-only metadata for one module's blocks | `blocks/overlays/<module>/metadata.yml` |
| a headers-only stand-in for a host-only dependency | `blocks/overlays/gr-<m>/shims/` |
| C++ rebuilt from an **out-of-tree** module's Python-only block | `blocks/overlays/gr-<m>/` |
| a block whose `work()` is **JavaScript** rather than C++ | `blocks/js/<id>.js`, with `flags: [js]` in its `blocks/grc/<id>.block.yml`. No C++ at all — see [docs/js-blocks.md](docs/js-blocks.md) for the add-a-block checklist |

The factory *table* — every `block-id → factory` entry — lives in
[`runner/src/registry.cpp`](runner/src/registry.cpp), and the line between it and
`blocks/` is **whether the code reads a flowgraph parameter**: anything taking a
`const json&` is factory-side, a block class takes plain C++ arguments. Adding an
entry to that table is the *whole* declaration of a hand-written factory —
`gen_registry.py` reads the set of custom ids back out of it, so there is no
second list to keep in step. That, the `INVALID_CPP_TEMPLATES` / `EXCLUDED_BLOCKS`
conventions, and the `generated_blocks.json` support manifest are in
[docs/blocks.md](docs/blocks.md).

## Runtime gotchas

The cross-cutting ones. Each entry that ends in a pointer is a trap whose full
explanation lives in that doc — follow it before working in that area.

- **The editor drops parameters its schema does not declare, silently.** A
  hand-written `RUNNABLE` schema in `editor/src/main.ts` supersedes the generated
  one, so a `.grc` using GRC's own parameter id for a block that has a
  hand-written schema loads with the schema default in place, runs fine, and
  quietly computes something else. This is the single most common way a
  hand-authored flowgraph goes wrong. See
  [docs/flowgraph-files.md](docs/flowgraph-files.md).
- **The runner's YAML parser accepts flow *sequences* but not flow *mappings*.**
  An inline `- {src_blk_id: a, ...}` message connection is silently dropped; use
  the block-mapping form GRC and the editor emit. See
  [docs/flowgraph-files.md](docs/flowgraph-files.md).
- **Parameter expressions are evaluated by the editor, not the runner.** A `.grc`
  fed straight to `runner.html` must have its arithmetic pre-computed. PMT
  parameters are *parsed*, never evaluated. See
  [docs/flowgraph-files.md](docs/flowgraph-files.md).
- **Use `blocks_throttle2`, never `blocks_throttle`**, and terminate PDU chains
  with `pdu_pdu_to_stream_x` rather than `pdu_pdu_to_tagged_stream`, which is not
  scheduled here. Reasons in [docs/flowgraph-files.md](docs/flowgraph-files.md).
- **Message-only blocks report `items: 0` forever** — `gr_stats_json()` reads
  `nitems_written`/`nitems_read`, which do not exist for a block with no stream
  ports. The snapshot flags them as `msg_only` and `test_smoke.mjs` exempts them
  from its "every block moved items" rule.
- **What a running flowgraph prints reaches the editor's console pane.** Blocks
  that report to the user do it by printing — Message Debug dumps each PDU, Print
  Header / Print Timestamp annotate frames — and Emscripten sends that to
  console.log, i.e. devtools, where nobody looks. `runner.html` sets Emscripten's
  `print` hook to also batch the lines to the parent frame as a `gr-print`
  message, which `main.ts` appends to `#log` under the canvas. Batched and capped
  at both ends because a Message Debug on a fast frame source emits well over a
  thousand lines a second; the editor reports what it shed. A block that emits a
  byte stream of characters needs `wasm_text_sink` ("Text Sink") to be seen at
  all — a File Sink cannot work against Emscripten's in-memory filesystem.
- **GR's logger needs a sink installed by hand.** `gr::logging` picks its sink
  from the `log_file` pref, which is empty in the browser (no config file), so the
  default backend has *no* sinks and silently drops every message — and
  Emscripten's stdout/stderr are not visible here either. `runner.cpp` registers a
  `BrowserLogSink` that mirrors error-level records into the flowgraph window and
  posts them to the editor. Preserve it: without it, a block that throws out of
  `work()` looks like a graph that simply produces nothing.
- **Exception catching is a compile-time flag.** Without `-fexceptions` on the
  *compile* line every `try`/`catch` in that object is inert and a bad block
  parameter kills the runtime as an opaque `Uncaught <pointer>` instead of
  surfacing as `RUNNER_FAIL: <message>`. Everything is compiled with it; keep it
  that way. See [docs/building.md](docs/building.md).
- **A header `registry.cpp` includes is compiled with Qt's macros in scope** —
  `emit`, `signals`, `slots` — so a member function named `emit()` fails to
  compile with an error pointing at the call site. See
  [docs/blocks.md](docs/blocks.md).
- **`gui_hint` does nothing; one block arranges the whole window.** Every
  flowgraph carries a singleton GUI Layout block holding a
  `block ID → [col, row, w, h]` grid, the packing rules live only in
  `editor/src/gui-layout.ts`, and a factory that grows a `QWidget` without a
  `gui: true` declaration in the block's metadata silently loses its tile. See
  [docs/gui-layout.md](docs/gui-layout.md).
- **A QT GUI control is two objects, not one** — a variable that publishes a
  double under its block ID, plus (usually) a message block. See
  [docs/blocks.md](docs/blocks.md).
- **A parameter a Range drives needs a `numeric_setters` entry, or it silently
  freezes.** The runner binds a Range to a block by GRC parameter id and skips
  the binding without a word when the factory has no setter for it — the slider
  still moves and publishes, the block keeps its construction-time value.
  Generated factories emit one per simple `callbacks:` entry in the yaml;
  hand-written ones must add theirs. See [docs/blocks.md](docs/blocks.md).
- **Four blocks read a file, one per place a file can be** — File Source (local
  raw samples, session-bound), SigMF Source (a local `.sigmf-data`/`.sigmf-meta`
  pair, whose captures and annotations become stream tags), GR World Recording (an
  R2 key the runner's factory expands), and Public HTTP Recording (a URL the
  editor rewrites on the Run path). See
  [docs/recording-viewer.md](docs/recording-viewer.md).
- **One block writes a file, and stopping it is not free.** There is no File Sink
  here — Emscripten's filesystem is in-memory — so SigMF Sink hands its input to a
  worker that streams it into a folder the reader chose, or buffers and downloads
  it where the File System Access API is absent. Either way, the editor's usual
  way of stopping a flowgraph (unloading the runner iframe) would kill that worker
  mid-recording, so a flowgraph containing one is brought down through
  `gr_shutdown_flowgraph()` first and the frame unloaded only on the
  acknowledgement. That entry point **signals and returns; it must never join** —
  a block's `stop()` runs on its own thread and proxies to the browser main
  thread, so waiting for it there deadlocks any flowgraph at all. See
  [docs/recording-viewer.md](docs/recording-viewer.md).
- **Two blocks reach the sound card, and the browser may refuse to start it.**
  Audio Sink and Audio Source keep gr-audio's ids and parameters but none of its
  code — gr-audio is not built — over an `AudioWorkletProcessor` and a ring in
  shared memory. Audio Sink is the flowgraph's clock exactly as it is natively,
  by blocking on ring space. But a browser will not start an `AudioContext`
  until the page has been interacted with, and `resume()` **never settles** when
  it is refused rather than rejecting — so nothing awaits it, and the sink falls
  back to pacing by the wall clock and discarding, which keeps the graph (and
  its plots) running at the right rate while it is silent. See
  [docs/audio.md](docs/audio.md).
- **One block reads a radio, and its permission is granted before the graph
  starts.** RTL-SDR Source reaches a dongle over WebUSB from a worker, through
  the same shared-memory ring and futex `BrowserFileSource` uses — but a live
  source cannot backpressure, so a full ring drops and counts. `requestDevice()`
  needs a user gesture that neither a GNU Radio constructor nor a worker has, so
  the editor prompts on the Run click and the worker re-acquires the device by
  origin permission; no `USBDevice` ever crosses a frame. Chromium only. See
  [docs/rtlsdr.md](docs/rtlsdr.md).
- **Python-only blocks have no automatic C++ path** — a `gr.hier_block2`, a GUI
  QWidget, or a block resting on a host facility gets a hand-written rebuild or
  stays greyed out in the palette. See [docs/blocks.md](docs/blocks.md).
- **A JS block's typed-array views must be re-derived on every `work()` call.**
  On the `-pthread` shared heap, memory growth does *not* detach the old
  `SharedArrayBuffer` — a stale view keeps reading and writing the same real
  memory, correctly. What it cannot do is address memory that only exists *after*
  the growth, so a cached `subarray` fails as a **silent out-of-range against a
  buffer allocated later**, not as a crash or a zero read. Take views through
  `GROWABLE_HEAP_*` every call and never stash one on `this`. See
  [docs/js-blocks.md](docs/js-blocks.md).
- **`MAIN_THREAD_EM_ASM` in a JS block's hot path would silently serialize the
  whole flowgraph.** `EM_ASM` runs on the calling thread; `MAIN_THREAD_EM_ASM`
  proxies to the browser main thread and blocks until it answers. Every *other*
  JS-crossing helper in this tree uses the proxying form, because they all run
  from constructors on the main thread — so copying one into
  `blocks/src/js_block.hpp` compiles, runs, produces correct samples, and queues
  every JS block behind Qt's event loop. `window` is undefined on a pthread for
  the same reason; use `globalThis`. See [docs/js-blocks.md](docs/js-blocks.md).
- **A JS block's source is evaluated twice, and its `work()` cannot be
  interrupted.** Once on the main thread for its descriptor and once on the
  block's own thread for its instance, so module-level side effects run twice and
  per-instance state belongs in `start()` or on `this`. And a `work()` that never
  returns wedges that scheduler thread until the tab is reloaded — there is no
  worker to terminate, because the call is on the thread's own stack. See
  [docs/js-blocks.md](docs/js-blocks.md).
- **A block whose `work()` is not C++ blocks its own scheduler thread and nothing
  else.** Its constructor still cannot wait (the browser main thread cannot
  `Atomics.wait`), so anything needed at construction is settled in a prepare
  step, and a call back into C++ from inside `work()` cannot be synchronous. The
  Embedded Python Block is the built example, and its ports and parameters come
  from its own source rather than its block id — new editor code must resolve
  definitions through `defFor(inst)`. See
  [docs/embedded-python.md](docs/embedded-python.md).
- **Symbols crossing the core/side-module boundary** need a manual edge in two
  cases: a core factory using a deferred module's symbols, and a deferred module
  using another deferred module's. Otherwise `dlopen` fails with `bad export type
  for '<mangled name>': undefined`. See
  [docs/adding-modules.md](docs/adding-modules.md).
- **No true double-mapped memory.** Emscripten cannot create VM aliases; the
  emulated buffer uses twice the physical memory and copies produced bytes into
  its mirror. See [docs/double-mapped-buffer.md](docs/double-mapped-buffer.md).
- **Host-only dependencies** such as UHD, Boost.Asio networking, Boost.Locale, and
  libsndfile need an Emscripten guard, a browser-safe replacement, or exclusion of
  the affected block. See [docs/adding-modules.md](docs/adding-modules.md).
