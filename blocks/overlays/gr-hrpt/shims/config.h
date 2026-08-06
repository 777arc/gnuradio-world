#pragma once

// gr-hrpt's own CMake generates this header into its build tree; every impl
// source includes it unconditionally (not behind HAVE_CONFIG_H) but uses none
// of its macros. The browser side module compiles those sources directly, with
// no gr-hrpt configure step, so an empty header is enough -- same reasoning as
// gr-rds/gr-dvbs2's shims.
