// Phase 3: real gr-blocks DSP running in WASM. vector_source -> multiply_const
// -> vector_sink, then verify the sink output numerically. Proves the gr-blocks
// (and, via linkage, gr-fft/FFTW) WASM build works end to end.
#include <gnuradio/top_block.h>
#include <gnuradio/blocks/vector_source.h>
#include <gnuradio/blocks/vector_sink.h>
#include <gnuradio/blocks/multiply_const.h>
#include <emscripten.h>
#include <memory>
#include <vector>
#include <cmath>
#include <cstdio>

int main() {
    const int N = 4096;
    const float K = 2.5f;
    try {
        std::vector<float> in(N);
        for (int i = 0; i < N; ++i) in[i] = static_cast<float>(i);

        auto tb  = gr::make_top_block("phase3");
        auto src = gr::blocks::vector_source_f::make(in, /*repeat=*/false);
        auto mul = gr::blocks::multiply_const_ff::make(K);
        auto snk = gr::blocks::vector_sink_f::make();
        tb->connect(src, 0, mul, 0);
        tb->connect(mul, 0, snk, 0);
        tb->run();

        std::vector<float> out = snk->data();
        bool ok = (out.size() == static_cast<size_t>(N));
        double max_err = 0.0;
        for (size_t i = 0; ok && i < out.size(); ++i)
            max_err = std::max(max_err, (double)std::fabs(out[i] - K * in[i]));
        ok = ok && (max_err < 1e-3);

        std::printf("phase3: n=%zu max_err=%g ok=%d\n", out.size(), max_err, ok);
        MAIN_THREAD_EM_ASM({
            var d = document.getElementById('result');
            if (!d) { d = document.createElement('div'); d.id='result'; document.body.appendChild(d); }
            d.setAttribute('data-status', $0 ? 'pass' : 'fail');
            d.textContent = (($0 ? 'RESULT: PHASE3_PASS ' : 'RESULT: PHASE3_FAIL ')
                + 'n=' + $1 + ' max_err=' + $2);
        }, ok ? 1 : 0, (double)out.size(), max_err);
        return ok ? 0 : 1;
    } catch (const std::exception& e) {
        std::printf("phase3 EXCEPTION: %s\n", e.what());
        MAIN_THREAD_EM_ASM({
            var d = document.getElementById('result') || document.body.appendChild(
                Object.assign(document.createElement('div'), {id:'result'}));
            d.setAttribute('data-status','fail');
            d.textContent = 'RESULT: PHASE3_FAIL exception: ' + UTF8ToString($0);
        }, e.what());
        return 1;
    }
}
