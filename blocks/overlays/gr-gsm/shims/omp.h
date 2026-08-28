#pragma once

// Emscripten does not provide OpenMP. The pragmas are ignored by Clang; these
// setup calls make gr-gsm's receiver use that same serial execution path.
inline void omp_set_dynamic(int) {}
inline void omp_set_num_threads(int) {}
