/* Emscripten has the wordexp.h declarations but no implementation, and UHD's
 * uhd::path_expandvars() is the only caller. It already falls back to the
 * unexpanded path when wordexp() reports an error, so failing here is both the
 * smallest shim and the correct behaviour: there is no shell in a browser tab,
 * and UHD's image/config paths are absolute MEMFS paths that need no expansion.
 */
#include <wordexp.h>

int wordexp(const char* words, wordexp_t* pwordexp, int flags) {
    (void)words; (void)flags;
    if (pwordexp) { pwordexp->we_wordc = 0; pwordexp->we_wordv = 0; pwordexp->we_offs = 0; }
    return WRDE_NOSPACE;
}

void wordfree(wordexp_t* pwordexp) { (void)pwordexp; }
