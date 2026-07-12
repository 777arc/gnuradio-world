// Reproduce the browser's multi-source topology under node: two INFINITE sources
// (sig_source + noise_source) -> add -> head(N) -> null_sink. head terminates it.
#include <gnuradio/top_block.h>
#include <gnuradio/analog/sig_source.h>
#include <gnuradio/analog/noise_source.h>
#include <gnuradio/blocks/add_blk.h>
#include <gnuradio/blocks/head.h>
#include <gnuradio/blocks/null_sink.h>
#include <cstdio>

int main() {
    const double fs = 32000;
    std::printf("STAGE build\n"); std::fflush(stdout);
    auto tb = gr::make_top_block("msrc2");
    auto src = gr::analog::sig_source_c::make(fs, gr::analog::GR_COS_WAVE, 1500, 1.0);
    auto noise = gr::analog::noise_source_c::make(gr::analog::GR_GAUSSIAN, 0.25, 42);
    auto add = gr::blocks::add_cc::make(1);
    auto head = gr::blocks::head::make(sizeof(gr_complex), 200000);
    auto snk = gr::blocks::null_sink::make(sizeof(gr_complex));
    tb->connect(src, 0, add, 0);
    tb->connect(noise, 0, add, 1);
    tb->connect(add, 0, head, 0);
    tb->connect(head, 0, snk, 0);

    std::printf("STAGE run\n"); std::fflush(stdout);
    tb->run();
    std::printf("STAGE done — infinite-source fan-in works\n"); std::fflush(stdout);
    return 0;
}
