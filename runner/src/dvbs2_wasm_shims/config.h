#pragma once

// gr-dvbs2's own CMake generates this header into its build tree; the impl
// sources include it but use none of its macros (the real DVB-S2 constants ship
// in include/dvbs2/dvbs2_config.h). The browser side module compiles those
// sources directly, with no gr-dvbs2 configure step, so an empty header is
// enough. Kept here rather than in the submodule so that fork carries nothing
// but its one WASM buffer-wrap fix -- see runner/oot_cpp_templates/gr-dvbs2.yml
// for the same reasoning applied to its block metadata.
