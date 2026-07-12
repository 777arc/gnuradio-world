#!/usr/bin/env python3
"""Generate a C++ flowgraph project from a .grc file using this repo's GRC
(with the cpp_* workflows). Host-side only — emits C++/CMake that we then
cross-compile to WASM. Usage: generate_cpp.py <flowgraph.grc> <output_dir>"""
import sys
import os
import logging

REPO = "/home/marc/gnuradio"
sys.path.insert(0, REPO)  # use this repo's `grc` package (has cpp workflows)

# The system `gnuradio` apt package is intentionally NOT installed (it would
# conflict with this repo's 3.11 grc). We only needed it for gr.prefix(), so
# provide a stub `gnuradio` package pointing at this repo, and alias the 3.11
# workflows into `gnuradio.grc.workflows.*` (how the generator imports them).
import types
try:
    from gnuradio import gr  # use real host gnuradio if present
    _prefix = gr.prefix()
except Exception:
    _prefix = "/usr/local"
    _gnuradio = types.ModuleType("gnuradio")
    _gnuradio.__path__ = []  # namespace-like
    sys.modules.setdefault("gnuradio", _gnuradio)

import grc as _grc
import grc.workflows as _grc_workflows
sys.modules["gnuradio.grc"] = _grc
sys.modules["gnuradio.grc.workflows"] = _grc_workflows

from grc.core.platform import Platform

logging.basicConfig(level=logging.WARNING)


def main(grc_file, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    block_paths = [
        os.path.join(REPO, "grc/blocks"),
        os.path.join(REPO, "gr-blocks/grc"),
        os.path.join(REPO, "gr-fft/grc"),
        os.path.join(REPO, "gr-analog/grc"),
    ]
    platform = Platform(
        name="GRC WASM codegen",
        prefs=None,
        version="0.0.0",
        install_prefix=_prefix,
    )
    platform.build_library(block_paths)

    fg = platform.make_flow_graph(grc_file)
    fg.rewrite()
    fg.validate()
    if not fg.is_valid():
        print("INVALID:", fg.get_error_messages())
        return 2

    gen = platform.Generator(fg, out_dir)
    gen.write()
    print("GENERATED into", out_dir)
    for f in sorted(os.listdir(out_dir)):
        print("  ", f)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
