#include "websocket_sink.hpp"

#include <emscripten.h>
#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cstring>
#include <stdexcept>
#include <utility>

WebSocketSink::sptr WebSocketSink::make(const std::string& url, std::size_t item_size)
{
    return sptr(new WebSocketSink(url, item_size));
}

WebSocketSink::WebSocketSink(std::string url, std::size_t item_size)
    : gr::sync_block("websocket_sink",
                     gr::io_signature::make(1, 1, item_size),
                     gr::io_signature::make(0, 0, 0)),
      d_url(std::move(url)),
      d_item_size(item_size)
{
    if (!d_item_size)
        throw std::runtime_error("WebSocket Sink item size must be positive");
    if (d_url.empty())
        throw std::runtime_error("WebSocket Sink: no URL given");

    d_capacity_items = std::max<std::size_t>(2, RING_BYTES / d_item_size);
    if (d_capacity_items > static_cast<std::size_t>(INT32_MAX))
        d_capacity_items = INT32_MAX;
    d_ring.resize(d_capacity_items * d_item_size);
}

// Not stop(): a sink being destroyed without having been stopped has nothing
// worth draining -- the socket is just closed. Mirrors BrowserFileSink.
WebSocketSink::~WebSocketSink() { cancel(); }

std::int32_t WebSocketSink::load(const std::int32_t* value) const
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void WebSocketSink::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void WebSocketSink::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

bool WebSocketSink::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.state, INITIAL);

    // As in WebSocketSource: start() runs on a scheduler pthread and proxies
    // only this short worker-launch to the browser main thread. work() never
    // proxies -- doing so would queue the whole flowgraph behind Qt's event loop.
    d_writer_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartWebSocketSink(
                UTF8ToString($0), wasmMemory, $1 >>> 0, $2, $3, $4 >>> 0, $5 >>> 0);
        } catch (error) {
            console.error("WebSocket Sink launch failed:", error);
            return 0;
        }
    },
                                          d_url.c_str(),
                                          d_ring.data(),
                                          static_cast<int>(d_capacity_items),
                                          static_cast<int>(d_item_size),
                                          &d_control,
                                          d_error);
    if (!d_writer_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start WebSocket writer");
    }
    return true;
}

void WebSocketSink::cancel()
{
    const int writer_id = d_writer_id;
    if (!writer_id)
        return;
    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({ window.__grStopWebSocketSink($0); }, writer_id);
    d_writer_id = 0;
}

bool WebSocketSink::stop()
{
    const int writer_id = d_writer_id;
    if (!writer_id)
        return true;

    store(&d_control.state, FINISHING);
    wake(&d_control.write_pos);

    // Wait for the worker to drain the ring and close the socket. Without this
    // the tab can move on -- or the next run can start -- with the tail of the
    // stream still sitting in shared memory.
    const double deadline = emscripten_get_now() + FINISH_TIMEOUT_MS;
    while (true) {
        const auto state = load(&d_control.state);
        if (state == CLOSED || state == ERROR || state == CANCELLED)
            break;
        if (emscripten_get_now() >= deadline) {
            d_logger->error("WebSocket Sink: writer did not finish within {}s; "
                            "the tail of the stream may not have been sent",
                            FINISH_TIMEOUT_MS / 1000);
            break;
        }
        emscripten_futex_wait(&d_control.state, state, 50.0);
    }

    const bool failed = load(&d_control.state) == ERROR;
    const std::string message = failed ? writer_error() : std::string();

    d_writer_id = 0;
    MAIN_THREAD_EM_ASM({ window.__grStopWebSocketSink($0); }, writer_id);

    // Reported rather than thrown: stop() runs while the flowgraph is already
    // coming down, where an exception is swallowed.
    if (failed)
        d_logger->error("WebSocket Sink: {}", message);
    return true;
}

std::string WebSocketSink::writer_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("WebSocket writer failed");
}

int WebSocketSink::work(int noutput_items,
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
        // unambiguously "empty". Matches websocket_writer.js exactly.
        const std::size_t free_items = d_capacity_items - used - 1;

        if (!free_items) {
            // A sink owns its scheduler pthread. Blocking here backpressures the
            // graph onto how fast the socket can actually drain -- see the
            // bufferedAmount note in websocket_sink.hpp.
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

    // Nothing accepted and nothing to wait for: the writer is gone, so the
    // graph has nothing left to do here.
    return consumed ? consumed : WORK_DONE;
}
