<p align="center">
  <img src="editor/public/gnuradio_world_logo.svg" alt="GNU Radio World" width="700">
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

## Limitations

- Browser sandboxing means native SDR hardware and host-only network/audio devices are unavailable.
- There is no Python runtime in the browser. Python-only blocks and hierarchies need a C++ implementation.
- Parameter expressions support a practical Python subset—arithmetic, lists,
  `math`/`numpy`, and common `firdes` filter designers—but not arbitrary Python.

## Coming Soon

- A beginner tutorial with an animated cursor that demonstrates adding blocks
  and running a flowgraph.
- An embeddable flowgraph and GUI view for interactive DSP examples, with a link
  to open the full editor in a new tab.

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
a block can fail to generate, is in [AGENTS.md](AGENTS.md).

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
