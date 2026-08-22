#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// A browser-backed file sink: the mirror image of BrowserFileSource.
//
// Emscripten's filesystem is in-memory, so bytes written through it vanish with
// the tab; a recording has to reach the browser instead. This block hands its
// input to a dedicated Web Worker through a fixed-size ring in shared WASM
// memory, exactly as the source takes its input from one, and the worker either
// streams it to a file the reader chose with the File System Access API or
// (where that API does not exist) buffers it and downloads it at the end.
//
// Unlike the source, a full ring here *blocks* rather than dropping. That is the
// right behaviour for a file: a sink owns its own scheduler pthread, so stalling
// it backpressures the flowgraph instead of quietly losing samples, and losing
// samples is the one thing a recording must not do.
class BrowserFileSink : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<BrowserFileSink>;

    static sptr make(std::size_t item_size, const std::string& path);

    ~BrowserFileSink() override;

    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    // How many items have reached the ring. A subclass writing metadata needs
    // it for the recording's sample count.
    std::uint64_t items_written() const { return d_items_written; }

protected:
    BrowserFileSink(const std::string& name, std::size_t item_size, std::string path);

    // The trailing payload handed to the worker when the flowgraph stops -- for
    // SigMF Sink, the .sigmf-meta text, which cannot exist before then because
    // it counts the samples and collects the tags. Empty means "nothing to
    // write besides the data".
    virtual std::string finish_payload() { return {}; }

    // The items just accepted into the ring, at their absolute stream offset.
    // Called from work() before the scheduler consumes them, so
    // get_tags_in_window() still addresses them from zero.
    virtual void on_written(std::uint64_t /*item_start*/, int /*count*/) {}

private:
    enum State : std::int32_t {
        INITIAL = 0,
        RUNNING = 1,
        FINISHING = 2,   // no more samples; drain what is there and close
        ERROR = 3,
        CANCELLED = 4,
        CLOSED = 5,      // the worker has finished writing
    };

    struct alignas(4) Control {
        std::int32_t read_pos = 0;   // item index within the ring
        std::int32_t write_pos = 0;  // item index within the ring
        std::int32_t state = INITIAL;
        std::int32_t error_length = 0;
    };

    static constexpr std::size_t RING_BYTES = 16 * 1024 * 1024;
    static constexpr std::size_t ERROR_BYTES = 512;
    // How long stop() gives the worker to drain the ring and close the file
    // before giving up on it. A local write is fast; this is only a bound on how
    // long a stuck worker can hold the Stop button.
    static constexpr int FINISH_TIMEOUT_MS = 15000;

    std::size_t d_item_size;
    std::string d_path;
    std::uint64_t d_items_written = 0;

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
