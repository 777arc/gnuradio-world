<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="editor/public/gnuradio_world_logo_dark.svg">
    <img src="editor/public/gnuradio_world_logo.svg" alt="GNU Radio World" width="700">
  </picture>
</p>

<p align="center">
  <strong>🔍 <a href="https://gnuradioworld.com">Try it now at gnuradioworld.com</a> 🔍</strong>
</p>

GNU Radio, entirely in your browser — explore the open-source SDR ecosystem with zero install!

- Includes popular out-of-tree modules (OOTs)
- Many example flowgraphs
- Example IQ recordings of signals to test them with
- On-demand fetching of WebAssembly modules and IQ recordings, to keep the load time short
- Identical .grc flowgraph files as the native version
- Share flowgraphs you create entirely via URL
- Submit your own example flowgraphs and recordings
- QT GUI Hints are replaced with a web-style live window arrangement, using a live miniature in the canvas

## Limitations

- No Python runtime in the browser at the moment, Python-only blocks and hier blocks need a C++ implementation
- Parameter expressions support a Python subset (arithmetic, lists, `math`/`numpy`, and common `firdes` filter designers) but not any arbitrary Python

## Coming Soon

- Support for some hardware/SDRs
- A beginner tutorial with an animated cursor that demonstrates adding blocks and running a flowgraph
- An embeddable flowgraph and GUI view for interactive DSP examples, with a link to open the full editor in a new tab

## How to add a feature or fix a bug entirely from the browser

Create a [new Issue](https://github.com/777arc/gnuradio-world/issues/new) in GitHub, describe what you want to change or fix, if it's a bug then point out how to reproduce it, or which example flowgraph can be used to reproduce it.  Then click "Assign to Agent", and once it's done the agent will create a PR, and it will automatically build a live version of the site under a different URL, which will be provided as a comment in the PR once it's live (~8m).  You can then test out the change and make a note in the PR that it looks good.

## Developer Quickstart

Everything below is the minimum needed on a fresh Ubuntu 24.04 or 26.04 install
to build the whole stack from source and open it in a browser. Nothing is
prebuilt and nothing is downloaded at run time, so the first build takes up to
an hour (the dependency sysroot and GNU Radio dominate); rebuilds
after an edit are almost instant in most casesa. Expect ~10 GB of disk usage.

**1. System packages** (the only step needing `sudo`):

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build git curl \
  python3 python3-venv python3-mako python3-yaml python3-packaging \
  pipx autoconf m4 bzip2 xz-utils

# Node >= 20 is required. Ubuntu 24.04 ships 18, so install 20 from NodeSource;
# on 26.04 `apt-get install -y nodejs npm` is enough. Check with `node --version`.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**2. Toolchains** — Emscripten 3.1.70 and Qt 6.9.1 (host tools + threaded
WebAssembly). The versions are pinned together: Qt 6.9 for WebAssembly is built
with emsdk 3.1.70, and mixing versions breaks the ABI.

```bash
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install 3.1.70 && ~/emsdk/emsdk activate 3.1.70

# ~/.local/bin/aqt spelled out so this works without reopening the shell
pipx install aqtinstall
~/.local/bin/aqt install-qt linux desktop 6.9.1 linux_gcc_64      -O ~/Qt
~/.local/bin/aqt install-qt all_os wasm    6.9.1 wasm_multithread -O ~/Qt
```

**3. Clone the repository**, with the GNU Radio and OOT submodules:

```bash
git clone --recurse-submodules https://github.com/777arc/gnuradio-world.git
cd gnuradio-world
```

**4. Set up the environment.** Re-run this in every new shell you build from:

```bash
source deps/env.sh                     # activates emsdk, exports $SYSROOT
export GR="$PWD/gnuradio"
export QT_HOST=~/Qt/6.9.1/gcc_64
export QT_WASM=~/Qt/6.9.1/wasm_multithread
```

**5. Build everything.** Each command is idempotent, so re-running after a
failure is cheap:

```bash
# Cross-build the C++ dependencies (VOLK, Boost, spdlog, GMP, FFTW, Qwt) -> sysroot/
bash deps/fetch-deps.sh
bash deps/build-deps.sh

# GNU Radio's C++ modules: no Python, static, exceptions on, everything -fPIC
emcmake cmake -S "$GR" -B gr/build-gr -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="-pthread -fPIC -fexceptions" -DCMAKE_C_FLAGS="-pthread -fPIC" \
  -DCMAKE_INSTALL_PREFIX="$SYSROOT" -DCMAKE_PREFIX_PATH="$SYSROOT" \
  -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
  -DENABLE_DEFAULT=OFF -DENABLE_PYTHON=OFF -DENABLE_GR_QTGUI=OFF -DENABLE_GR_AUDIO=OFF \
  -DENABLE_GNURADIO_RUNTIME=ON \
  -DENABLE_GR_ANALOG=ON -DENABLE_GR_BLOCKS=ON -DENABLE_GR_DIGITAL=ON \
  -DENABLE_GR_FFT=ON -DENABLE_GR_FILTER=ON -DENABLE_GR_FEC=ON -DENABLE_GR_DTV=ON \
  -DENABLE_GR_NETWORK=ON -DENABLE_GR_PDU=ON -DENABLE_GR_VOCODER=ON \
  -DENABLE_GR_CHANNELS=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_libunwind=ON
cmake --build gr/build-gr

# Generate the runtime block factories and the matching editor palette
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json

# The gr-qtgui sinks against Qt 6, the WASM runner, then the editor
(cd qtgui  && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST" -DCMAKE_CXX_FLAGS="-pthread -fPIC" && cmake --build build)
(cd runner && "$QT_WASM/bin/qt-cmake" -S . -B build -GNinja -DQT_HOST_PATH="$QT_HOST" -DCMAKE_BUILD_TYPE=Release && cmake --build build)
(cd editor && npm install && npm run build)
```

**6. Run it.** The app needs `SharedArrayBuffer` for GNU Radio's thread-per-block
scheduler, which requires the COOP/COEP headers the repository's dev server
sets — opening `editor/dist/index.html` as a `file://` URL will not work:

```bash
node server.mjs 8090 "$PWD"
```

Then open **<http://localhost:8090/>** in Chrome or Firefox, pick an example from
the *Example Flowgraphs* tab (or drag blocks onto the canvas), and press ▶ Run.
Use port 8090 specifically: it is the origin allowed by the recordings bucket's
CORS policy, so the Recordings palette and GR World Recording's range reads only
work there.

To confirm the build is actually healthy rather than merely linked:

```bash
npm install                          # headless-Chromium test harness deps
npx @puppeteer/browsers install chrome-headless-shell@stable --path "$PWD"
npm test                             # runs flowgraphs and asserts samples move
```

Troubleshooting: if the Qt host tools fail to start, install their one shared
library (`sudo apt-get install -y libglib2.0-0t64`, or `libglib2.0-0` on older
releases) — a minimal install may not have it.

## Software stack and developers info

See [AGENTS.md](AGENTS.md)

### How out-of-tree modules are integrated

Each OOT module is vendored as a git submodule and compiled into its own
WebAssembly side module, fetched on demand the first time a flowgraph uses one of
its blocks. The guiding rule is that **everything the browser build needs lives in
this repository, not in the submodule**, so each one stays pinned to a pristine
upstream commit and bumping it is a plain `fetch` + `checkout` with nothing to
rebase. Only a genuine source-level fix justifies a fork, and those fixes should
eventually be merged upstream.

When adding a new OOT to GNU Radio World there are steps to take, and some tweaks to make, they all fall into one of the following buckets:

| bucket | what it is | where it lives |
|---|---|---|
| **Block metadata** | The `cpp_templates` the factory generator renders into C++, plus anything else the browser needs changed about a block: retyped parameters, a recategorised palette entry, or enum options the vendored C++ doesn't define | `blocks/overlays/gr-<m>/metadata.yml` — one directory per module |
| **Missing headers and host-only deps** | The `config.h` the module's own CMake would have generated, and browser-safe replacements for anything absent from the WASM sysroot (host networking, locale conversion, audio file I/O) | `blocks/overlays/gr-<m>/shims/` |
| **Blocks with no C++ upstream** | Python `gr.hier_block2` compositions, Python QWidget GUI panels, and Python-only utility blocks, rebuilt by hand as C++ so the browser gets the same block id | `blocks/overlays/gr-<m>/`, beside that module's metadata; the factory that constructs them is registered in `runner/src/registry.cpp` |
| **Registration** | Whether the module is core or fetched on demand, plus any load-order dependency on another side module | `runner/modules.json` |
| **Build wiring** | The module's include directory and the side-module rule listing which of its sources to compile | `runner/CMakeLists.txt` |
| **Deliberate omissions** | Blocks that cannot work in a browser sandbox at all — host networking, hardware I/O — get no entry anywhere and simply compile out. They stay visible but greyed out in the palette | *(nothing to write)* |

Two generators read the metadata file — one emits the runtime C++ factories, the
other the editor palette — through a shared merge in `tools/block_overrides.py`,
so a block's runtime behaviour and the palette entry describing it cannot drift
apart. A typo'd or misfiled block id is rejected rather than silently ignored.

The step-by-step checklist, including the standard fixes for the handful of ways
a block can fail to generate, is in
[docs/adding-modules.md](docs/adding-modules.md).

## Example Recordings Management

Example recordings are discovered and streamed directly from the Cloudflare R2
bucket `gnuradio-wasm-recordings`, publicly served at
`https://recordings.gnuradioworld.com`. Adding a matching
`.sigmf-data`/`.sigmf-meta` pair makes it available after one-minute, thanks to the sigmf-indexer worker, no repository change or site deployment is needed.

## License

GNU Radio World is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

The vendored submodules carry their own copyright holders and licenses, as do
the third-party dependencies built into `sysroot/`.

Copyright (C) 2026 Marc Lichtman
