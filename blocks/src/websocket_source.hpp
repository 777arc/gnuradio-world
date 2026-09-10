#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// A WebSocket-backed live source. A dedicated Web Worker owns the connection
// (`runner/src/websocket_reader.js`) and writes complete GNU Radio items into
// this block's fixed-size shared-memory ring; work() drains that ring on the
// block's own scheduler pthread, exactly as BrowserFileSource does for a local
// file. Two differences follow from the socket being live rather than seekable:
//
// - a full ring **drops** the incoming message rather than waiting, the same
//   choice RtlSdrSource makes and for the same reason: the remote end cannot be
//   told to slow down, so blocking here would only move the loss into the
//   worker's own message queue, where it goes unreported;
// - the far end closing the connection ends the stream (WORK_DONE), the same
//   as reaching end of file. There is no reconnect: a dropped connection is
//   reported once, not retried underneath the flowgraph.
class WebSocketSource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<WebSocketSource>;

    static sptr make(const std::string& url, std::size_t item_size);

    ~WebSocketSource() override;

    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    WebSocketSource(std::string url, std::size_t item_size);

    enum State : std::int32_t {
        INITIAL = 0,
        RUNNING = 1,
        EOF_REACHED = 2,
        ERROR = 3,
        CANCELLED = 4,
    };

    // Shared with websocket_reader.js as an Int32Array. Field order must match
    // the CTRL_* indices there.
    struct alignas(4) Control {
        std::int32_t read_pos = 0;      // block  -> worker, items into ring
        std::int32_t write_pos = 0;     // worker -> block
        std::int32_t state = INITIAL;
        std::int32_t error_length = 0;
        std::int32_t overruns = 0;      // worker -> block, messages dropped
        std::int32_t dropped_items = 0; // worker -> block
    };

    static constexpr std::size_t RING_BYTES = 16 * 1024 * 1024;
    static constexpr std::size_t ERROR_BYTES = 512;

    std::string d_url;
    std::size_t d_item_size;

    std::size_t d_capacity_items;
    std::vector<unsigned char> d_ring;
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_reader_id = 0;

    std::int32_t load(const std::int32_t* value) const;
    void store(std::int32_t* value, std::int32_t next);
    void wake(std::int32_t* value);
    std::string reader_error() const;
};
