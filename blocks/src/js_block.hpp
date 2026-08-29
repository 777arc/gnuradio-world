// The JavaScript Block, C++ side. See docs/js-blocks.md.
//
// A gr::block whose work() is a JavaScript function running on this block's own
// GR scheduler thread -- which, under Emscripten, is a Web Worker that has
// already loaded the whole of runner.js. So there is no worker to hand off to, no
// second heap to copy through, and no handshake: general_work() fills a small
// int32 array and makes one EM_ASM call, and the JavaScript reads GNU Radio's
// circular buffers as typed-array views over the shared WebAssembly memory.
//
// Contrast blocks/src/python_block.hpp, which is the same idea for a language
// that cannot do any of that. Every mechanism there -- the shared control block,
// the futex, the sequence number, the async prepare step, the copies in and out
// -- exists to work around a constraint JavaScript does not have.
//
// Two things here are load-bearing and easy to undo by accident:
//
//   * The hot path uses plain EM_ASM. MAIN_THREAD_EM_ASM proxies to the browser
//     main thread and blocks until it answers; every other JS-crossing helper in
//     this tree uses that form because they all run from constructors on the main
//     thread. Copying one into this file would compile, run, produce correct
//     samples, and silently serialize every JS block in the flowgraph behind Qt's
//     event loop.
//
//   * This header compiles into the main module, exactly as python_block.hpp
//     does. EM_ASM from inside a dlopen'd SIDE_MODULE is known-fragile in
//     Emscripten and is not something this design relies on. Keep it here.
//
// The one honest cost of running on the block's own thread: a work() that never
// returns cannot be interrupted. There is no timeout to fire and no worker to
// terminate, because the call is on the scheduler thread's own stack. That thread
// is wedged until the tab is reloaded -- which is exactly what a C++ block that
// spins already does.

#pragma once

#include "js_pmt.hpp"

#include <emscripten.h>
#include <emscripten/threading.h>

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/tags.h>

#include <algorithm>
#include <atomic>
#include <climits>
#include <cstdio>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace grworld {

// Mirrored in runner/src/js_runtime.js. A JS block's ports are whatever its
// source declares, and the runtime rejects more than this on either side.
inline constexpr int kJsMaxPorts = 32;
inline constexpr int kJsErrorBytes = 4096;   // an error.stack, roughly

// What the source said about itself, read once on the browser main thread inside
// make_js_block(). Plain C++ so this header stays free of nlohmann/json.
struct JsBlockConfig {
    std::string name;        // the flowgraph's block id, for error messages
    std::string label;       // the descriptor's label, for gr::block
    std::string source;      // the JavaScript, evaluated again on this block's thread
    std::string params_json = "{}"; // this instance's parameter values, as a JSON object
    std::string descriptor_json; // normalized descriptor from the factory pass
    std::vector<int> in_itemsizes;
    std::vector<int> out_itemsizes;
    int decim = 1;
    int interp = 1;
    int history = 1;
    int output_multiple = 0;
    double relative_rate = 1.0;
    bool general = false;
    bool overrides_forecast = false;
    std::vector<std::string> msg_ports_in;
    std::vector<std::string> msg_ports_out;
    std::vector<std::string> msg_handler_ports;
    int tag_propagation_policy = gr::block::TPP_ALL_TO_ALL;
    // One entry per output; zero means no request for that port.
    std::vector<long> min_output_buffers;
    int max_noutput_items = 0;
    // Numeric parameters, in the order the descriptor declared them. Each gets a
    // slot below and one bit of the dirty mask.
    std::vector<std::string> numeric_params;
};

class JsBlockWasm : public gr::block
{
public:
    static std::shared_ptr<JsBlockWasm> make(const JsBlockConfig& config)
    {
        return std::shared_ptr<JsBlockWasm>(new JsBlockWasm(config));
    }

    ~JsBlockWasm() override
    {
        // The instance lives in the *block thread's* realm, which this destructor
        // may not be running in, so there is nothing to free from here. The realm
        // dies with its worker.
    }

    // Live parameter update, called on the browser main thread from a QT GUI
    // Range's handler. It must not block and must not touch anything the block
    // thread could be reading mid-call, so this is the whole protocol: write the
    // value, then OR one bit into the dirty mask. The block drains the mask
    // immediately before its next call into JavaScript, so a change lands
    // *between* work() calls and none is lost. Same mechanism as
    // PythonBlockWasm::set_callback_value().
    void set_param_value(int index, double value)
    {
        if (index < 0 || index >= static_cast<int>(d_config.numeric_params.size())) return;
        d_param_values[index] = value;
        __atomic_or_fetch(&d_dirty_mask, 1u << index, __ATOMIC_RELEASE);
    }

    std::uint64_t work_calls() const { return d_work_calls.load(std::memory_order_relaxed); }
    int last_requested() const { return d_last_requested.load(std::memory_order_relaxed); }
    int last_produced() const { return d_last_produced.load(std::memory_order_relaxed); }
    int last_consumed() const { return d_last_consumed.load(std::memory_order_relaxed); }
    std::uint64_t zero_progress_calls() const
    {
        return d_zero_progress_calls.load(std::memory_order_relaxed);
    }
    std::uint64_t messages_in() const { return d_messages_in.load(std::memory_order_relaxed); }
    std::uint64_t messages_out() const { return d_messages_out.load(std::memory_order_relaxed); }
    std::uint64_t tags_out() const { return d_tags_out.load(std::memory_order_relaxed); }

    // Narrow surface used only by js_pmt.cpp while JavaScript is synchronously
    // on this block's scheduler-thread stack.
    int bridge_get_tags(int port,
                        std::uint64_t start,
                        std::uint64_t end,
                        const pmt::pmt_t* key)
    {
        if (port < 0 || port >= static_cast<int>(d_config.in_itemsizes.size()))
            throw std::runtime_error("get_tags_in_range(): no input port " +
                                     std::to_string(port));
        if (end < start)
            throw std::runtime_error("get_tags_in_range(): end precedes start");
        d_tag_scratch.clear();
        if (key) get_tags_in_range(d_tag_scratch, port, start, end, *key);
        else get_tags_in_range(d_tag_scratch, port, start, end);
        return static_cast<int>(d_tag_scratch.size());
    }

    const gr::tag_t& bridge_tag(int index) const
    {
        if (index < 0 || index >= static_cast<int>(d_tag_scratch.size()))
            throw std::runtime_error("the JavaScript tag index was out of range");
        return d_tag_scratch[static_cast<std::size_t>(index)];
    }

    void bridge_add_tag(int port,
                        std::uint64_t offset,
                        const pmt::pmt_t& key,
                        const pmt::pmt_t& value,
                        const pmt::pmt_t& srcid)
    {
        if (port < 0 || port >= static_cast<int>(d_config.out_itemsizes.size()))
            throw std::runtime_error("add_item_tag(): no output port " +
                                     std::to_string(port));
        add_item_tag(static_cast<unsigned>(port), offset, key, value, srcid);
        d_tags_out.fetch_add(1, std::memory_order_relaxed);
    }

    std::uint64_t bridge_nitems(bool written, int port)
    {
        const int count = written ? static_cast<int>(d_config.out_itemsizes.size())
                                  : static_cast<int>(d_config.in_itemsizes.size());
        if (port < 0 || port >= count)
            throw std::runtime_error(std::string(written ? "nitems_written" : "nitems_read") +
                                     "(): no " + (written ? "output" : "input") +
                                     " port " + std::to_string(port));
        return written ? nitems_written(static_cast<unsigned>(port))
                       : nitems_read(static_cast<unsigned>(port));
    }

    void bridge_publish(int port_index, const pmt::pmt_t& message)
    {
        if (port_index < 0 || port_index >= static_cast<int>(d_config.msg_ports_out.size()))
            throw std::runtime_error("message_port_pub(): no registered output port at index " +
                                     std::to_string(port_index));
        message_port_pub(pmt::intern(d_config.msg_ports_out[port_index]), message);
        d_messages_out.fetch_add(1, std::memory_order_relaxed);
    }

    bool start() override
    {
        // Deliberately not where the instance is built. start() may be called from
        // the browser main thread (top_block::start()), and an instance compiled
        // there would live in the *main* realm rather than in this block's worker.
        // general_work() is definitionally on this block's own thread, so that is
        // where the first evaluation happens.
        //
        // The cost is one honest difference from GNU Radio: a JS block's start()
        // is an init hook and cannot refuse the run.
        return true;
    }

    bool stop() override
    {
        // Same realm problem in reverse: this can arrive on the main thread, where
        // the instance does not exist. Ask only when we are the thread that built
        // it; otherwise the worker is about to be torn down anyway.
        if (d_compiled && !emscripten_is_main_browser_thread()) {
            JsPmtArenaScope arena;
            const int rc = EM_ASM_INT({ return __grJs.stop($0, $1, $2); },
                                      handle(), d_error.data(), kJsErrorBytes);
            drain_log();
            EM_ASM({ __grJs.destroy($0); }, handle());
            d_compiled = false;
            if (rc < 0) throw std::runtime_error(prefix() + error_text());
        }
        return true;
    }

    void forecast(int noutput_items, gr_vector_int& ninput_items_required) override
    {
        const int inputs = static_cast<int>(ninput_items_required.size());
        if (!d_config.overrides_forecast) {
            // What every base class's forecast() computes. Doing it here keeps the
            // common case off the crossing entirely.
            const int required = static_cast<int>(
                (static_cast<std::int64_t>(noutput_items) * d_config.decim) / d_config.interp
                + history() - 1);
            std::fill(ninput_items_required.begin(), ninput_items_required.end(), required);
            return;
        }
        // The block executor calls forecast() on this block's own thread, the same
        // one general_work() arrives on, so building the instance here is safe --
        // and necessary, because forecast() runs before the first work() call.
        ensure_compiled();
        JsPmtArenaScope arena;
        d_words[kNout] = noutput_items;
        d_words[kNinPorts] = std::min(inputs, kJsMaxPorts);
        const int rc = EM_ASM_INT({ return __grJs.forecast($0, $1, $2, $3); },
                                  handle(), d_words.data(), d_error.data(), kJsErrorBytes);
        if (rc < 0) throw std::runtime_error(prefix() + error_text());
        for (int i = 0; i < inputs && i < kJsMaxPorts; ++i)
            ninput_items_required[i] = d_words[kForecast + i];
    }

    int general_work(int noutput_items,
                     gr_vector_int& ninput_items,
                     gr_vector_const_void_star& input_items,
                     gr_vector_void_star& output_items) override
    {
        ensure_compiled();
        drain_param_changes();
        JsPmtArenaScope arena;

        const int nin = std::min(static_cast<int>(input_items.size()), kJsMaxPorts);
        const int nout = std::min(static_cast<int>(output_items.size()), kJsMaxPorts);

        d_words[kNout] = noutput_items;
        d_words[kNinPorts] = nin;
        d_words[kNoutPorts] = nout;
        d_words[kResult] = 0;
        d_words[kConsumeEach] = 0;
        for (int i = 0; i < nin; ++i) {
            d_words[kInPtr + i] =
                static_cast<std::int32_t>(reinterpret_cast<std::uintptr_t>(input_items[i]));
            d_words[kInAvail + i] = ninput_items[i];
            d_words[kConsume + i] = 0;
        }
        for (int i = 0; i < nout; ++i)
            d_words[kOutPtr + i] =
                static_cast<std::int32_t>(reinterpret_cast<std::uintptr_t>(output_items[i]));

        // The crossing. Plain EM_ASM: this body executes on THIS thread. Measured
        // at well under 100 ns fixed cost, which amortizes to nothing against the
        // few thousand items a realistic call carries.
        const int rc = EM_ASM_INT({ return __grJs.work($0, $1, $2, $3); },
                                  handle(), d_words.data(), d_error.data(), kJsErrorBytes);
        if (rc < 0) throw std::runtime_error(prefix() + error_text());

        if (d_words[kLogPending]) drain_log();

        const int produced = d_words[kResult];
        const int consume_each_n = d_words[kConsumeEach];
        int consumed_total = 0;
        if (consume_each_n >= 0) {
            if (consume_each_n > 0) {
                consume_each(consume_each_n);
                consumed_total = consume_each_n * nin;
            }
        } else {
            // A generalWork() block called this.consume(port, n) itself.
            for (int i = 0; i < nin; ++i)
                if (d_words[kConsume + i] > 0) {
                    consume(i, d_words[kConsume + i]);
                    consumed_total += d_words[kConsume + i];
                }
        }
        d_last_requested.store(noutput_items, std::memory_order_relaxed);
        d_last_produced.store(produced, std::memory_order_relaxed);
        d_last_consumed.store(consumed_total, std::memory_order_relaxed);
        d_work_calls.fetch_add(1, std::memory_order_relaxed);
        if (produced > 0 || consumed_total > 0)
            d_zero_progress_calls.store(0, std::memory_order_relaxed);
        else
            d_zero_progress_calls.fetch_add(1, std::memory_order_relaxed);
        return produced;
    }

private:
    // ---- the control words, mirrored in runner/src/js_runtime.js ------------
    enum Word {
        kNout = 0,
        kNinPorts = 1,
        kNoutPorts = 2,
        kResult = 3,
        kConsumeEach = 4,
        kLogPending = 5,
        kInPtr = 8,
        kInAvail = kInPtr + kJsMaxPorts,
        kOutPtr = kInAvail + kJsMaxPorts,
        kConsume = kOutPtr + kJsMaxPorts,
        kForecast = kConsume + kJsMaxPorts,
        kWords = kForecast + kJsMaxPorts,
    };

    explicit JsBlockWasm(const JsBlockConfig& config)
        : gr::block(config.label.empty() ? "js_block" : config.label,
                    signature(config.in_itemsizes),
                    signature(config.out_itemsizes)),
          d_config(config)
    {
        d_words.assign(kWords, 0);
        d_error.assign(kJsErrorBytes, '\0');
        d_log.assign(kJsErrorBytes, '\0');
        d_param_values.assign(std::max<std::size_t>(1, config.numeric_params.size()), 0.0);

        // Everything the descriptor declared. It has to happen here, in the
        // constructor: GR sizes buffers before any block's start(), so
        // set_history() and set_output_multiple() are too late by then.
        if (config.history > 1) set_history(config.history);
        if (config.output_multiple > 0) set_output_multiple(config.output_multiple);
        if (config.relative_rate != 1.0) set_relative_rate(config.relative_rate);
        set_tag_propagation_policy(static_cast<tag_propagation_policy_t>(
            config.tag_propagation_policy));
        for (int port = 0; port < static_cast<int>(config.min_output_buffers.size()); ++port)
            if (config.min_output_buffers[port] > 0)
                set_min_output_buffer(port, config.min_output_buffers[port]);
        if (config.max_noutput_items > 0) set_max_noutput_items(config.max_noutput_items);

        for (const auto& name : config.msg_ports_in)
            message_port_register_in(pmt::intern(name));
        for (const auto& name : config.msg_ports_out)
            message_port_register_out(pmt::intern(name));
        for (int index = 0; index < static_cast<int>(config.msg_handler_ports.size()); ++index) {
            const auto port = pmt::intern(config.msg_handler_ports[index]);
            set_msg_handler(port, [this, index](const pmt::pmt_t& message) {
                handle_message(index, message);
            });
        }
    }

    static gr::io_signature::sptr signature(const std::vector<int>& itemsizes)
    {
        if (itemsizes.empty()) return gr::io_signature::make(0, 0, 0);
        if (static_cast<int>(itemsizes.size()) > kJsMaxPorts)
            throw std::runtime_error("JS Block: more than " +
                                     std::to_string(kJsMaxPorts) + " ports on one side");
        const int n = static_cast<int>(itemsizes.size());
        return gr::io_signature::makev(n, n, itemsizes);
    }

    // A handle unique within the process and stable for this block's lifetime.
    // The JS side keys its per-realm instance table on it.
    int handle() const
    {
        return static_cast<int>(reinterpret_cast<std::uintptr_t>(this));
    }

    std::string prefix() const
    {
        return "JS Block '" + (d_config.name.empty() ? d_config.label : d_config.name) + "': ";
    }

    std::string error_text()
    {
        d_error[kJsErrorBytes - 1] = '\0';
        const std::string text(d_error.data());
        d_error[0] = '\0';
        return text.empty() ? std::string("the block's JavaScript failed") : text;
    }

    // The second of the two evaluations. See "Why the source is evaluated twice"
    // in docs/js-blocks.md: the descriptor is data and crossed a thread boundary
    // as JSON, but the instance is a JS object and cannot, so it is built here in
    // the realm that will actually call it.
    void ensure_compiled()
    {
        if (d_compiled) return;
        JsPmtArenaScope arena;
        const int rc = EM_ASM_INT({ return __grJs.compile($0, $1, $2, $3, $4, $5); },
                                  handle(), d_config.source.c_str(),
                                  d_config.params_json.c_str(),
                                  d_config.descriptor_json.c_str(),
                                  d_error.data(), kJsErrorBytes);
        if (rc != 0) throw std::runtime_error(prefix() + error_text());
        d_compiled = true;
        drain_log();   // anything the descriptor's start() had to say
        // The construction-time values arrived with the source, in params_json --
        // deliberately NOT replayed through the dirty mask here, whose slots hold
        // only what a Range has since written. A change that arrived before the
        // first call set its own bit and is drained below like any other.
        drain_param_changes();
    }

    void handle_message(int port_index, const pmt::pmt_t& message)
    {
        if (emscripten_is_main_browser_thread())
            throw std::runtime_error(prefix() +
                "a JavaScript message handler ran on the browser main thread");
        ensure_compiled();
        drain_param_changes();
        JsPmtArenaScope arena;
        const int message_handle = js_pmt_add(message);
        const int rc = EM_ASM_INT({ return __grJs.message($0, $1, $2, $3, $4); },
                                  handle(), port_index, message_handle,
                                  d_error.data(), kJsErrorBytes);
        drain_log();
        if (rc < 0) throw std::runtime_error(prefix() + error_text());
        d_messages_in.fetch_add(1, std::memory_order_relaxed);
    }

    // this.log() lines, printed through printf() so they reach the editor's
    // console pane -- console.log from a scheduler worker reaches only devtools.
    // Guarded by a word flag, so a block that never logs never crosses for it.
    void drain_log()
    {
        d_log[0] = '\0';
        const int had = EM_ASM_INT({ return __grJs.takeLog($0, $1, $2); },
                                   handle(), d_log.data(), kJsErrorBytes);
        d_words[kLogPending] = 0;
        if (!had) return;
        d_log[kJsErrorBytes - 1] = '\0';
        std::printf("%s: %s\n", d_config.name.c_str(), d_log.data());
        std::fflush(stdout);
    }

    void drain_param_changes()
    {
        const std::uint32_t mask = __atomic_exchange_n(&d_dirty_mask, 0u, __ATOMIC_ACQUIRE);
        if (!mask) return;
        for (int i = 0; i < static_cast<int>(d_config.numeric_params.size()); ++i) {
            if (!(mask & (1u << i))) continue;
            EM_ASM({ __grJs.setParam($0, $1, $2); },
                   handle(), d_config.numeric_params[i].c_str(), d_param_values[i]);
        }
    }

    JsBlockConfig d_config;
    std::vector<std::int32_t> d_words;
    std::vector<char> d_error;
    std::vector<char> d_log;
    std::vector<double> d_param_values;
    std::vector<gr::tag_t> d_tag_scratch;
    std::uint32_t d_dirty_mask = 0;
    bool d_compiled = false;
    std::atomic<std::uint64_t> d_work_calls{ 0 };
    std::atomic<int> d_last_requested{ 0 };
    std::atomic<int> d_last_produced{ 0 };
    std::atomic<int> d_last_consumed{ 0 };
    std::atomic<std::uint64_t> d_zero_progress_calls{ 0 };
    std::atomic<std::uint64_t> d_messages_in{ 0 };
    std::atomic<std::uint64_t> d_messages_out{ 0 };
    std::atomic<std::uint64_t> d_tags_out{ 0 };
};

}  // namespace grworld
