// Shim over gr-hrpt's own viterbi_lib/viterbi.h. Its declarations have no
// extern "C" linkage, but viterbi_lib/*.c is compiled with emcc (C) while
// viterbi_{metop,fengyun}_decoder_impl.cc include this header under em++
// (C++), which name-mangles the declarations and breaks the dlopen link
// against the C-compiled objects ("bad export type for 'gen_met'"). Wrapping
// the real header keeps the submodule pristine -- this directory is listed
// ahead of gr-hrpt/lib on the include path (see runner/CMakeLists.txt), and
// viterbi_lib/*.c itself reaches the real header via a quote-include that
// resolves to its own directory first, so it is unaffected.
#ifdef __cplusplus
extern "C" {
#endif
#include_next <viterbi_lib/viterbi.h>
#ifdef __cplusplus
}
#endif
