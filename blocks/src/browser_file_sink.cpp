#include "browser_file_sink.hpp"

#include <emscripten.h>
#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cstring>
#include <stdexcept>
#include <utility>

BrowserFileSink::sptr BrowserFileSink::make(std::size_t item_size, const std::string& path)
{
    return sptr(new BrowserFileSink("browser_file_sink", item_size, path));
}

BrowserFileSink::BrowserFileSink(const std::string& name,
                                 std::size_t item_size,
                                 std::string path)
    : gr::sync_block(name,
                     gr::io_signature::make(1, 1, item_size),
                     gr::io_signature::make(0, 0, 0)),
      d_item_size(item_size),
      d_path(std::move(path))
{
    if (!d_item_size)
        throw std::runtime_error("File Sink item size must be positive");
    if (d_path.empty())
        throw std::runtime_error("File Sink has no output bound in this session");

    d_capacity_items = std::max<std::size_t>(2, RING_BYTES / d_item_size);
    if (d_capacity_items > static_cast<std::size_t>(INT32_MAX))
        d_capacity_items = INT32_MAX;
    d_ring.resize(d_capacity_items * d_item_size);
}

// Not stop(): stop() finalizes the recording through a virtual, and a virtual
// call from a destructor would reach the base's version. A sink being destroyed
// without having been stopped has nothing worth finalizing anyway.
BrowserFileSink::~BrowserFileSink() { cancel(); }

std::int32_t BrowserFileSink::load(const std::int32_t* value) const
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void BrowserFileSink::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void BrowserFileSink::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

bool BrowserFileSink::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.state, INITIAL);
    d_items_written = 0;

    // As in BrowserFileSource: start() runs on a scheduler pthread and proxies
    // only this short worker-launch to the browser main thread. work() never
    // proxies -- doing so would queue the whole flowgraph behind Qt's event loop.
    d_writer_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartBrowserFileSink(
                UTF8ToString($0), wasmMemory, $1 >>> 0, $2, $3, $4 >>> 0, $5 >>> 0);
        } catch (error) {
            console.error("File Sink writer launch failed:", error);
            return 0;
        }
    },
                                          d_path.c_str(),
                                          d_ring.data(),
                                          static_cast<int>(d_capacity_items),
                                          static_cast<int>(d_item_size),
                                          &d_control,
                                          d_error);
    if (!d_writer_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start browser file writer");
    }
    return true;
}

void BrowserFileSink::cancel()
{
    const int writer_id = d_writer_id;
    if (!writer_id)
        return;
    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({ window.__grStopBrowserFileSink($0); }, writer_id);
    d_writer_id = 0;
}

bool BrowserFileSink::stop()
{
    const int writer_id = d_writer_id;
    if (!writer_id)
        return true;

    // The trailing metadata, built now because only now are the samples counted
    // and the tags all seen. Collected before the state flips so the worker
    // never sees FINISHING without the payload already on its way.
    const std::string payload = finish_payload();

    MAIN_THREAD_EM_ASM(
        { window.__grFinishBrowserFileSink($0, UTF8ToString($1)); },
        writer_id,
        payload.c_str());

    store(&d_control.state, FINISHING);
    wake(&d_control.write_pos);

    // Wait for the worker to drain the ring and close the file. Without this the
    // tab can be navigated away from -- or the next run started -- with the tail
    // of the recording still in shared memory.
    const double deadline = emscripten_get_now() + FINISH_TIMEOUT_MS;
    while (true) {
        const auto state = load(&d_control.state);
        if (state == CLOSED || state == ERROR || state == CANCELLED)
            break;
        if (emscripten_get_now() >= deadline) {
            // gr::logger takes a compile-time fmt string, so anything runtime
            // goes through an argument rather than into the literal.
            d_logger->error("SigMF Sink: writer did not finish within {}s; "
                            "the recording may be truncated",
                            FINISH_TIMEOUT_MS / 1000);
            break;
        }
        emscripten_futex_wait(&d_control.state, state, 50.0);
    }

    const bool failed = load(&d_control.state) == ERROR;
    const std::string message = failed ? writer_error() : std::string();

    d_writer_id = 0;
    MAIN_THREAD_EM_ASM({ window.__grStopBrowserFileSink($0); }, writer_id);

    // Reported rather than thrown: stop() runs while the flowgraph is already
    // coming down, where an exception is swallowed. BrowserLogSink puts this in
    // the editor's console pane, which is where a reader would look.
    if (failed)
        d_logger->error("SigMF Sink: {}", message);
    return true;
}

std::string BrowserFileSink::writer_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("browser file writer failed");
}

int BrowserFileSink::work(int noutput_items,
                          gr_vector_const_void_star& input_items,
                          gr_vector_void_star&)
{
    const auto* input = static_cast<const unsigned char*>(input_items[0]);
    int consumed = 0;

    while (consumed < noutput_items) {
        const auto state = load(&d_control.state);
        if (state == ERROR)
            throw std::runtime_error(writer_error());
        if (state == CANCELLED || state == CLOSED)
            break;

        const auto read_pos = load(&d_control.read_pos);
        const auto write_pos = load(&d_control.write_pos);
        const std::size_t used =
            write_pos >= read_pos
                ? static_cast<std::size_t>(write_pos - read_pos)
                : d_capacity_items - static_cast<std::size_t>(read_pos - write_pos);
        // One slot is always left empty, so write_pos == read_pos is
        // unambiguously "empty". This matches browser_file_reader.js exactly.
        const std::size_t free_items = d_capacity_items - used - 1;

        if (!free_items) {
            // A sink owns its scheduler pthread. Blocking here backpressures the
            // graph onto the speed of the write, which is what keeps a recording
            // complete; a live source upstream will drop for itself.
            emscripten_futex_wait(&d_control.read_pos, read_pos, 100.0);
            continue;
        }

        const std::size_t until_wrap = d_capacity_items - write_pos;
        const auto take = static_cast<std::size_t>(
            std::min({ free_items,
                       static_cast<std::size_t>(noutput_items - consumed),
                       until_wrap }));

        std::memcpy(d_ring.data() + static_cast<std::size_t>(write_pos) * d_item_size,
                    input + static_cast<std::size_t>(consumed) * d_item_size,
                    take * d_item_size);
        consumed += static_cast<int>(take);

        const auto next_write =
            static_cast<std::int32_t>((static_cast<std::size_t>(write_pos) + take) %
                                      d_capacity_items);
        store(&d_control.write_pos, next_write);
        wake(&d_control.write_pos);
    }

    if (consumed) {
        // Still inside work(), so nitems_read(0) is the offset of input[0] and
        // get_tags_in_window() addresses the accepted range from zero.
        on_written(nitems_read(0), consumed);
        d_items_written += static_cast<std::uint64_t>(consumed);
    }
    // Nothing accepted and nothing to wait for: the writer is gone, so the graph
    // has nothing left to do here.
    return consumed ? consumed : WORK_DONE;
}
