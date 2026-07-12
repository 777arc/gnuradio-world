// Isolate the multi-source hang: two finite vector sources -> add -> vector_sink.
// No Qt, runs under node. If tb->run() hangs, the fan-in scheduler/buffer path is
// the culprit; if it completes and sums correctly, the browser hang is elsewhere.
#include <gnuradio/top_block.h>
#include <gnuradio/blocks/vector_source.h>
#include <gnuradio/blocks/vector_sink.h>
#include <gnuradio/blocks/add_blk.h>
#include <cstdio>
#include <vector>
#include <complex>

int main() {
    const int N = 2048;
    std::vector<gr_complex> a(N), b(N);
    for (int i = 0; i < N; ++i) { a[i] = gr_complex(i, 0); b[i] = gr_complex(0, i); }

    std::printf("STAGE build\n"); std::fflush(stdout);
    auto tb = gr::make_top_block("msrc");
    auto s1 = gr::blocks::vector_source_c::make(a, false);
    auto s2 = gr::blocks::vector_source_c::make(b, false);
    auto add = gr::blocks::add_cc::make(1);
    auto snk = gr::blocks::vector_sink_c::make();
    tb->connect(s1, 0, add, 0);
    tb->connect(s2, 0, add, 1);
    tb->connect(add, 0, snk, 0);

    std::printf("STAGE run\n"); std::fflush(stdout);
    tb->run();
    std::printf("STAGE done\n"); std::fflush(stdout);

    auto out = snk->data();
    bool ok = (out.size() == (size_t)N);
    double err = 0;
    for (size_t i = 0; ok && i < out.size(); ++i)
        err += std::abs(out[i] - (a[i] + b[i]));
    std::printf("RESULT n=%zu err=%g ok=%d\n", out.size(), err, ok && err < 1e-6);
    return 0;
}
