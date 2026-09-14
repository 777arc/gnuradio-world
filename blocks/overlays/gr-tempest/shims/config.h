#pragma once

// gr-tempest's own CMake generates this header into its build tree; the impl sources
// include it but use none of its macros. The browser side module compiles those
// sources directly, with no gr-tempest configure step, so an empty header is enough.
// Kept here rather than in the submodule so gr-tempest stays pinned to pristine
// upstream -- see ../metadata.yml for the same reasoning
// applied to its block metadata.
