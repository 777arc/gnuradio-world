// Pluggable flowgraph schedulers.
//
// GNU Radio's own scheduler selection (top_block_impl.cc's `scheduler_list` +
// the GR_SCHEDULER environment variable) cannot be used here for two reasons:
// the list is a file-static with no registration API, and the chosen factory is
// cached in a function-local `static` that is resolved once and never re-read.
// One tab runs many flowgraphs, so a per-process choice is the wrong shape.
//
// Instead the runner does what top_block_impl::start() does -- flatten,
// validate, setup_connections, make a scheduler -- and picks the scheduler
// itself. That needs no change to the gnuradio submodule: runner/CMakeLists.txt
// already puts ${GR}/gnuradio-runtime/lib on this target's include path and
// whole-archives libgnuradio-runtime.a, so gr::scheduler, gr::block_executor,
// gr::tpb_detail and gr::flat_flowgraph are all reachable, headers and symbols.
//
// See docs/schedulers.md.
#pragma once

#include "block_executor.h"
#include "flat_flowgraph.h"
#include "scheduler.h"
#include "scheduler_tpb.h"
#include <gnuradio/block.h>
#include <gnuradio/block_detail.h>
#include <gnuradio/logger.h>
#include <gnuradio/prefs.h>
#include <gnuradio/thread/thread_body_wrapper.h>
#include <gnuradio/thread/thread_group.h>
#include <gnuradio/tpb_detail.h>
#include <pmt/pmt.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace runner_sched {

// ---- the single-threaded scheduler ----------------------------------------
//
// One thread runs every block's block_executor::run_one_iteration() in a
// round-robin loop. This is a policy variant of tpb_thread_body.cc: the message
// draining, the state handling and the neighbour notifications are the same
// code, and gr::block_executor is reused verbatim. What changes is what happens
// on BLKD_IN / BLKD_OUT -- TPB waits on the block's condition variable, this
// moves on to the next block.
//
// The point is worker count. Every GNU Radio thread here is a Web Worker
// costing 50-100 ms to spawn plus real memory, so a 40-block flowgraph on TPB
// spends seconds allocating 41 workers before its first sample. On this it
// needs two.
//
// **A block that blocks inside work() stalls the whole graph.** That is Audio
// Sink/Source, the four blocks that read a file, the SDR sources and sinks, and
// the Embedded Python Block -- each of which owns its own scheduler thread by
// design and waits on a futex or a condition variable in work(). blocks_in_work()
// below names them so the runner can warn. This scheduler is opt-in and never
// the default.

inline bool blocks_in_work(const std::string& block_id) {
    // Kept in step with the blocks whose work() waits on a futex, a condition
    // variable or a sleep: browser_audio.cpp, browser_file_source.cpp,
    // browser_file_sink.cpp, rtlsdr_source.cpp, plutosdr_common.cpp,
    // hackrf_common.cpp and python_block.hpp.
    static const char* const ids[] = {
        "audio_sink",
        "audio_source",
        "blocks_file_source",
        "wasm_sigmf_source",
        "wasm_sigmf_sink",
        "wasm_gr_world_recording",
        "wasm_public_http_recording",
        "wasm_rtlsdr_source",
        "wasm_plutosdr_source",
        "wasm_plutosdr_sink",
        "wasm_hackrf_source",
        "wasm_hackrf_sink",
        "epy_block",
    };
    for (const char* id : ids)
        if (block_id == id) return true;
    return false;
}

// Blocks whose output depends on elapsed time rather than on their input, which
// is the one thing a deterministic run cannot survive: in a fixed number of
// rounds a throttle produces however much the wall clock let it. Everything in
// blocks_in_work() is nondeterministic too -- it waits on something outside the
// flowgraph -- so the runner warns about both when a deterministic scheduler is
// chosen.
inline bool wall_clock_block(const std::string& block_id) {
    return block_id.find("throttle") != std::string::npos;
}

namespace detail {

// gr::basic_block keeps its message pump protected and grants access to exactly
// one scheduler body -- `friend class tpb_thread_body;` in basic_block.h. Every
// scheduler has to run that same pump, so a second one needs the same reach.
//
// Most of it is available publicly after all: message_ports_in() returns the
// very keys of msg_queue, and empty_p()/empty_handled_p()/nmsgs()/
// delete_head_nowait() cover the rest. dispatch_msg() is the one thing with no
// public equivalent, so it is reached through the standard explicit-
// instantiation idiom: [temp.explicit] says access checking is not applied to
// the names in an explicit instantiation's template-arguments, which makes
// naming a protected member here well-defined rather than a cast around the
// type system. The pointer is only ever called, and it is virtual, so it
// dispatches exactly as the block's own code would.
//
// The alternative was a friend declaration in the submodule, which a native
// build would see -- and docs/gnuradio-patches.md is explicit that a change
// there has to be justified upstream instead.
template <class Tag, typename Tag::type Member>
struct grant_access {
    friend typename Tag::type reach(Tag) { return Member; }
};

struct dispatch_msg_tag {
    using type = void (gr::basic_block::*)(pmt::pmt_t, pmt::pmt_t);
    friend type reach(dispatch_msg_tag);
};
template struct grant_access<dispatch_msg_tag, &gr::basic_block::dispatch_msg>;

// Run one pass of the message pump over a block: drain every input port that
// has a handler, prune one that does not so a producer cannot grow the queue
// without bound. This is tpb_thread_body.cc's loop, expressed against the
// public surface.
inline void pump_messages(const gr::block_sptr& block,
                          size_t max_nmsgs,
                          gr::logger& logger)
{
    const pmt::pmt_t ports = block->message_ports_in();
    const size_t nports = pmt::length(ports);
    for (size_t i = 0; i < nports; i++) {
        const pmt::pmt_t port = pmt::vector_ref(ports, i);
        // Nothing queued: neither branch below has anything to do, and it keeps
        // the has-a-handler test below meaningful.
        if (block->empty_p(port)) continue;
        // empty_handled_p() is `empty_p() || !has_msg_handler()`, and the queue
        // is known non-empty here, so this is exactly "a handler is attached".
        if (!block->empty_handled_p(port)) {
            pmt::pmt_t msg;
            while ((msg = block->delete_head_nowait(port)))
                (block.get()->*reach(dispatch_msg_tag()))(port, msg);
        } else if (block->nmsgs(port) > max_nmsgs) {
            logger.warn("{} received a message to port {} which has no handler "
                        "registered. Message discarded.",
                        block->identifier(),
                        port);
            block->delete_head_nowait(port);
        }
    }
}

// One entry per block in the round-robin. Never call a variable here `slots`:
// Qt defines that as a macro, and this header is compiled with Qt's macros in
// scope. The executor is heap-allocated because it is neither copyable nor
// movable, and because its
// *destructor* is load-bearing: block_executor::~block_executor() calls
// block->stop(), which is how SigMF Sink's writer worker is told to close its
// file. Retiring the whole vector when the loop ends preserves that.
struct block_slot {
    gr::block_sptr block;
    gr::block_detail* detail = nullptr;
    std::unique_ptr<gr::block_executor> exec;
    bool done = false;
};

// What separates the two single-threaded schedulers. The loop is the same; only
// these three answers differ.
struct round_robin_config {
    // 0 keeps GNU Radio's behaviour: the graph-wide default, overridden per
    // block by set_max_noutput_items(). A positive value overrides *both*, so
    // every work() call is bounded identically from one run to the next.
    int fixed_noutput_items = 0;
    // 0 runs until every block is done or stop() is called. A positive value
    // ends the run after that many complete passes over the block list, which
    // is what gives a run a reproducible end rather than a wall-clock one.
    long long round_budget = 0;
    // Sleep briefly on a pass that made no progress. Right for a graph that
    // runs indefinitely and wrong for a budgeted one, where a sleep would let
    // wall-clock time back into how much work a run gets through.
    bool backoff = true;
};

class round_robin_body {
    gr::block_vector_t d_blocks;
    int d_max_noutput_items;
    round_robin_config d_config;
    std::shared_ptr<std::atomic<bool>> d_stop;

public:
    round_robin_body(gr::block_vector_t blocks,
                     int max_noutput_items,
                     round_robin_config config,
                     std::shared_ptr<std::atomic<bool>> stop)
        : d_blocks(std::move(blocks)),
          d_max_noutput_items(max_noutput_items),
          d_config(config),
          d_stop(std::move(stop))
    {
    }

    void operator()()
    {
        gr::prefs* p = gr::prefs::singleton();
        const size_t max_nmsgs =
            static_cast<size_t>(p->get_long("DEFAULT", "max_messages", 100));
        auto logger = gr::logger("round_robin_scheduler");

        std::vector<block_slot> entries;
        entries.reserve(d_blocks.size());
        for (const auto& b : d_blocks) {
            block_slot s;
            s.block = b;
            s.detail = b->detail().get();
            // Same per-block override TPB honours (scheduler_tpb.cc) -- unless a
            // fixed chunk was asked for, which is the point of the deterministic
            // scheduler and has to beat the block's own preference too.
            const int mno = d_config.fixed_noutput_items > 0
                ? d_config.fixed_noutput_items
                : (b->is_set_max_noutput_items() ? b->max_noutput_items()
                                                 : d_max_noutput_items);
            s.exec = std::make_unique<gr::block_executor>(b, mno);
            b->clear_finished();
            entries.push_back(std::move(s));
        }

        size_t live = entries.size();
        long long rounds = 0;
        while (live > 0 && !d_stop->load(std::memory_order_relaxed)) {
            if (d_config.round_budget > 0 && rounds >= d_config.round_budget) break;
            rounds++;
            bool progressed = false;
            for (auto& s : entries) {
                if (s.done) continue;
                if (d_stop->load(std::memory_order_relaxed)) break;
                boost::this_thread::interruption_point();

                gr::block_detail* d = s.detail;
                d->d_tpb.clear_changed();

                pump_messages(s.block, max_nmsgs, logger);

                gr::block_executor::state st;
                if (d->noutputs() > 0 || d->ninputs() > 0) {
                    st = s.exec->run_one_iteration();
                } else {
                    // A message-only block: nothing for the executor to do, and
                    // it leaves the round-robin only by finishing.
                    st = s.block->finished() ? gr::block_executor::DONE
                                             : gr::block_executor::BLKD_IN;
                }

                if (s.block->finished() && st == gr::block_executor::READY_NO_OUTPUT) {
                    st = gr::block_executor::DONE;
                    d->set_done(true);
                }
                if (!d->ninputs() && st == gr::block_executor::READY_NO_OUTPUT)
                    st = gr::block_executor::BLKD_IN;

                switch (st) {
                case gr::block_executor::READY:
                    // Still notified even though nothing here waits on it: a
                    // block may be driven by TPB in a future mixed scheduler,
                    // and notify_msg() from a message poster uses the same
                    // condition variables.
                    d->d_tpb.notify_neighbors(d);
                    progressed = true;
                    break;
                case gr::block_executor::READY_NO_OUTPUT:
                    d->d_tpb.notify_upstream(d);
                    progressed = true;
                    break;
                case gr::block_executor::DONE:
                    s.block->notify_msg_neighbors();
                    d->d_tpb.notify_neighbors(d);
                    s.done = true;
                    --live;
                    progressed = true;
                    break;
                case gr::block_executor::BLKD_IN:
                case gr::block_executor::BLKD_OUT:
                    // Where TPB would wait on d_tpb's condition variable. Here
                    // the next block gets the thread instead.
                    break;
                default:
                    throw std::runtime_error("possible memory corruption in scheduler");
                }
            }
            // A whole round with nothing to do: back off rather than burn the
            // core. Short enough not to matter against a throttle's ~128 ms.
            if (!progressed && d_config.backoff)
                std::this_thread::sleep_for(std::chrono::microseconds(200));
        }
        // entries unwinds here, and every block_executor destructor calls its
        // block's stop().
        //
        // A budgeted run ends here of its own accord, with the graph simply
        // stopping. Nothing is posted to the editor from this thread: `window`
        // does not exist on a pthread, and the proxying MAIN_THREAD_EM_ASM form
        // would deadlock against run_now()'s teardown, which joins this thread
        // from the browser main thread. Frozen item counters are the signal.
    }
};

} // namespace detail

// How many complete passes over the block list a deterministic run makes before
// it stops, and how many items each work() call is capped at.
//
// The budget is what gives the run a reproducible *end*: without it you would be
// comparing two runs sampled at some wall-clock moment, which is the one thing
// determinism cannot survive. There is no budget that suits every graph -- 1000
// rounds is well under a second for a chain of Multiply Const and far too much
// for a 10001-tap FIR -- so it is a knob (`runner.html?rounds=N`), not a
// constant to tune. See docs/schedulers.md.
inline constexpr long long kDeterministicRoundsDefault = 1000;
inline constexpr int kDeterministicNoutputItems = 4096;

// Set from ?rounds= before the scheduler is made. A free function over a
// function-local static rather than a plugin field, because the plugin table is
// const and the value arrives from the URL, which is the runner's business.
inline long long& deterministic_rounds() {
    static long long rounds = kDeterministicRoundsDefault;
    return rounds;
}

class round_robin_scheduler : public gr::scheduler
{
    gr::thread::thread_group d_threads;
    std::shared_ptr<std::atomic<bool>> d_stop;

protected:
    round_robin_scheduler(gr::flat_flowgraph_sptr ffg,
                          int max_noutput_items,
                          bool catch_exceptions,
                          detail::round_robin_config config,
                          const char* thread_name)
        : gr::scheduler(ffg, max_noutput_items, catch_exceptions),
          d_stop(std::make_shared<std::atomic<bool>>(false))
    {
        // The same topologically sorted list TPB builds (scheduler_tpb.cc). The
        // order matters more here than it does there: one thread walking the
        // graph source-to-sink moves a sample the whole way in a single round.
        gr::basic_block_vector_t used = ffg->calc_used_blocks();
        used = ffg->topological_sort(used);
        gr::block_vector_t blocks = gr::flat_flowgraph::make_block_vector(used);

        for (const auto& b : blocks)
            b->detail()->set_done(false);

        // thread_body_wrapper is not optional: it is what catches an exception
        // out of a block's work() and logs it, which BrowserLogSink in
        // runner.cpp mirrors into the editor console. Without it a throwing
        // block looks like a graph that simply produces nothing.
        d_threads.create_thread(gr::thread::thread_body_wrapper<detail::round_robin_body>(
            detail::round_robin_body(std::move(blocks), max_noutput_items, config, d_stop),
            thread_name,
            catch_exceptions));
    }

public:
    // The single-threaded scheduler: run indefinitely, exactly as TPB does, with
    // GNU Radio's own noutput_items rules.
    static gr::scheduler_sptr
    make_sts(gr::flat_flowgraph_sptr ffg, int max_noutput_items, bool catch_exceptions)
    {
        return gr::scheduler_sptr(new round_robin_scheduler(
            ffg, max_noutput_items, catch_exceptions,
            detail::round_robin_config{ /*fixed_noutput_items=*/0,
                                        /*round_budget=*/0,
                                        /*backoff=*/true },
            "single-threaded scheduler"));
    }

    // The deterministic scheduler: the same fixed interleaving, plus the two
    // things that make a run repeat itself -- a constant chunk size, so every
    // work() call sees the same boundaries whatever the buffer allocator did,
    // and a round budget, so the run ends at the same place rather than
    // wherever the wall clock left it. The idle backoff is off for the same
    // reason: a sleep would let elapsed time decide how much work a run gets
    // through.
    static gr::scheduler_sptr
    make_deterministic(gr::flat_flowgraph_sptr ffg, int max_noutput_items, bool catch_exceptions)
    {
        return gr::scheduler_sptr(new round_robin_scheduler(
            ffg, max_noutput_items, catch_exceptions,
            detail::round_robin_config{ kDeterministicNoutputItems,
                                        deterministic_rounds(),
                                        /*backoff=*/false },
            "deterministic scheduler"));
    }

    ~round_robin_scheduler() override
    {
        stop();
        wait();
    }

    void stop() override
    {
        d_stop->store(true, std::memory_order_relaxed);
        // Matches TPB: a block waiting at an interruption point leaves through
        // the same door. A block waiting on a futex inside work() does not --
        // see blocks_in_work().
        d_threads.interrupt_all();
    }

    void wait() override { d_threads.join_all(); }
};

// ---- the registry ---------------------------------------------------------

struct plugin {
    const char* name;
    const char* label;
    gr::scheduler_sptr (*make)(gr::flat_flowgraph_sptr ffg,
                               int max_noutput_items,
                               bool catch_exceptions);
    // How many threads this scheduler will actually create for a graph of
    // nblocks primitive blocks. The runner sizes the prewarmed Web Worker pool
    // from this; TPB's answer is the block count, and it used to be hardcoded.
    int (*thread_estimate)(int nblocks);
    // The run repeats itself exactly, given the same flowgraph -- which also
    // means a block whose output depends on the wall clock voids the guarantee.
    // The runner warns about those; see wall_clock_block().
    bool deterministic;
};

inline const std::vector<plugin>& plugins() {
    static const std::vector<plugin> table = {
        { "tpb", "thread-per-block", &gr::scheduler_tpb::make,
          [](int nblocks) { return nblocks; }, false },
        { "sts", "single-threaded", &round_robin_scheduler::make_sts,
          [](int) { return 1; }, false },
        { "det", "deterministic", &round_robin_scheduler::make_deterministic,
          [](int) { return 1; }, true },
    };
    return table;
}

inline const plugin& default_plugin() { return plugins().front(); }

// An unrecognised name falls back to the default rather than failing the run --
// a .grc written against a newer build should still work. The caller logs it.
inline const plugin* find(const std::string& name) {
    for (const auto& p : plugins())
        if (name == p.name) return &p;
    return nullptr;
}

inline const plugin& select(const std::string& name) {
    if (name.empty()) return default_plugin();
    const plugin* p = find(name);
    return p ? *p : default_plugin();
}

} // namespace runner_sched
