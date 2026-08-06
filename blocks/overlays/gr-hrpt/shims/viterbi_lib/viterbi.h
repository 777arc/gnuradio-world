// Shim over gr-hrpt's own viterbi_lib/viterbi.h. Its declarations have no
// extern "C" linkage, but viterbi_lib/*.c is compiled with emcc (C) while
// viterbi_{metop,fengyun}_decoder_impl.cc include this header under em++
// (C++), which name-mangles the declarations and breaks the dlopen link
// against the C-compiled objects ("bad export type for 'gen_met'"). Wrapping
// the real header keeps the submodule pristine -- this directory is listed
// ahead of gr-hrpt/lib on the include path (see runner/CMakeLists.txt), and
// viterbi_lib/*.c itself reaches the real header via a quote-include that
// resolves to its own directory first, so it is unaffected.
//
// The real header also mis-declares gen_met() as returning int, but
// metrics.c defines it returning void (and no caller uses a return value --
// this is silently-tolerated UB on native ABIs). Under Emscripten's PIC side
// modules, a caller and definee that disagree on a function's wasm type
// leave the GOT relocation pointing at an unfilled table slot, so the first
// call throws "getWasmTableEntry(...) is not a function" instead of running.
// Swap out just that one declaration for one matching the real definition.
#ifdef __cplusplus
extern "C" {
#endif
#define gen_met gr_hrpt_shim_unused_gen_met_decl
#include_next <viterbi_lib/viterbi.h>
#undef gen_met
void gen_met(int mettab[2][256], int amp, double esn0, double bias, int scale);
#ifdef __cplusplus
}
#endif
