#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// A WebSocket-backed sink: hands its input to a dedicated Web Worker
// (`runner/src/websocket_writer.js`) through a fixed-size ring in shared WASM
// memory, exactly as BrowserFileSink does for a local file, and sends it out
// over the socket as binary messages.
//
// Unlike WebSocketSource, a full ring here *blocks* rather than dropping: a
// sink owns its own scheduler pthread, so stalling it backpressures the
// flowgraph instead of quietly losing samples. The worker uses the socket's own
// `bufferedAmount` as its flow-control signal -- it holds off draining the ring
// while the socket's send queue is already deep, which is what makes the block
// backpressure onto how fast the remote end can actually receive rather than
// just how fast this tab can call send().
class WebSocketSink : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<WebSocketSink>;

    static sptr make(const std::string& url, std::size_t item_size);

    ~WebSocketSink() override;

    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    WebSocketSink(std::string url, std::size_t item_size);

    enum State : std::int32_t {
        INITIAL = 0,
        RUNNING = 1,
        FINISHING = 2,   // no more samples; drain what is there and close
        ERROR = 3,
        CANCELLED = 4,
        CLOSED = 5,      // the worker has closed the socket
    };

    struct alignas(4) Control {
        std::int32_t read_pos = 0;   // worker -> block (item index)
        std::int32_t write_pos = 0;  // block  -> worker
        std::int32_t state = INITIAL;
        std::int32_t error_length = 0;
    };

    static constexpr std::size_t RING_BYTES = 16 * 1024 * 1024;
    static constexpr std::size_t ERROR_BYTES = 512;
    // How long stop() gives the worker to drain the ring and close the socket
    // before giving up on it. A bound on how long a stuck peer can hold the
    // Stop button, not an expected duration.
    static constexpr int FINISH_TIMEOUT_MS = 5000;

    std::string d_url;
    std::size_t d_item_size;

    std::size_t d_capacity_items;
    std::vector<unsigned char> d_ring;
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_writer_id = 0;

    std::int32_t load(const std::int32_t* value) const;
    void store(std::int32_t* value, std::int32_t next);
    void wake(std::int32_t* value);
    void cancel();
    std::string writer_error() const;
};
