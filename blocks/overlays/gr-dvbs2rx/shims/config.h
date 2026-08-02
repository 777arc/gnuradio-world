#pragma once

// gr-dvbs2rx's own CMake generates this header into its build tree; the impl
// sources include it but use none of its macros (the real DVB constants ship in
// include/dvbs2rx/dvb_config.h). The browser side module compiles those sources
// directly, with no gr-dvbs2rx configure step, so an empty header is enough.
// Kept here rather than in the submodule so gr-dvbs2rx stays pinned to pristine
// upstream -- see ../metadata.yml for the same reasoning
// applied to its block metadata.
