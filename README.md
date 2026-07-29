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

- SDR hardware support coming soon! We want to make sure to get it right the first time
- No Python blocks, they can be converted to C++ with AI
- Heir blocks need the C++ template
- Expressions are supported for block params, but it's a subset of the arbitrary Python native GNU Radio allows, e.g. no firdes(), but simple Python expressions work.

## Software stack and developers info

See [AGENTS.md](AGENTS.md)

Example recordings are currently stored in a Cloudflare R2 bucket, but that may change in the future.

## License

GNU Radio World is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

The vendored submodules carry their own copyright holders and licenses, as do
the third-party dependencies built into `sysroot/`.

Copyright (C) 2026 Marc Lichtman
