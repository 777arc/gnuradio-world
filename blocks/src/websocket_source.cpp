#include "websocket_source.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cstring>
#include <stdexcept>
#include <utility>

WebSocketSource::sptr WebSocketSource::make(const std::string& url, std::size_t item_size)
{
    return sptr(new WebSocketSource(url, item_size));
}

WebSocketSource::WebSocketSource(std::string url, std::size_t item_size)
    : gr::sync_block("websocket_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(1, 1, item_size)),
      d_url(std::move(url)),
      d_item_size(item_size)
{
    if (!d_item_size)
        throw std::runtime_error("WebSocket Source item size must be positive");
    if (d_url.empty())
        throw std::runtime_error("WebSocket Source: no URL given");

    d_capacity_items = std::max<std::size_t>(2, RING_BYTES / d_item_size);
    if (d_capacity_items > static_cast<std::size_t>(INT32_MAX))
        d_capacity_items = INT32_MAX;
    d_ring.resize(d_capacity_items * d_item_size);
}

WebSocketSource::~WebSocketSource() { stop(); }

std::int32_t WebSocketSource::load(const std::int32_t* value) const
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void WebSocketSource::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void WebSocketSource::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

bool WebSocketSource::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.state, INITIAL);
    store(&d_control.overruns, 0);
    store(&d_control.dropped_items, 0);

    // top_block::run() invokes start() from a pthread. Proxy only this short
    // worker-launch operation to the browser main thread; work() never proxies.
    d_reader_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartWebSocketSource(
                UTF8ToString($0),
                wasmMemory,
                $1 >>> 0,
                $2,
                $3,
                $4 >>> 0,
                $5 >>> 0);
        } catch (error) {
            console.error("WebSocket Source launch failed:", error);
            return 0;
        }
    },
                                                   d_url.c_str(),
                                                   d_ring.data(),
                                                   static_cast<int>(d_capacity_items),
                                                   static_cast<int>(d_item_size),
                                                   &d_control,
                                                   d_error);
    if (!d_reader_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start WebSocket reader");
    }
    return true;
}

bool WebSocketSource::stop()
{
    const int reader_id = d_reader_id;
    if (!reader_id)
        return true;

    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({
        window.__grStopWebSocketSource($0);
    }, reader_id);
    d_reader_id = 0;
    return true;
}

std::string WebSocketSource::reader_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("WebSocket reader failed");
}

int WebSocketSource::work(int noutput_items,
                          gr_vector_const_void_star&,
                          gr_vector_void_star& output_items)
{
    auto* output = static_cast<unsigned char*>(output_items[0]);
    int produced = 0;

    while (produced < noutput_items) {
        const auto read_pos = load(&d_control.read_pos);
        const auto write_pos = load(&d_control.write_pos);
        const std::size_t available =
            write_pos >= read_pos
                ? static_cast<std::size_t>(write_pos - read_pos)
                : d_capacity_items - static_cast<std::size_t>(read_pos - write_pos);

        if (!available) {
            const auto state = load(&d_control.state);
            if (state == EOF_REACHED)
                return produced ? produced : WORK_DONE;
            if (state == ERROR)
                throw std::runtime_error(reader_error());
            if (state == CANCELLED)
                return produced ? produced : WORK_DONE;

            // A source owns its scheduler pthread, so blocking it while the
            // browser reader waits for the next message does not stall any
            // other block.
            emscripten_futex_wait(&d_control.write_pos, write_pos, 100.0);
            continue;
        }

        const std::size_t until_wrap = d_capacity_items - read_pos;
        const auto take = static_cast<std::size_t>(std::min<std::uint64_t>(
            { static_cast<std::uint64_t>(available),
              static_cast<std::uint64_t>(noutput_items - produced),
              static_cast<std::uint64_t>(until_wrap) }));

        std::memcpy(output + static_cast<std::size_t>(produced) * d_item_size,
                    d_ring.data() + static_cast<std::size_t>(read_pos) * d_item_size,
                    take * d_item_size);
        produced += static_cast<int>(take);

        const auto next_read =
            static_cast<std::int32_t>((static_cast<std::size_t>(read_pos) + take) %
                                      d_capacity_items);
        store(&d_control.read_pos, next_read);
        wake(&d_control.read_pos);
    }
    return produced;
}
