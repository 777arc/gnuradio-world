# GNU Radio in the browser (WebAssembly)

A GNU Radio Companion-style **flowgraph editor** and a **flowgraph runtime** that
run entirely in a browser tab — no Python, no server round-trips. The GNU Radio
DSP C++ stack (gnuradio-runtime, gr-blocks, gr-fft, gr-filter, gr-analog,
gr-digital, gr-fec, gr-dtv, gr-network, gr-pdu, and gr-vocoder) and the
gr-qtgui sinks are cross-compiled to WebAssembly with Emscripten and threaded
Qt 6 for WebAssembly.

If already built, run using

```bash
node server.mjs 8090 "$PWD"
# open http://localhost:8090/
```

## Quickstart (fresh Ubuntu 24.04)

Builds the whole stack from source and serves the editor. The repo can live
anywhere: `deps/env.sh`, the Qwt config and the runner/qtgui
`CMakeLists.txt` derive the repository root from their own locations, while
`$GR` selects the GNU Radio source submodule (CI sets it explicitly). Only Qt is
assumed to be under `~/Qt` — adjust the `QT_*` variables below if yours differs.

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
cd /path/to/gnuradio-world
source deps/env.sh                            # activates emsdk, exports $SYSROOT
export GR="$PWD/gnuradio"
export QT_HOST=~/Qt/6.9.1/gcc_64
export QT_WASM=~/Qt/6.9.1/wasm_multithread
```

**3-4. Fetch and cross-build the C++ dependencies → `sysroot/`**

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
runners. `SYSROOT=/tmp/scratch bash deps/build-deps.sh` builds into a
throwaway prefix, which is how to test a change to the recipe without risking a
working tree.

**5. Build GNU Radio and the WASM apps**

```bash
# GR C++ modules: no Python, static, emulated (software) double-mapped vmcircbuf.
# -fPIC is required for the MAIN_MODULE/SIDE_MODULE dynamic linking (see note below);
# -fexceptions keeps GR's own try/catch alive under Emscripten (see note below).
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
  -DTRY_SHM_VMCIRCBUF=OFF -DCMAKE_DISABLE_FIND_PACKAGE_libunwind=ON
cmake --build gr/build-gr

# Regenerate direct C++ factories and the matching editor palette.
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json

# gr-qtgui sinks → runner (links core + emits per-category side modules) → editor
(cd qtgui  && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST" -DCMAKE_CXX_FLAGS="-pthread -fPIC" && cmake --build build)
(cd runner && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST" -DCMAKE_BUILD_TYPE=Release && cmake --build build)
(cd editor && npm install && npm run build)

# IQEngine client (git submodule), served from /iqengine/ so the recordings tab
# can link into its spectrogram view. Optional; skip it and those links 404.
# Hash routing because Cloudflare Pages cannot serve index.html for arbitrary
# paths under a sub-directory; the feature flags trim it to what this site uses:
# no Python snippet editor (it needs Pyodide from a CDN that this
# cross-origin-isolated site will not load) and no Cyclostationary tab.
git submodule update --init
(cd iqengine/client && npm ci && \
   IQENGINE_HASH_ROUTER=true \
   IQENGINE_FEATURE_FLAGS='{"displayPythonSnippet":false,"displayCyclostationaryTab":false,"linkLogoToBrowser":false}' npm run build -- --base=/iqengine/)
```

> **Optimized vs. dev build.** `-DCMAKE_BUILD_TYPE=Release` runs the link-time
> `wasm-opt -Oz` pass on the core module (~100 MB → ~18 MB); the side modules are
> always built `-Oz`. Omit `-DCMAKE_BUILD_TYPE=Release` for a fast, unoptimized
> core when iterating (each optimized link adds ~1 min). Switching build type is a
> reconfigure, so re-run the `qt-cmake` line when you change it.

**On-demand category modules.** The runner is an Emscripten `MAIN_MODULE` that
loads block categories on demand. `gen_registry.py` splits the block factories
into a core registrar (blocks/analog/fft/filter, linked into the main module) and
one self-registering `generated_registry_<m>.cpp` per deferred category
(digital/dtv/network/pdu/vocoder). The runner CMake compiles each of those into a
`SIDE_MODULE` (`runner/build/<m>.wasm`); at run time `gr_run_json` inspects
the flowgraph, `emscripten_dlopen`s only the categories it uses, and posts a
`gr-module` message the editor uses to color the palette. Constraints that make
this work (all handled by the build): everything is `-fPIC`; `MAIN_MODULE=2` +
`EXPORT_ALL` + whole-archived core + a generated `side_exports.rsp` export every
symbol the side modules import; side modules use `-sWASM_BIGINT` to match Qt's
ABI; and `patch_runner_js.py` fixes a Qt+MAIN_MODULE `addFunction` assertion.
Verify with `node test_lazy_scenarios.mjs`.

**6. Run**

```bash
node server.mjs 8090 "$PWD"
# open http://localhost:8090/  → build a flowgraph → press ▶ Run
```

The sections below explain the architecture and each component in more detail.

## Adding a category (module) of blocks

A "category" here is one GNU Radio component library (`gr-<m>`) exposed as either
part of the always-loaded core or an on-demand side module. To add one (say
`gr-foo`):

1. **Build the GR library** with `-fPIC`. Add `-DENABLE_GR_FOO=ON` to the
   `gr/build-gr` configure line (step 5) and rebuild, producing
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
   stamps each block with its `module`, and a deferred category shows amber
   ("downloads on first use") → cyan once fetched.

## Adding an out-of-tree (OOT) module (step-by-step)

The recipe above assumes an in-tree `gr-<m>` built by `gr/build-gr`. A
third-party OOT module (already done for [`gr-rds/`](gnuradio/gr-rds),
[`gr-foo/`](gr-foo), [`gr-dvbs2/`](gr-dvbs2),
[`gr-dvbs2rx/`](gr-dvbs2rx)) is **not** part of that
umbrella build, so there is no `libgnuradio-<m>.a`; instead its own `lib/*.cc` are
compiled straight into an on-demand `<m>.wasm` side module. This is a
**self-contained checklist** — following it needs no investigation beyond the
module itself. Copy an existing OOT module (gr-foo is the simplest, gr-dvbs2 the
most complex) as a working reference for every step.

**1. Vendor it** at the world-repo top level, beside the `gnuradio/` submodule:
```bash
git clone --depth 1 https://github.com/<owner>/gr-<m>.git gr-<m>
rm -rf gr-<m>/.git gr-<m>/.github
```

**2. Triage the blocks** — which have a C++ path, and what they depend on:
```bash
ls gr-<m>/lib/*.cc                                   # C++ blocks have an impl here
ls gr-<m>/python/*.py                                # gr.hier_block2 / GUI = Python-only
grep -rHn 'static sptr make' gr-<m>/include/*/*.h    # constructor signatures
grep -rho '#include *<[a-z].*>' gr-<m>/lib/*.cc | sort -u   # spot host-only deps
```
A block is directly generator-buildable only if it has a C++ impl. **Python-only
blocks** — a
`gr.hier_block2` (e.g. gr-foo's `selector`/`valve`) or a GUI QWidget (e.g.
`rds_panel` = `rds.rdsPanel`) — have no automatic C++ path. Leave their yaml
alone unless the hierarchy is rebuilt as a hand-written C++ `hier_block2` in
the runner; otherwise they show greyed-out in the palette. **Host-only deps** not
in the WASM sysroot (UHD, Boost.Asio networking, Boost.Locale, libsndfile, …)
must be dealt with in step 4.

**3. Add `cpp_templates` to each C++ block's `.block.yml`.** This is what the
generator turns into a factory. Add `flags: [python, cpp]` near the top and, right
before `file_format:`:
```yaml
cpp_templates:
    includes: ['#include <<m>/<block>.h>']
    declarations: '<m>::<block>::sptr ${id};'
    make: 'this->${id} = <m>::<block>::make(${arg1}, ${arg2});'
    link: ['gnuradio-<m>']
```
Mirror the arg order of the existing Python `templates: make:`, resolved against
the C++ `make()` signature from step 2. If the module has an in-tree analogue,
copy that block's `cpp_templates` verbatim (gr-dvbs2's blocks ≈ gr-dtv's
`dtv_dvb*`). Three generator constraints, each with a standard fix:
  - **Foreign-namespace enum values.** When `${param.val}` expands to
    `<m>.SOMETHING`, add `translations: {<m>\.: '<m>::'}` under `cpp_templates`
    (the generated file has `using namespace gr;`, so `<m>::SOMETHING` resolves).
    This mirrors gr-dtv's `dtv\.: 'dtv::'`.
  - **`raw` params the generator can't type** make the whole block *skip* (watch
    for it in the `gen_registry.py` "skipped" output). Retype in the yaml: a PMT
    (`pmt.intern("x")`) → `dtype: string` default `x`, and wrap the make in
    `pmt.intern(...)` (native) / `pmt::intern(...)` (cpp); a bare numeric
    expression → `int`/`real`.
  - **Stale enum options (yaml vs. header drift).** If the generated code names an
    enumerator the vendored C++ enum lacks (`no member named '<m>::FOO'`), prune
    that option from the param's `options`/`option_labels`/`option_attributes.val`
    lists — **keep the three index-aligned** (they pair positionally).

**4. Handle host-only deps** so the desktop build stays intact:
  - Guard the offending code with `#ifdef __EMSCRIPTEN__` and provide a
    browser-safe replacement (gr-rds's one Boost.Locale call → an inline
    ISO-8859-2 conversion), **or**
  - if it's already behind a feature macro, just leave that undefined (gr-foo's
    UHD `tx_time` tagging under `#ifdef FOO_UHD`), **or**
  - if a whole block is unusable in the browser (host networking, etc.), drop its
    source from step 6 and leave its yaml Python-only (gr-dvbs2's `bbheader_source`
    = a Boost.Asio UDP source).
  - **Header-only SIMD libraries** that dispatch on `__AVX2__` / `__SSE4_1__` /
    `__ARM_NEON__` (gr-dvbs2rx's LDPC/BCH decoder) need nothing: Emscripten defines
    none of those, so they fall back to their generic scalar path and compile as-is
    (slower, still correct). Don't add `-msimd128`/`-msse4.1`.

**5. Add an empty `gr-<m>/lib/config.h`** — the impls `#include "config.h"`, which
the module's own CMake normally generates. (Any real per-module constants header
that ships in the repo, e.g. `dvbs2_config.h`, is used as-is.)

**6. Register and wire the build:**
  - [`runner/gen_registry.py`](runner/gen_registry.py): add `"gr-<m>"` to
    `MODULES` and the short name `"<m>"` to `DEFERRED_MODULES`.
  - [`runner/CMakeLists.txt`](runner/CMakeLists.txt): add `${GR}/gr-<m>/include`
    to `GR_INCLUDE_DIRS`, then copy an existing OOT `add_custom_command` (the
    `rds` / `foo` / `dvbs2` block) — list `generated_registry_<m>.cpp` plus the
    module's `lib/*.cc` (minus any source excluded in step 4) and append
    `<m>_out` to `SIDE_MODULE_OUTPUTS`. **Do not** add `<m>` to the CMake
    `DEFERRED_MODULES` list — that loop links a `build-gr` `.a` the OOT module
    doesn't have. `side_exports`/palette/on-demand fetch then work unchanged.

**7. Generate, compile-check, build, verify:**
```bash
python3 runner/gen_registry.py                      # expect "<m>=N", skipped {}
source ~/emsdk/emsdk_env.sh                          # emsdk 3.1.70 on PATH
cmake --build runner/build --target side_modules    # FAST: builds <m>.wasm only, no main relink
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
(cd runner && cmake --build build)                  # side modules + main relink (~2 min: wasm-opt)
(cd editor && npm run build)
```
The `side_modules` target is the fast inner loop for iterating on `cpp_templates`
/ source fixes; only do the full `cmake --build build` (which relinks the ~18 MB
main module) once the side module compiles clean.

**8. Smoke-test headless** — build a tiny `.grc` that forces the module to load
and construct a block, then expect `RESULT: RUNNER_PASS`:
```bash
node server.mjs 8090 "$PWD" &                        # COOP/COEP dev server
URL="/runner/build/runner.html#$(node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(process.argv[1],"utf8")))' my.grc)"
node run.mjs "$URL" RUNNER_PASS 8090 45000           # headless chrome; prints the RESULT line
```
In a hand-written `.grc`, **stream** connections are arrays `[blk, port, blk,
port]`; **message** connections are objects `{src_blk_id, src_port_id, snk_blk_id,
snk_port_id}` (see `grc_lower.hpp`). `RUNNER_PASS` confirms the side module fetched
+ `dlopen`'d and every block constructed and the graph started — it does **not**
verify DSP correctness of the chain.

**General notes / gotchas (apply to in-tree and OOT modules alike)**

- **Hand-written factories** (blocks needing a `QWidget`, live setters, or a
  browser-safe reimplementation) live in [`runner/src/registry.cpp`](runner/src/registry.cpp);
  list their ids in `CUSTOM_IDS` in `gen_registry.py` so no duplicate generated
  factory is emitted. A block whose `cpp_templates` can't be rendered goes in
  `INVALID_CPP_TEMPLATES` with a reason.
- **Python hier blocks** (`gr.hier_block2` compositions such as PSK Mod or the
  OFDM Transmitter) have no C++ path at all, so the browser gets the same block
  id backed by the same chain rebuilt as a C++ `hier_block2` in `registry.cpp`
  (`digital_psk_mod`, `digital_ofdm_tx`). Where the Python block
  computes defaults with numpy (the OFDM sync words), reproduce them exactly:
  numpy's legacy `RandomState(seed)` is MT19937 seeded identically to
  `std::mt19937(seed)`, and `randint(2)` is one 32-bit draw's low bit.
- If a **core** hand-written factory references a **deferred** module's symbols
  (as `digital_psk_mod` uses a few `gr-digital` blocks), link that module's `.a`
  *normally* (not whole-archive) into the main module too, so just those objects
  are pulled into core; the rest stay in the side module. See the `gr-digital`
  entry in `target_link_libraries` for the pattern.
- **Exception catching is a compile-time flag.** Emscripten drops landing pads
  unless `-fexceptions` (≡ `-sNO_DISABLE_EXCEPTION_CATCHING`) is on the *compile*
  line — having it only at link makes every `try`/`catch` in that object inert, so
  a bad block parameter escapes as an opaque `Uncaught <pointer>` that kills the
  runtime instead of surfacing as `RUNNER_FAIL: <message>`. Everything is compiled
  with it: the runner target, the side modules, and the `build-gr` GR libraries
  (so GR's `thread_body_wrapper` catches an exception thrown from a block's
  `work()` and logs it instead of killing the worker).
- **GR's logger needs a sink installed by hand.** `gr::logging` picks its sink
  from the `log_file` pref, which is empty in the browser (no config file), so the
  default backend has *no* sinks and silently drops every message — and
  Emscripten's stdout/stderr are not visible here either. `runner.cpp` registers a
  `BrowserLogSink` that mirrors error-level records into the flowgraph window and
  posts them to the editor. Without it, a block that throws out of `work()` looks
  like a graph that simply produces nothing.
- **Symbol export is automatic:** `gen_side_exports.py` scans each side module's
  `env`/GOT imports and re-exports them from main with `--export-if-defined`, so
  you don't maintain an export list by hand. Side modules must stay ABI-matched to
  Qt (`-pthread -fPIC -sWASM_BIGINT=1`); the CMake rule already applies these.
- **Enum params** whose `.block.yml` has `cpp_templates: translations` that rewrite
  option strings (e.g. `analog.cpm.` → `analog::cpm::`) just work:
  `wasm_registry::choice` matches with `::`/`.` normalized.

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
  enable/disable, bypass), a Properties dialog, and a Run button that hands the
  flowgraph `.grc` to the runner. While running, a draggable horizontal splitter
  resizes the editor canvas and embedded runner panes.
- **Runner** (`runner/`): a generic C++/WASM "player" — parses the flowgraph `.grc`,
  builds blocks via a `block-id → factory` registry, runs the GNU Radio
  thread-per-block scheduler, and renders gr-qtgui sinks to a canvas. Direct C++
  factories are generated from GRC's `cpp_templates`; handwritten factories in
  `src/registry.cpp` add browser widgets, live setters, and a few composed blocks.
  The generated and custom registries currently expose 294 blocks from gr-blocks,
  gr-analog, gr-fft, gr-filter, gr-digital, gr-dtv, gr-network, gr-pdu,
  gr-vocoder and gr-qtgui, plus the vendored out-of-tree modules (gr-rds, gr-foo,
  gr-dvbs2, gr-dvbs2rx). Stream and message-port connections are both
  serialized by the editor. QT GUI Range
  controls can be referenced by ID from numeric block parameters and update those
  parameters while the graph is running.
- **qtgui** (`qtgui/`): builds the gr-qtgui time/frequency/constellation sinks (Qt5 upstream)
  against Qt 6 for WebAssembly, as a static lib the runner links.

## Layout

| path | contents |
|------|----------|
| `deps/` | `env.sh` (pinned emsdk + sysroot), `fetch-deps.sh` (pinned dep sources) and `build-deps.sh` (cross-build VOLK, Boost, spdlog, GMP, FFTW, Qwt → `sysroot/`) |
| `gr/` | out-of-tree build of the GNU Radio C++ modules (generated; git-ignored) |
| `qtgui/` | Qt6 build of the gr-qtgui sink chain |
| `runner/` | the JSON-driven WASM flowgraph runner, generated C++ registry, and support manifest |
| `editor/` | the TypeScript flowgraph editor |
| `tools/` | `generate_cpp.py` (host-side GRC → C++ generation, optional) |
| `server.mjs` | COOP/COEP static dev server (needed for SharedArrayBuffer / pthreads) |
| `run.mjs` | headless-Chromium test harness (waits on a page `#result`) |
| `test_smoke.mjs` | runs example flowgraphs headlessly and asserts samples actually move; CI gates the deploy on it |
| `test_lazy_scenarios.mjs` | verifies on-demand category side modules are fetched and `dlopen`'d |
| `scripts/` | `assemble-site.mjs` (assembles the static site CI deploys to Pages) |
| `iqengine/` | IQEngine as a git submodule; its client is built to `/iqengine/` on the site, so each SigMF recording in the editor gets an "open in IQEngine" link into its spectrogram view (via IQEngine's `url` data source, which reads the `.sigmf-meta`/`.sigmf-data` pair straight off their URLs) |

## Prerequisites (userspace, no sudo)

- **emsdk 3.1.70** (matches Qt 6.9): `~/emsdk/emsdk install 3.1.70 && ~/emsdk/emsdk activate 3.1.70`.
- **Qt 6.9.1 for WebAssembly (multithread) + host tools**, via `aqtinstall`:
  `aqt install-qt linux desktop 6.9.1 linux_gcc_64` and
  `aqt install-qt all_os wasm 6.9.1 wasm_multithread` (into `~/Qt`).
- **Node ≥ 20** (for the editor build and the dev server).
- Dependency sources fetched under `deps/src/` (VOLK 3.1.2, Boost 1.83, spdlog
  1.12, GMP 6.3, FFTW 3.3.10, Qwt 6.2). `deps/env.sh` derives paths from the
  checkout root; its environment variables remain overridable.

## Build

```bash
source deps/env.sh                      # pinned emsdk + $SYSROOT
bash   deps/fetch-deps.sh               # pinned dep sources → deps/src
bash   deps/build-deps.sh               # VOLK/Boost/spdlog/GMP/FFTW/Qwt → sysroot
# GNU Radio C++ modules → gr/build-gr  (emcmake, ENABLE_PYTHON=OFF, static,
#   -DTRY_SHM_VMCIRCBUF=OFF; see git history / env.sh for the exact configure line)
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
(cd qtgui  && $QT_WASM/bin/qt-cmake -S . -B build -GNinja -DQT_HOST_PATH=$QT_HOST && cmake --build build)
(cd runner && $QT_WASM/bin/qt-cmake -S . -B build -GNinja -DQT_HOST_PATH=$QT_HOST && cmake --build build)
(cd editor && npm install && npx vite build)
```

## Run

```bash
node server.mjs 8090 "$PWD"             # COOP/COEP dev server
# open http://localhost:8090/  → build a flowgraph → ▶ Run
```

`node run.mjs /runner/build/runner.html RUNNER_PASS` runs the runner headless.

`runner/generated_blocks.json` is the authoritative runtime support manifest
used to mark palette entries runnable or unavailable. The runner has a small
typed-object registry for constellation variables used by Constellation
Modulator. Other blocks whose constructors require a separately typed GRC
companion object (for example an OFDM equalizer, packet formatter, or message
queue) remain listed under `skipped`. Python-only hierarchy definitions are
supported when their chain has been explicitly rebuilt as a C++ `hier_block2`
in `registry.cpp`; the rest remain unavailable.

## Continuous integration

`.github/workflows/deploy-wasm.yml` builds the whole stack from source and
deploys to Cloudflare Pages on every merge to `main`. Nothing is prebuilt, so
the deployed artifacts can never disagree with the source tree. Two caches keep
that affordable:

- **`sysroot`** — Boost/FFTW/GMP/Qwt/VOLK/spdlog, cached as an *output* keyed on
  `deps/env.sh` + `fetch-deps.sh` + `build-deps.sh` and the emsdk/Qt versions.
  Rebuilt only when one of those changes (~25 min), a hit otherwise.
- **`ccache`** — GNU Radio, qtgui and the runner are recompiled every run, with
  ccache absorbing the cost. Caching `gr/build-gr` instead does *not* work:
  `actions/checkout` stamps every source file with a fresh mtime, so a restored
  ninja build dir rebuilds all ~520 objects anyway. ccache keys on preprocessed
  content, so a one-file GR change recompiles one file.

Before deploying, CI runs `test_smoke.mjs` and `test_lazy_scenarios.mjs`
in headless Chromium. This is a gate, not a formality: a cleanly linked runner can
still be dead on arrival (an unpatched VOLK once made `volk_malloc()` return NULL,
so every flowgraph threw `std::bad_alloc` while CI stayed green). The smoke test
requires every block in the runner's diagnostics snapshot to have moved items, so
a graph that starts but stalls fails too.

`assemble-site.mjs` then version-locks the runner: `runner.js`, `runner.wasm`
and the category side modules are one indivisible build (emcc bakes that link's
`EM_ASM` string addresses into `runner.js`'s `ASM_CONSTS` table), but none of the
names carry a version. A browser that reuses a cached `runner.js` from the
previous deploy while fetching this deploy's `runner.wasm` dies in `main()` with
`ASM_CONSTS[code] is not a function` — the 1.2 MB script is small enough to come
back from the in-memory cache, the 19.5 MB wasm is not. So the assembler hashes
the runner build and stamps `?v=<hash>` onto the `<script>` srcs in
`runner.html`, whose `locateFile` hook passes the same stamp to `runner.wasm` and
every `dlopen`'d side module. `runner.html` itself is always fetched fresh (the
editor appends a unique `recordingToken`), so it is the carrier. Served
unstamped — dev server, smoke tests — the hook is inert.

Because those URLs now change with their content, `_headers` gives them
`Cache-Control: public, max-age=86400`, replacing the `max-age=0,
must-revalidate` Pages defaults to. That is worth doing: the runner iframe
reloads on every Run, and revalidating costs 9 conditional requests per repeat
visit (the pthread workers re-request `runner.js` too) where a warm cache costs
zero. It is a day rather than `immutable` because `_headers` matches paths, not
query strings, so the rules also cover the *unstamped* URLs that
`/runner/build/runner.html` requests when opened directly instead of through the
editor — freezing those for a year would let that one hand-debugging path pin a
stale `runner.js` across deploys and recreate the crash the stamp prevents.

Other triggers: `workflow_dispatch` builds without deploying unless you tick
`deploy`, and `rebuild_sysroot` forces the cold path (~1 h) to test the dep
scripts end to end. A weekly `schedule` run exists purely to keep the caches
alive — GitHub evicts anything unused for 7 days, and it never deploys.

This replaced a prebuilt `sysroot` + GR libs + qtgui tarball attached to a
`deps-vX` GitHub release. That artifact had to be repacked by hand after any
GNU Radio C++ change; when someone forgot, CI silently linked stale libraries
and the deployed site behaved differently from every developer's machine.

## GNU Radio source changes (all guarded, desktop build unaffected)

- `gnuradio-runtime/lib/thread/thread.cc` — `__EMSCRIPTEN__` branch (no prctl/affinity);
  `set_thread_name()` is a silent no-op there rather than an error log, which would
  otherwise fire once per block thread and show up in the runner's error banner.
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
