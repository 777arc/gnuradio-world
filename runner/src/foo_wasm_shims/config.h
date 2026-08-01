#pragma once

// gr-foo's own CMake generates this header into its build tree; the impl sources
// include it but use none of its macros. The browser side module compiles those
// sources directly, with no gr-foo configure step, so an empty header is enough.
// Kept here rather than in the submodule so gr-foo stays pinned to pristine
// upstream -- see runner/oot_cpp_templates/gr-foo.yml for the same reasoning
// applied to its block metadata.
