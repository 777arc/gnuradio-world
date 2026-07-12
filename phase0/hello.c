#include <stdio.h>
#include <math.h>
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE
double gr_wasm_selftest(void) {
    // trivial "DSP-ish" computation so the result is non-constant-folded away
    double acc = 0.0;
    for (int i = 0; i < 1024; i++) acc += sin(2.0 * M_PI * i / 1024.0) * cos(i);
    return acc;
}

int main(void) {
    printf("PHASE0_OK gnuradio-wasm hello: selftest=%.6f\n", gr_wasm_selftest());
    return 0;
}
