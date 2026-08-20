// Phase-1 spike for JAVASCRIPT_BLOCKS_PLAN2.md: does a JS block's work() really
// work when it runs from an Emscripten pthread, inside a MAIN_MODULE=2 build,
// with ALLOW_MEMORY_GROWTH and a shared heap?
//
// Throwaway. It answers the questions and gets deleted, per the plan's phase 1.
//
//   1. Does a plain EM_ASM body execute on the CALLING pthread, or is it
//      proxied to the browser main thread?
//   2. Does --pre-js code exist in an em-pthread worker's realm at all?
//   3. Does `new Function` work there (fact 3: no CSP in site/_headers)?
//   4. Do GROWABLE_HEAP_* views give zero-copy access to GR-style buffers,
//      and what exactly does memory growth do to a cached view on a SHARED
//      heap? (The plan asserts a rule; this measures the real behaviour.)
//   5. Does a JS exception surface as a catchable C++ std::runtime_error?
//   6. Do several JS work() bodies actually run CONCURRENTLY on their own
//      scheduler threads?
//   7. What does one EM_ASM crossing cost per work() call?
//
// Build: tools/js-block-spike/build.sh    Run: node/browser, see README.md
#include <emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/threading.h>
#include <pthread.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

// NOTE the EM_ASM comma caveat that runner.cpp documents: the preprocessor
// splits macro arguments on commas that are not inside PARENTHESES (braces do
// not protect). Every body below keeps its commas inside a call's parens.

namespace {

struct Check {
    std::string name;
    bool ok;
    std::string note;
};

std::mutex g_mu;
std::vector<Check> g_checks;

void check(const char* name, bool ok, const std::string& note = "")
{
    std::lock_guard<std::mutex> lk(g_mu);
    g_checks.push_back({ name, ok, note });
}

constexpr int kErrCap = 1024;

// Keeps the growth probe's allocations observable so -O2 cannot elide them.
volatile char* g_sink = nullptr;

// The gain block from the plan's authoring-contract example, verbatim.
const char* kGainSource = R"JS(
gr.export({
  label:   'JS Gain',
  inputs:  ['complex'],
  outputs: ['complex'],
  params:  { gain: 1.0 },
  start() { this.count = 0; },
  work(nout, input, output) {
    const x = input[0], y = output[0], g = this.gain;
    for (let i = 0; i < nout * 2; i++) y[i] = x[i] * g;
    this.count += nout;
    return nout;
  },
});
)JS";

const char* kThrowingSource = R"JS(
gr.export({
  inputs: ['float'], outputs: ['float'],
  work(nout, input, output) { throw new Error('boom from JS work()'); },
});
)JS";

// ---------------------------------------------------------------------------
// The C++ half of the crossing, i.e. what js_block.hpp would contain.
// ---------------------------------------------------------------------------

int js_compile(int handle, const char* src, char* err)
{
    return EM_ASM_INT({ return __grJsSpike.compile($0, $1, $2, $3); },
                      handle, src, err, kErrCap);
}

int js_work(int handle, int nout, const float* in, float* out, char* err)
{
    return EM_ASM_INT({ return __grJsSpike.work($0, $1, $2, $3, $4, $5); },
                      handle, nout, in, out, err, kErrCap);
}

// What general_work() would do with the result: never let a JS exception unwind
// through a wasm frame; turn it into something GR's thread_body_wrapper logs.
int js_work_checked(int handle, int nout, const float* in, float* out)
{
    char err[kErrCap] = { 0 };
    const int n = js_work(handle, nout, in, out, err);
    if (n < 0) throw std::runtime_error(err[0] ? err : "JS block failed");
    return n;
}

// ---------------------------------------------------------------------------
// Phase A: the core checks, on one pthread.
// ---------------------------------------------------------------------------

void* core_thread(void*)
{
    // (1) Is a plain EM_ASM body running here, or on the browser main thread?
    const int here = EM_ASM_INT({ return ENVIRONMENT_IS_PTHREAD ? 1 : 0; });
    const int proxied = MAIN_THREAD_EM_ASM_INT({ return ENVIRONMENT_IS_PTHREAD ? 1 : 0; });
    check("em_asm_runs_on_calling_pthread", here == 1,
          "EM_ASM saw ENVIRONMENT_IS_PTHREAD=" + std::to_string(here));
    check("main_thread_em_asm_still_proxies", proxied == 0,
          "MAIN_THREAD_EM_ASM saw ENVIRONMENT_IS_PTHREAD=" + std::to_string(proxied));

    // (2) Did --pre-js run in this worker's realm?
    const int pre = EM_ASM_INT({ return globalThis.__grJsSpikePreJsRan ? 1 : 0; });
    check("pre_js_present_in_pthread_realm", pre == 1,
          pre ? "--pre-js executed in the em-pthread realm"
              : "--pre-js DID NOT run here; a JS runtime cannot be delivered this way");

    // (3) + the authoring contract: new Function, gr.export, params, start().
    char err[kErrCap] = { 0 };
    const int rc = js_compile(1, kGainSource, err);
    check("new_function_compiles_user_source", rc == 0, rc == 0 ? "gr.export() accepted" : err);
    if (rc != 0) return nullptr;

    // (4) Zero copy: C++ owns the buffers, JS writes straight into them.
    const int kItems = 1024;
    std::vector<float> in(kItems * 2), out(kItems * 2, -1.0f);
    for (int i = 0; i < kItems * 2; i++) in[i] = float(i);

    EM_ASM({ __grJsSpike.setParam($0, $1, $2); }, 1, "gain", 3.0);
    int produced = 0;
    try {
        produced = js_work_checked(1, kItems, in.data(), out.data());
    } catch (const std::exception& e) {
        check("zero_copy_work", false, std::string("threw: ") + e.what());
        return nullptr;
    }
    bool exact = (produced == kItems);
    for (int i = 0; exact && i < kItems * 2; i++) exact = (out[i] == in[i] * 3.0f);
    check("zero_copy_work_writes_gr_buffers", exact,
          "produced=" + std::to_string(produced) + " of " + std::to_string(kItems));

    // A live parameter change lands between calls, as numeric_setters does.
    EM_ASM({ __grJsSpike.setParam($0, $1, $2); }, 1, "gain", 0.5);
    js_work_checked(1, kItems, in.data(), out.data());
    check("live_param_change_applies", out[7] == in[7] * 0.5f,
          "out[7]=" + std::to_string(out[7]));

    // (5) A JS throw becomes a catchable std::runtime_error.
    js_compile(2, kThrowingSource, err);
    bool caught = false;
    std::string what;
    try {
        js_work_checked(2, 16, in.data(), out.data());
    } catch (const std::runtime_error& e) {
        caught = true;
        what = e.what();
    }
    check("js_throw_becomes_cpp_exception",
          caught && what.find("boom from JS work()") != std::string::npos,
          caught ? what.substr(0, 60) : "nothing was thrown");

    // (6) Memory growth against a deliberately CACHED view.
    const size_t before = emscripten_get_heap_size();
    const size_t before_js = size_t(EM_ASM_DOUBLE({ return __grJsSpike.heapBytes(); }));
    EM_ASM({ __grJsSpike.cacheView($0, $1); }, out.data(), kItems * 2);
    // Force sbrk past the initial memory. The sink is volatile because -O2
    // will otherwise elide an allocation whose memory is never observed.
    const size_t kGrow = 96u * 1024u * 1024u;
    char* big = (char*)malloc(kGrow);
    g_sink = big;
    if (big) { big[0] = 1; big[kGrow - 1] = 2; }
    const size_t after = emscripten_get_heap_size();
    const size_t after_js = size_t(EM_ASM_DOUBLE({ return __grJsSpike.heapBytes(); }));
    check("memory_actually_grew", after > before,
          std::string("malloc(96MB)=") + (big ? "ok" : "NULL") + "; C++ heap " +
              std::to_string(before / (1024 * 1024)) + " -> " + std::to_string(after / (1024 * 1024)) +
              " MB; JS wasmMemory.buffer " + std::to_string(before_js / (1024 * 1024)) + " -> " +
              std::to_string(after_js / (1024 * 1024)) + " MB");

    const int same_buffer = EM_ASM_INT({ return __grJsSpike.cachedBufferIsCurrent(); });
    const int detached = EM_ASM_INT({ return __grJsSpike.cachedBufferDetached(); });
    const int wrote = EM_ASM_INT({ return __grJsSpike.writeThroughCached($0); }, 42);
    const bool stale_view_still_works = (wrote == 1 && out[0] == 42.0f);
    check("growth_replaces_buffer_object", same_buffer == 0,
          same_buffer ? "wasmMemory.buffer identity unchanged" : "wasmMemory.buffer is a new object");
    check("stale_view_not_detached_on_shared_heap", detached == 0 && stale_view_still_works,
          stale_view_still_works ? "a cached view still reaches the SAME memory after growth"
                                 : "a cached view stopped working after growth");
    // The re-derived path must of course still be correct.
    js_work_checked(1, kItems, in.data(), out.data());
    check("re_derived_view_correct_after_growth", out[7] == in[7] * 0.5f,
          "out[7]=" + std::to_string(out[7]));
    // Can a view cached before growth address memory that only exists after it?
    char* high = (char*)malloc(1024);
    g_sink = high;
    const int covers = EM_ASM_INT({ return __grJsSpike.staleViewCoversNewMemory($0, $1); }, high, 16);
    check("stale_view_cannot_address_post_growth_memory", covers == 0,
          covers ? "it could, unexpectedly" : "correct: re-deriving is required for new allocations");
    free(high);
    free(big);

    // (7) Cost of one crossing, and of one realistic work() call.
    const int kIters = 200000;
    const int kNout = 64;
    double t0 = emscripten_get_now();
    for (int i = 0; i < kIters; i++) EM_ASM_INT({ return 0; });
    double empty_ns = (emscripten_get_now() - t0) * 1e6 / kIters;

    t0 = emscripten_get_now();
    for (int i = 0; i < kIters; i++) js_work(1, kNout, in.data(), out.data(), err);
    double work_ns = (emscripten_get_now() - t0) * 1e6 / kIters;

    char buf[256];
    snprintf(buf, sizeof buf,
             "empty EM_ASM %.0f ns/call; full work(nout=%d) %.0f ns/call (%.1f ns/item)",
             empty_ns, kNout, work_ns, work_ns / kNout);
    check("per_call_overhead_is_acceptable", work_ns < 20000.0, buf);
    return nullptr;
}

// ---------------------------------------------------------------------------
// Phase B: do four JS work() bodies run at the same time?
// ---------------------------------------------------------------------------

constexpr int kThreads = 4;
alignas(64) std::atomic<int> g_barrier{ 0 };
std::atomic<int> g_arrived{ 0 };
std::atomic<int> g_isolated{ 0 };

void* concurrent_thread(void* arg)
{
    const int id = int(intptr_t(arg));
    char err[kErrCap] = { 0 };
    // Each thread compiles its own source. If these shared one realm, the
    // second compile would see the first's block in its map.
    if (js_compile(100 + id, kGainSource, err) == 0) {
        const int n = EM_ASM_INT({ return __grJsSpike.count(); });
        if (n == 1) g_isolated.fetch_add(1);
    }
    // Spin inside JS until every thread has arrived. Serialized execution --
    // proxying to the main thread, one shared worker, anything -- cannot pass.
    const int ok = EM_ASM_INT({ return __grJsSpike.barrier($0, $1, $2); },
                              (int*)&g_barrier, kThreads, 3000);
    if (ok) g_arrived.fetch_add(1);
    return nullptr;
}

// ---------------------------------------------------------------------------

void* coordinator(void*)
{
    core_thread(nullptr);

    pthread_t th[kThreads];
    for (int i = 0; i < kThreads; i++)
        pthread_create(&th[i], nullptr, concurrent_thread, (void*)intptr_t(i));
    for (int i = 0; i < kThreads; i++) pthread_join(th[i], nullptr);

    check("js_work_runs_concurrently_on_scheduler_threads", g_arrived.load() == kThreads,
          std::to_string(g_arrived.load()) + "/" + std::to_string(kThreads) +
              " threads cleared a JS-side barrier");
    check("each_pthread_gets_its_own_js_realm", g_isolated.load() == kThreads,
          std::to_string(g_isolated.load()) + "/" + std::to_string(kThreads) +
              " threads saw only their own compiled block");

    int failures = 0;
    std::string report;
    for (const auto& c : g_checks) {
        if (!c.ok) failures++;
        report += (c.ok ? "  ok   " : "  FAIL ") + c.name;
        if (!c.note.empty()) report += "\n         " + c.note;
        report += "\n";
    }
    const std::string verdict =
        failures == 0 ? "SPIKE_PASS" : ("SPIKE_FAIL (" + std::to_string(failures) + ")");
    const std::string full = "\n=== js-block spike ===\n" + report + verdict + "\n";
    printf("%s", full.c_str());
    fflush(stdout);

    MAIN_THREAD_EM_ASM({
        const el = (typeof document !== 'undefined') && document.getElementById('result');
        if (el) {
            el.textContent = UTF8ToString($0);
            el.dataset.status = 'done';
        }
    }, full.c_str());

    emscripten_force_exit(failures == 0 ? 0 : 1);
    return nullptr;
}

} // namespace

int main()
{
    // Faithful to the runner: the browser main thread stays free (Qt's event
    // loop lives there) and every join happens off it.
    pthread_t co;
    pthread_create(&co, nullptr, coordinator, nullptr);
    emscripten_exit_with_live_runtime();
    return 0;
}
