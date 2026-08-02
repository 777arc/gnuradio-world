#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// A browser-backed rebuild of gr-paint's `image_source` ("Image File Source").
//
// Upstream is a Python gr.sync_block that decodes an image with PIL and emits
// one monochrome line per work() call for the Spectrum Painter to paint into a
// waterfall. There is no PIL here and no filesystem either, so this block names
// its image with a URL and lets the browser decode it: fetch + createImageBitmap
// + an OffscreenCanvas, then the same grayscale / autocontrast / invert /
// BT.709 pipeline the Python does, in JS (see __grLoadImageSource in
// runner.html).
//
// The decode is asynchronous and block construction runs on the browser main
// thread, so the constructor only *starts* it; the wait happens in work(), on
// this source's own scheduler thread, where blocking stalls nothing else.
class ImageSourceWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<ImageSourceWasm>;

    // Matches gr-paint's `repeatmode` parameter.
    enum RepeatMode : int {
        ONCE = 0,           // one pass, then WORK_DONE
        REPEAT = 1,         // loop over the decoded image forever
        REPEAT_RELOAD = 2,  // re-fetch the URL at the top of every pass
    };

    static sptr make(const std::string& url,
                     bool flip,
                     bool bt709_map,
                     bool invert,
                     bool autocontrast,
                     int repeat_mode);

    ~ImageSourceWasm() override;

    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    ImageSourceWasm(std::string url,
                    bool flip,
                    bool bt709_map,
                    bool invert,
                    bool autocontrast,
                    int repeat_mode);

    enum State : std::int32_t {
        LOADING = 0,
        READY = 1,
        FAILED = 2,
    };

    // Written by the browser decode job, read (and waited on) from the
    // scheduler thread. Both see the same shared WebAssembly.Memory.
    struct alignas(4) Control {
        std::int32_t state = LOADING;
        std::int32_t width = 0;
        std::int32_t height = 0;
        std::int32_t error_length = 0;
    };

    // The Spectrum Painter's own limit is width < 4097, so a wider image is
    // scaled down to fit rather than rejected -- what the Python block does.
    static constexpr std::int32_t MAX_WIDTH = 4096;
    // A decoded image is one byte per pixel held in WASM memory for the life of
    // the flowgraph; refuse an image large enough to exhaust the heap instead.
    static constexpr std::size_t MAX_PIXELS = 64u * 1024u * 1024u;
    static constexpr std::size_t ERROR_BYTES = 512;

    void begin_load();
    void await_load();
    void release_load();
    std::string load_error() const;

    std::string d_url;
    bool d_flip;
    bool d_bt709_map;
    bool d_invert;
    bool d_autocontrast;
    int d_repeat_mode;

    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_load_id = 0;

    std::vector<unsigned char> d_pixels;
    int d_width = 0;
    int d_height = 0;
    int d_row = 0;   // line being emitted
    int d_col = 0;   // byte reached within that line
    bool d_exhausted = false;
    bool d_announced = false;

    pmt::pmt_t d_width_key;
    pmt::pmt_t d_line_key;
    pmt::pmt_t d_tag_source;
};
