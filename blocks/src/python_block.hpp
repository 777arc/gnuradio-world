// The Embedded Python Block, C++ side.
//
// A gr::block whose work() is a Python method. The Python itself lives in a
// Pyodide interpreter in a Web Worker (runner/src/pyodide/gr_pyodide_worker.js);
// this class is the half that the GNU Radio scheduler sees, and the handshake
// between the two is a control block in shared WebAssembly memory plus a futex.
//
// Why it looks like this, in one place:
//
//   * Python cannot run on the browser main thread. A work() call has to block
//     until Python answers, blocking means Atomics.wait, and Atomics.wait is
//     illegal on the main thread. So Python runs in a worker and the *block's own
//     scheduler thread* is what blocks -- the same split BrowserFileSource uses.
//
//   * The constructor cannot wait for anything. It runs on the main thread (see
//     run_now() in runner/src/runner.cpp), so it cannot futex-wait for Python to
//     report its io signature. Instead the runner instantiates every Python
//     object *before* building any block (gr_run_json's prepare step) and this
//     constructor is handed the answer as a plain PythonBlockConfig.
//
//   * Calls back into C++ from inside work() are batched, not synchronous. The GR
//     thread that asked for the work is asleep and cannot service a request, so
//     consume/produce/tags are recorded by the Python side and applied here when
//     work() returns. See runner/src/pyodide/py/gnuradio/gr/gateway.py.
//
// The control-block layout below is mirrored in gr_pyodide_worker.js, which
// checks the two agree at bind time.

#pragma once

#include <emscripten.h>
#include <emscripten/threading.h>

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>

#include <algorithm>
#include <climits>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace grworld {

// Widths shared with the worker. MAX_PORTS bounds a Python block's stream ports;
// no realistic in_sig comes close, and the factory rejects more with a message.
inline constexpr int kMaxPorts = 32;
inline constexpr int kMaxCallbacks = 32;  // one per bit of the set-mask word
inline constexpr int kErrorBytes = 4096;  // a Python traceback, roughly

// Everything the runner learned from the live Python object before this block was
// built. Plain C++ so the block stays free of nlohmann/json; the factory in
// runner/src/registry.cpp decodes the JSON and fills this in.
struct PythonBlockConfig {
    std::string name;              // the flowgraph's block id, the worker's key
    std::string label;             // the Python block's name(), for gr::block
    std::vector<int> in_itemsizes;
    std::vector<int> out_itemsizes;
    // The four Python base classes differ, to C++, only in these two and in
    // whether the class overrides forecast(): a sync, decimating, interpolating or
    // general Python block is the same gr::block here.
    int decim = 1;
    int interp = 1;
    int history = 1;
    int output_multiple = 0;       // 0 = the block did not ask for one
    double relative_rate = 1.0;
    int tag_propagation_policy = 1;  // gr::block::TPP_ALL_TO_ALL
    int min_output_buffer = 0;
    int max_noutput_items = 0;
    bool overrides_forecast = false;
    int callback_count = 0;        // how many bits of the set-mask are in use
};

class PythonBlockWasm : public gr::block
{
public:
    static std::shared_ptr<PythonBlockWasm> make(const PythonBlockConfig& config)
    {
        return std::shared_ptr<PythonBlockWasm>(new PythonBlockWasm(config));
    }

    ~PythonBlockWasm() override { request_exit(); }

    // Live parameter update, called on the browser main thread from a QT GUI
    // Range's handler -- so it must not block and must not touch anything the
    // worker could be reading mid-call. Writing the value and then OR-ing one bit
    // is the whole protocol: the worker drains the mask immediately before its
    // next call into Python, so the change lands between work() calls rather than
    // during one.
    void set_callback_value(int index, double value)
    {
        if (index < 0 || index >= d_config.callback_count) return;
        d_doubles[kSetValue + index] = value;
        __atomic_or_fetch(&d_control.w[kSetMask], 1 << index, __ATOMIC_RELEASE);
    }

    bool start() override
    {
        // Python's start() may return False to refuse the run, as upstream's does.
        return request(kOpStart) != 0;
    }

    bool stop() override
    {
        if (!d_bound) return true;
        const bool ok = request(kOpStop) != 0;
        request_exit();
        return ok;
    }

    void forecast(int noutput_items, gr_vector_int& ninput_items_required) override
    {
        const int inputs = static_cast<int>(ninput_items_required.size());
        if (!d_config.overrides_forecast) {
            // What every base class's forecast() computes. Doing it here keeps the
            // common case off the round trip entirely: a sync block would
            // otherwise cross into Python twice per scheduler iteration.
            const int required = static_cast<int>(
                (static_cast<std::int64_t>(noutput_items) * d_config.decim) / d_config.interp
                + history() - 1);
            std::fill(ninput_items_required.begin(), ninput_items_required.end(), required);
            return;
        }
        d_control.w[kNoutput] = noutput_items;
        d_control.w[kNin] = inputs;
        request(kOpForecast);
        for (int i = 0; i < inputs && i < kMaxPorts; ++i)
            ninput_items_required[i] = d_control.w[kInAvail + i];
    }

    int general_work(int noutput_items,
                     gr_vector_int& ninput_items,
                     gr_vector_const_void_star& input_items,
                     gr_vector_void_star& output_items) override
    {
        const int nin = static_cast<int>(input_items.size());
        const int nout = static_cast<int>(output_items.size());

        d_control.w[kNoutput] = noutput_items;
        d_control.w[kNin] = nin;
        d_control.w[kNout] = nout;
        d_control.w[kConsumeEach] = -1;
        for (int i = 0; i < nin; ++i) {
            d_control.w[kInPtr + i] =
                static_cast<std::int32_t>(reinterpret_cast<std::uintptr_t>(input_items[i]));
            d_control.w[kInAvail + i] = ninput_items[i];
            d_control.w[kConsume + i] = 0;
            d_doubles[kNitemsRead + i] = static_cast<double>(nitems_read(i));
        }
        for (int i = 0; i < nout; ++i) {
            d_control.w[kOutPtr + i] =
                static_cast<std::int32_t>(reinterpret_cast<std::uintptr_t>(output_items[i]));
            d_control.w[kProduce + i] = 0;
            d_doubles[kNitemsWritten + i] = static_cast<double>(nitems_written(i));
        }

        const int result = request(kOpWork);

        // Apply what Python asked for while it was running. consume_each() is the
        // usual case (every sync/decim/interp block goes through it); per-port
        // consume()/produce() is what a basic_block does by hand.
        const int consume_each_n = d_control.w[kConsumeEach];
        if (consume_each_n >= 0) {
            consume_each(consume_each_n);
        } else {
            for (int i = 0; i < nin; ++i)
                if (d_control.w[kConsume + i] > 0) consume(i, d_control.w[kConsume + i]);
        }
        if (result == kWorkCalledProduce)
            for (int i = 0; i < nout; ++i)
                if (d_control.w[kProduce + i] > 0) produce(i, d_control.w[kProduce + i]);
        return result;
    }

private:
    // ---- the control block, mirrored in gr_pyodide_worker.js ----------------
    // Two regions rather than one struct with mixed types: the int32 words are
    // what both sides index atomically, and the doubles sit apart so neither side
    // has to reason about alignment inside them. Names match the worker's W_*/D_*.
    enum Word {
        kState = 0,     // worker -> host: how the request ended
        kOp = 1,        // host -> worker: which call
        kNoutput = 2,
        kNin = 3,
        kNout = 4,
        kResult = 5,
        kErrorLen = 6,
        kConsumeEach = 7,
        kSetMask = 8,
        kSeq = 9,       // host bumps last; the worker waits on this
        kInPtr = 10,
        kInAvail = kInPtr + kMaxPorts,
        kOutPtr = kInAvail + kMaxPorts,
        kConsume = kOutPtr + kMaxPorts,
        kProduce = kConsume + kMaxPorts,
        kControlWords = kProduce + kMaxPorts,
    };
    enum Slot {
        kNitemsRead = 0,
        kNitemsWritten = kMaxPorts,
        kSetValue = kNitemsWritten + kMaxPorts,
        kDoubleSlots = kSetValue + kMaxCallbacks,
    };
    enum State { kBusy = 1, kDone = 2, kFailed = 3 };
    enum Op { kOpWork = 1, kOpStart = 2, kOpStop = 3, kOpForecast = 4, kOpExit = 5 };

    static constexpr int kWorkCalledProduce = -2;  // gr::block::WORK_CALLED_PRODUCE
    // A Python call that has not answered in this long is not slow, it is gone
    // (a worker that failed to start, or a browser tab throttled to death). Give
    // up loudly: GR's thread_body_wrapper turns the exception into a logged error,
    // which is a diagnosable flowgraph rather than a hung one.
    static constexpr double kTimeoutSeconds = 30.0;

    struct alignas(4) Control {
        std::int32_t w[kControlWords] = {};
    };

    explicit PythonBlockWasm(const PythonBlockConfig& config)
        : gr::block(config.label.empty() ? "python_block" : config.label,
                    signature(config.in_itemsizes),
                    signature(config.out_itemsizes)),
          d_config(config)
    {
        d_doubles.assign(kDoubleSlots, 0.0);
        d_error.assign(kErrorBytes, '\0');

        // Everything the Python object declared from its __init__. This has to
        // happen here, in the constructor: buffers are sized before any block's
        // start(), so set_history() and set_output_multiple() are too late by then.
        if (config.history > 1) set_history(config.history);
        if (config.output_multiple > 0) set_output_multiple(config.output_multiple);
        if (config.relative_rate != 1.0) set_relative_rate(config.relative_rate);
        set_tag_propagation_policy(
            static_cast<gr::block::tag_propagation_policy_t>(config.tag_propagation_policy));
        if (config.min_output_buffer > 0) set_min_output_buffer(config.min_output_buffer);
        if (config.max_noutput_items > 0) set_max_noutput_items(config.max_noutput_items);

        bind_worker();
    }

    static gr::io_signature::sptr signature(const std::vector<int>& itemsizes)
    {
        if (itemsizes.empty()) return gr::io_signature::make(0, 0, 0);
        if (static_cast<int>(itemsizes.size()) > kMaxPorts)
            throw std::runtime_error("Python Block: more than " +
                                     std::to_string(kMaxPorts) + " ports on one side");
        const int n = static_cast<int>(itemsizes.size());
        return gr::io_signature::makev(n, n, itemsizes);
    }

    // Hand the worker this block's control block. Asynchronous by design: the
    // constructor posts and returns, and a request that arrives before the worker
    // has started pumping is not lost -- it is a sequence-number bump sitting in
    // shared memory.
    void bind_worker()
    {
        const int ok = MAIN_THREAD_EM_ASM_INT({
            return window.__grPyodideBindBlock(UTF8ToString($0), $1 >>> 0, $2 >>> 0,
                                              $3 >>> 0, $4, $5, $6) ? 1 : 0;
        }, d_config.name.c_str(), d_control.w, d_doubles.data(), d_error.data(),
           kErrorBytes, kControlWords, kDoubleSlots);
        if (!ok)
            throw std::runtime_error("Python Block '" + d_config.name +
                                     "': the Python runtime is not available");
        d_bound = true;
    }

    void request_exit()
    {
        if (!d_bound) return;
        d_bound = false;
        __atomic_store_n(&d_control.w[kOp], static_cast<std::int32_t>(kOpExit),
                         __ATOMIC_RELAXED);
        __atomic_add_fetch(&d_control.w[kSeq], 1, __ATOMIC_RELEASE);
        emscripten_futex_wake(&d_control.w[kSeq], INT_MAX);
    }

    // Post one request and wait for the worker to answer it. Runs on this block's
    // own scheduler thread, where blocking costs nothing else.
    int request(Op op)
    {
        if (!d_bound)
            throw std::runtime_error("Python Block '" + d_config.name +
                                     "': not connected to the Python runtime");
        __atomic_store_n(&d_control.w[kState], static_cast<std::int32_t>(kBusy),
                         __ATOMIC_RELAXED);
        __atomic_store_n(&d_control.w[kOp], static_cast<std::int32_t>(op), __ATOMIC_RELAXED);
        // Last, and with release ordering: the sequence bump is what publishes
        // every word written above.
        __atomic_add_fetch(&d_control.w[kSeq], 1, __ATOMIC_RELEASE);
        emscripten_futex_wake(&d_control.w[kSeq], INT_MAX);

        // work() and forecast() always arrive on this block's scheduler thread,
        // where waiting is free. start()/stop() can also come from the browser
        // main thread (top_block::stop() on a reload), and *that* thread may never
        // block -- Atomics.wait is illegal there. Post and move on: the worker
        // still runs the Python hook, we just do not learn its answer, so a
        // main-thread start() is reported as accepted.
        if (emscripten_is_main_browser_thread()) return 1;

        double waited = 0.0;
        while (__atomic_load_n(&d_control.w[kState], __ATOMIC_ACQUIRE) == kBusy) {
            emscripten_futex_wait(&d_control.w[kState], kBusy, 100.0);
            waited += 0.1;
            if (waited >= kTimeoutSeconds)
                throw std::runtime_error("Python Block '" + d_config.name + "': the Python "
                                         "runtime stopped answering after " +
                                         std::to_string(static_cast<int>(kTimeoutSeconds)) +
                                         "s");
        }
        if (__atomic_load_n(&d_control.w[kState], __ATOMIC_ACQUIRE) == kFailed)
            throw std::runtime_error("Python Block '" + d_config.name + "': " + error_text());
        return d_control.w[kResult];
    }

    std::string error_text() const
    {
        const int length = std::max(0, std::min(d_control.w[kErrorLen], kErrorBytes - 1));
        return length ? std::string(d_error.data(), length) : std::string("Python raised");
    }

    PythonBlockConfig d_config;
    Control d_control;
    std::vector<double> d_doubles;
    std::vector<char> d_error;
    bool d_bound = false;
};

}  // namespace grworld
