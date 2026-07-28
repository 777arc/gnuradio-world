# AGENTS.md

## Project overview

This repository runs GNU Radio entirely in a browser. It contains:

- `editor/`: a Vite/TypeScript GNU Radio Companion-style flowgraph editor, it started as a 1:1 port of the gnuradio/grc/gui_qt Python-based GUI but has been adapted since.  If any edits to the editor request that they match the native version, then use gnuradio/grc/gui_qt as the reference.
- `runner/`: a browser application that embeds GNU Radio’s runtime, compiled as WASM. It parses `.grc` (which should be byte-compatible with the native GNU Radio), creates blocks through a generated/custom registry, runs GNU Radio's thread-per-block scheduler, and embeds Qt GUI plots.  It does stuff such as binding browser controls such as Range widgets to live block setters.
- `qtgui/`: the GNU Radio Qt GUI sink chain ported to Qt6 WASM, there are a lot of wasm-specific aspects to it but it attempts to look just like the native version.
- `gnuradio/`: submodule of the main GNU Radio repo
- `gr-rds/`, `gr-foo/`, `gr-dvbs2/`, `gr-dvbs2rx/`: vendored out-of-tree GNU
  Radio modules compiled as on-demand WASM side modules.
- `deps/`: dependency fetch/build scripts, and any patches needed. Built dependencies are installed into the generated, git-ignored `sysroot/`.
- `iqengine/`: optional IQEngine submodule/client, served under `/iqengine/`, allows the feature to open any of the example recordings in an IQEngine spectrogram-based interface for viewing the signal.

The editor passes a serialized `.grc` flowgraph to the runner. The runner is an
Emscripten `MAIN_MODULE`; deferred block categories are ABI-matched
`SIDE_MODULE`s loaded on demand with `dlopen`.

## Toolchain and environment

The supported baseline from the README is Ubuntu 24.04 with:

- Node.js 20 or newer.
- Emscripten/emsdk 3.1.70.
- Qt 6.9.1 host tools and the `wasm_multithread` Qt build.

In every new shell, initialize the build environment:

```bash
source deps/env.sh
export GR="$PWD/gnuradio"
export QT_HOST=~/Qt/6.9.1/gcc_64
export QT_WASM=~/Qt/6.9.1/wasm_multithread
```

`deps/env.sh` derives the repository root and exports `SYSROOT`; its variables
are overridable. Dependency versions are pinned in `deps/fetch-deps.sh`.

Fetch and build dependencies with:

```bash
bash deps/fetch-deps.sh
bash deps/build-deps.sh
```

Both scripts are idempotent. Use `DEPS_MIRROR` to override the download origin.
To experiment with a dependency recipe without touching the working sysroot,
run `SYSROOT=/tmp/scratch bash deps/build-deps.sh`.

## Build workflow

The full GNU Radio `emcmake` configuration is documented in the root README.
Important invariants are:

- GNU Radio is built static, without Python or gr-audio/gr-qtgui.
- `ENABLE_DEFAULT=OFF` also disables the runtime, so
  `ENABLE_GNURADIO_RUNTIME=ON` must be explicit.
- All GNU Radio, runner, and side-module objects need `-pthread -fPIC`.
- Compile all of them with `-fexceptions`; setting it only at link time does not
  preserve C++ catch blocks under Emscripten.
- Disable `libunwind`; the WASM runtime uses `vmcircbuf_emulated`.
- Side modules must use `WASM_BIGINT` to match Qt's ABI. Existing CMake rules
  already enforce this.

After GNU Radio sources or block metadata change, regenerate both runtime
factories and the editor palette:

```bash
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
```

Then build in dependency order:

```bash
(cd qtgui && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja \
  -DQT_HOST_PATH="$QT_HOST" -DCMAKE_CXX_FLAGS="-pthread -fPIC" &&
  cmake --build build)
(cd runner && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja \
  -DQT_HOST_PATH="$QT_HOST" -DCMAKE_BUILD_TYPE=Release &&
  cmake --build build)
(cd editor && npm install && npm run build)
```

A Release runner performs a slow link-time `wasm-opt -Oz` pass. Omit
`CMAKE_BUILD_TYPE=Release` for a faster development build; changing build type
requires rerunning the `qt-cmake` configure command.

`runner/generated_blocks.json` is the authoritative runtime support manifest.
Do not hand-edit generated registry or palette artifacts; change source block
metadata, `runner/gen_registry.py`, or the handwritten registry as appropriate,
then regenerate.

## Run and test

Always serve the site through the repository server because WASM pthreads and
`SharedArrayBuffer` require its COOP/COEP headers:

```bash
node server.mjs 8090 "$PWD"
# open http://localhost:8090/
```

Useful validation:

```bash
node test_lazy_scenarios.mjs
node test_smoke.mjs
node run.mjs /runner/build/runner.html RUNNER_PASS
```

- `test_lazy_scenarios.mjs` verifies deferred category modules are fetched and
  loaded.
- `test_smoke.mjs` verifies blocks actually move samples, not merely that the
  runner links or starts.
- `run.mjs` is the headless Chromium harness and waits for a page `#result`.

For a fast out-of-tree module compile loop:

```bash
cmake --build runner/build --target side_modules
```

Once it compiles, do the full runner relink, rebuild the editor, and run the
headless smoke test. A `RUNNER_PASS` proves module loading, block construction,
and graph startup, but does not by itself prove DSP correctness.

## Registry and module conventions

Direct C++ factories are generated from GRC `.block.yml` `cpp_templates`.
Factories needing browser widgets, live setters, or browser-specific composed
blocks live in `runner/src/registry.cpp`.

- Add handwritten factory IDs to `CUSTOM_IDS` in `runner/gen_registry.py` to
  avoid duplicate generated factories.
- Put block metadata that cannot be rendered in `INVALID_CPP_TEMPLATES`, with a
  reason.
- Python-only `gr.hier_block2` definitions are unavailable unless explicitly
  rebuilt as C++ hierarchies in `runner/src/registry.cpp`.
- Blocks absent from the WASM registry remain visible but disabled in the
  editor palette.
- Symbol exports for side modules are generated automatically by
  `gen_side_exports.py`; do not maintain a manual export list.

For an in-tree `gr-<module>` category:

1. Enable and build its GNU Radio static library with PIC.
2. Add it to `MODULES` and either `CORE_MODULES` or `DEFERRED_MODULES` in
   `runner/gen_registry.py`.
3. Record dependencies between deferred modules in `MODULE_DEPS`.
4. Update include/library wiring in `runner/CMakeLists.txt`.
5. Regenerate both registries, rebuild, and test lazy loading.

For a vendored out-of-tree (OOT) module, follow the complete checklist in the root
README. In particular, compile its `lib/*.cc` directly into a custom side-module
target. Do **not** add it to CMake's normal `DEFERRED_MODULES` loop, which expects
a `build-gr` static archive. Preserve desktop behavior by guarding browser-only
source changes with `#ifdef __EMSCRIPTEN__`.

In handwritten `.grc` test fixtures:

- Stream connections are arrays: `[block, port, block, port]`.
- Message connections are objects with `src_blk_id`, `src_port_id`,
  `snk_blk_id`, and `snk_port_id`.

## Runtime gotchas

- A core handwritten factory that references symbols from a deferred GNU Radio
  module must also link that module normally into the main module so only the
  required objects are pulled into core.
- The browser has no GNU Radio config file, so `runner.cpp` installs a
  `BrowserLogSink`. Preserve it: otherwise worker exceptions look like silent
  stalls.
- Emscripten cannot provide true double-mapped virtual memory. The emulated
  buffer uses twice the physical memory and copies produced bytes into its
  mirror. See `docs/double-mapped-buffer.md`.
- FFTW uses `FFTW_ESTIMATE` under WASM because `FFTW_MEASURE` benchmarking
  hangs.
- Host-only dependencies such as UHD, Boost.Asio networking, Boost.Locale, and
  libsndfile need an Emscripten guard, a browser-safe replacement, or exclusion
  of the affected block.

## CI expectations

`.github/workflows/deploy-wasm.yml` builds everything from source and deploys on
merges to `main`. It caches the dependency sysroot and uses ccache for GNU
Radio/qtgui/runner objects. Before deployment, `test_smoke.mjs` and
`test_lazy_scenarios.mjs` are required gates. Changes should leave those tests
passing; a successful link alone is not adequate validation.
