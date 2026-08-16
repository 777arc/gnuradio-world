# Toolchain, build workflow, and the module split

Everything needed to go from a fresh machine to a built stack, plus the build
invariants that make the WASM link work. [AGENTS.md](../AGENTS.md) keeps only the
short version — the environment block and the incremental rebuild commands.

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

## 1. Fetch and cross-build the C++ dependencies → `sysroot/`

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
[embedded-python.md](embedded-python.md).

`DEPS_MIRROR=https://host/path` makes `fetch-deps.sh` pull the tarballs from a
mirror you control instead of SourceForge/ftp.gnu.org, which rate-limit CI
runners. `SYSROOT=/tmp/scratch bash deps/build-deps.sh` builds into a throwaway
prefix, which is how to test a change to the recipe without risking a working
tree.

## 2. Build GNU Radio and the WASM apps

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

## Build invariants to preserve

- GNU Radio is built static, without Python or gr-audio/gr-qtgui.
- `ENABLE_DEFAULT=OFF` also disables the runtime, so `ENABLE_GNURADIO_RUNTIME=ON`
  must be explicit.
- All GNU Radio, runner, and side-module objects need `-pthread -fPIC`.
- Compile all of them with `-fexceptions`; setting it only at link time does not
  preserve C++ catch blocks under Emscripten. Emscripten drops landing pads
  unless `-fexceptions` (≡ `-sNO_DISABLE_EXCEPTION_CATCHING`) is on the *compile*
  line — having it only at link makes every `try`/`catch` in that object inert, so
  a bad block parameter escapes as an opaque `Uncaught <pointer>` that kills the
  runtime instead of surfacing as `RUNNER_FAIL: <message>`. Everything is compiled
  with it: the runner target, the side modules, and the `build-gr` GR libraries
  (so GR's `thread_body_wrapper` catches an exception thrown from a block's
  `work()` and logs it instead of killing the worker).
- Disable `libunwind`; the WASM runtime uses `vmcircbuf_emulated`. See
  [double-mapped-buffer.md](double-mapped-buffer.md).
- Side modules must use `WASM_BIGINT` to match Qt's ABI. Existing CMake rules
  already enforce this.
- **FFTW** uses `FFTW_ESTIMATE` under WASM because `FFTW_MEASURE` benchmarking
  hangs there.

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

## On-demand category modules

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

**Symbol export is automatic:** `gen_side_exports.py` scans each side module's
`env`/GOT imports and re-exports them from main with `--export-if-defined`, so
you don't maintain an export list by hand. What that automation *cannot* do is
resolve a symbol nothing in the main module references — see "Symbols across the
core/side-module boundary" in [adding-modules.md](adding-modules.md#symbols-across-the-coreside-module-boundary)
for the two cases that need a manual edge.

For a fast out-of-tree module compile loop:

```bash
cmake --build runner/build --target side_modules
```

Once it compiles, do the full runner relink, rebuild the editor, and run the
headless smoke test.

## Version reporting

**Help ▸ Software Versions** lists every piece of software in the stack, and not
one of those numbers is written by hand.
[`editor/gen/gen_versions.mjs`](../editor/gen/gen_versions.mjs) reads them back out
of the file that pins each one — `deps/fetch-deps.sh` for the C++ dependencies,
`deps/env.sh` for Emscripten, `build.yml` for Qt, `deps/fetch-pyodide.sh` for the
Python runtime, `.gitmodules` plus the gitlinks for GNU Radio and the OOTs,
`gnuradio/CMakeLists.txt` for GNU Radio's own version, and
`editor/package-lock.json` for the web packages — and `vite.config.ts` serves the
result as the `virtual:versions` module, so dev and build both report the tree
they are running out of and nothing is checked in to go stale.

Two consequences. A new dependency needs **no** edit to the dialog as long as it
is pinned in one of the forms already used (`clone`, `clone_commit`, `fetch_tar`,
a submodule, a locked npm package); it appears on its own. And *reword* a pin
file and its table silently empties rather than anything failing — collection is
best-effort by design, so a missing submodule checkout or a tree with no git
history degrades to "unknown" instead of breaking the build. `node
editor/gen/gen_versions.mjs` prints the manifest, which is how to check a table
is still being filled.

## Host-only dependencies

UHD, Boost.Asio networking, Boost.Locale, and libsndfile need an Emscripten
guard, a browser-safe replacement, or exclusion of the affected block. See
[adding-modules.md](adding-modules.md) for the standard fixes.
