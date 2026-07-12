// Phase 2: exercise the GNU Radio thread-per-block scheduler in WASM with a
// minimal hand-written flowgraph (custom source -> custom sink), no gr-blocks yet.
// Verifies the scheduler runs blocks on Emscripten pthreads and produces the
// correct numeric result, then reports PASS/FAIL into the DOM.
#include <gnuradio/top_block.h>
#include <gnuradio/sync_block.h>
#include <gnuradio/io_signature.h>
#include <emscripten.h>
#include <memory>
#include <algorithm>
#include <cstdio>
#include <cmath>

// Source: emits 0,1,2,...,N-1 as floats, then signals end-of-stream.
class counter_source : public gr::sync_block {
public:
    counter_source(int n)
        : gr::sync_block("counter_source",
                         gr::io_signature::make(0, 0, 0),
                         gr::io_signature::make(1, 1, sizeof(float))),
          d_n(n), d_produced(0) {}
    int work(int noutput_items,
             gr_vector_const_void_star&,
             gr_vector_void_star& output_items) override {
        int remaining = d_n - d_produced;
        if (remaining <= 0) return gr::block::WORK_DONE;
        int n = std::min(noutput_items, remaining);
        float* out = static_cast<float*>(output_items[0]);
        for (int i = 0; i < n; ++i) out[i] = static_cast<float>(d_produced + i);
        d_produced += n;
        return n;
    }
private:
    int d_n, d_produced;
};

// Sink: accumulates the running sum and item count of its float input.
class accum_sink : public gr::sync_block {
public:
    accum_sink()
        : gr::sync_block("accum_sink",
                         gr::io_signature::make(1, 1, sizeof(float)),
                         gr::io_signature::make(0, 0, 0)),
          d_sum(0.0), d_count(0) {}
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star&) override {
        const float* in = static_cast<const float*>(input_items[0]);
        for (int i = 0; i < noutput_items; ++i) d_sum += in[i];
        d_count += noutput_items;
        return noutput_items;
    }
    double sum() const { return d_sum; }
    long count() const { return d_count; }
private:
    double d_sum;
    long d_count;
};

static void stage(const char* s) {
    // printf only (async via Module.print in the shell) — avoids MAIN_THREAD_EM_ASM
    // blocking the proxied worker on the browser main thread.
    std::printf("STAGE: %s\n", s);
    std::fflush(stdout);
}

int main() {
    const int N = 1000000;
    try {
        stage("start");
        auto src = std::make_shared<counter_source>(N);
        stage("made-src");
        auto snk = std::make_shared<accum_sink>();
        stage("made-snk");
        auto tb  = gr::make_top_block("phase2");
        stage("made-topblock");
        tb->connect(src, 0, snk, 0);
        stage("connect");
        stage("run-begin");
        tb->run();  // blocks until WORK_DONE propagates; uses the TPB scheduler (pthreads)
        stage("run-end");

        const double expected = (double)N * (N - 1) / 2.0;  // sum 0..N-1
        const double got = snk->sum();
        const long count = snk->count();
        const bool ok = (count == N) && (std::fabs(got - expected) < 1.0);

        std::printf("phase2: count=%ld sum=%.1f expected=%.1f ok=%d\n", count, got, expected, ok);
        // main() runs on a proxied pthread (-sPROXY_TO_PTHREAD) so it can block on
        // run(); DOM access must be marshalled to the browser main thread.
        MAIN_THREAD_EM_ASM({
            var d = document.getElementById('result');
            if (!d) { d = document.createElement('div'); d.id = 'result'; document.body.appendChild(d); }
            d.setAttribute('data-status', $0 ? 'pass' : 'fail');
            d.textContent = (($0 ? 'RESULT: PHASE2_PASS ' : 'RESULT: PHASE2_FAIL ')
                + 'count=' + $1 + ' sum=' + $2 + ' expected=' + $3);
        }, ok ? 1 : 0, (double)count, got, expected);
        return ok ? 0 : 1;
    } catch (const std::exception& e) {
        std::printf("phase2 EXCEPTION: %s\n", e.what());
        MAIN_THREAD_EM_ASM({
            var d = document.getElementById('result') || document.body.appendChild(
                Object.assign(document.createElement('div'), {id:'result'}));
            d.textContent = 'RESULT: PHASE2_FAIL exception: ' + UTF8ToString($0);
        }, e.what());
        return 1;
    } catch (...) {
        MAIN_THREAD_EM_ASM({
            var d = document.getElementById('result') || document.body.appendChild(
                Object.assign(document.createElement('div'), {id:'result'}));
            d.textContent = 'RESULT: PHASE2_FAIL non-std-exception';
        });
        return 1;
    }
}
