#pragma once

// gr-gsm's portable_endian copy recognizes host operating systems but predates
// __EMSCRIPTEN__. Emscripten supplies the standard little-endian conversions.
#include <endian.h>
