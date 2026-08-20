// Phase-1 spike, second leg: the same questions, but inside the REAL runner --
// Qt on the browser main thread, a genuine GR scheduler thread calling work(),
// -O0, INITIAL_MEMORY=256 MB, and dlopen'd side modules present in the process.
//
// Throwaway. Wired in temporarily by:
//   registry.cpp        #include "../../tools/js-block-spike/runner_probe.hpp"
//                       {"js_spike_probe", js_spike_probe_factory},
//   runner/CMakeLists   --pre-js ${WORLD}/tools/js-block-spike/js_runtime_spike.js
// Both edits are reverted once the spike has answered.
#pragma once
#include <emscripten.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sync_block.h>

#include <cstdio>
#include <string>

class js_spike_probe : public gr::sync_block
{
public:
    js_spike_probe(double gain)
        : gr::sync_block("js_spike_probe",
                         gr::io_signature::make(1, 1, sizeof(gr_complex)),
                         gr::io_signature::make(1, 1, sizeof(gr_complex))),
          d_gain(gain)
    {
    }

    void set_gain(double g)
    {
        d_gain = g;
        if (d_ready) EM_ASM({ __grJsSpike.setParam($0, $1, $2); }, 1, "gain", g);
    }

    int work(int n, gr_vector_const_void_star& in, gr_vector_void_star& out) override
    {
        if (!d_ready) {
            // Is a plain EM_ASM body executing on THIS GR scheduler thread?
            d_on_pthread = EM_ASM_INT({ return ENVIRONMENT_IS_PTHREAD ? 1 : 0; });
            d_main_proxied = MAIN_THREAD_EM_ASM_INT({ return ENVIRONMENT_IS_PTHREAD ? 1 : 0; });
            // Did --pre-js reach this worker's realm, through Qt's MODULARIZE
            // wrapper and its regenerated runner.html?
            d_pre_js = EM_ASM_INT({ return globalThis.__grJsSpikePreJsRan ? 1 : 0; });

            static const char* kSrc = R"JS(
gr.export({
  label: 'JS Gain', inputs: ['complex'], outputs: ['complex'],
  params: { gain: 1.0 },
  start() { this.count = 0; },
  work(nout, input, output) {
    const x = input[0], y = output[0], g = this.gain;
    for (let i = 0; i < nout * 2; i++) y[i] = x[i] * g;
    this.count += nout;
    return nout;
  },
});
)JS";
            char err[1024] = { 0 };
            d_compiled = EM_ASM_INT({ return __grJsSpike.compile($0, $1, $2, $3); },
                                    1, kSrc, err, (int)sizeof(err)) == 0;
            if (!d_compiled) printf("JS_SPIKE compile failed: %s\n", err);
            EM_ASM({ __grJsSpike.setParam($0, $1, $2); }, 1, "gain", d_gain);
            d_ready = true;
            d_t0 = emscripten_get_now();
        }
        if (!d_compiled) return n;

        char err[1024] = { 0 };
        const int produced = EM_ASM_INT({ return __grJsSpike.work($0, $1, $2, $3, $4, $5); },
                                        1, n, in[0], out[0], err, (int)sizeof(err));
        if (produced < 0) throw std::runtime_error(err[0] ? err : "JS work() failed");

        // Verify a sample the JS side wrote, straight out of GR's own buffer.
        const gr_complex* x = static_cast<const gr_complex*>(in[0]);
        const gr_complex* y = static_cast<const gr_complex*>(out[0]);
        if (n > 0 && std::abs(y[0].real() - x[0].real() * float(d_gain)) > 1e-4f) d_wrong++;

        d_items += produced;
        if (++d_calls == 2000) {
            const double ms = emscripten_get_now() - d_t0;
            printf("JS_SPIKE pthread=%d main_proxied=%d pre_js=%d compiled=%d "
                   "calls=%d items=%lld wrong=%d %.0f ns/call (%.1f ns/item) %s\n",
                   d_on_pthread, d_main_proxied, d_pre_js, (int)d_compiled, d_calls,
                   (long long)d_items, d_wrong, ms * 1e6 / d_calls,
                   ms * 1e6 / double(d_items),
                   (d_on_pthread == 1 && d_main_proxied == 0 && d_pre_js == 1 &&
                    d_compiled && d_wrong == 0)
                       ? "JS_SPIKE_RUNNER_PASS"
                       : "JS_SPIKE_RUNNER_FAIL");
            fflush(stdout);
        }
        return produced;
    }

private:
    double d_gain;
    bool d_ready = false, d_compiled = false;
    int d_on_pthread = -1, d_main_proxied = -1, d_pre_js = -1;
    int d_calls = 0, d_wrong = 0;
    long long d_items = 0;
    double d_t0 = 0;
};

inline BuiltBlock js_spike_probe_factory(const nlohmann::json& p)
{
    const double gain = number_from(p, "gain", 1.0);
    auto blk = std::make_shared<js_spike_probe>(gain);
    BuiltBlock b;
    b.block = blk;
    b.numeric_setters["gain"] = [blk](double v) { blk->set_gain(v); };
    return b;
}
