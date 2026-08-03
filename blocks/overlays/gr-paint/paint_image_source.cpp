#include "paint_image_source.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <utility>

namespace {

std::int32_t load_i32(const std::int32_t* value)
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

} // namespace

ImageSourceWasm::sptr ImageSourceWasm::make(const std::string& url,
                                            bool flip,
                                            bool bt709_map,
                                            bool invert,
                                            bool autocontrast,
                                            int repeat_mode)
{
    return sptr(new ImageSourceWasm(
        url, flip, bt709_map, invert, autocontrast, repeat_mode));
}

ImageSourceWasm::ImageSourceWasm(std::string url,
                                 bool flip,
                                 bool bt709_map,
                                 bool invert,
                                 bool autocontrast,
                                 int repeat_mode)
    : gr::sync_block("image_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(1, 1, sizeof(unsigned char))),
      d_url(std::move(url)),
      d_flip(flip),
      d_bt709_map(bt709_map),
      d_invert(invert),
      d_autocontrast(autocontrast),
      d_repeat_mode(repeat_mode),
      d_width_key(pmt::string_to_symbol("image_width")),
      d_line_key(pmt::string_to_symbol("line_num"))
{
    if (d_url.empty())
        throw std::runtime_error(
            "Image File Source needs an image: choose one with Properties > "
            "Browse, or type a URL (for example /example_images/gnuradio_logo.png)");
    if (d_repeat_mode < ONCE || d_repeat_mode > REPEAT_RELOAD)
        throw std::runtime_error("Image File Source repeat mode must be 0, 1 or 2");

    d_tag_source =
        pmt::string_to_symbol("image_source" + std::to_string(unique_id()));

    // Start the fetch now so it overlaps the rest of the flowgraph's
    // construction; work() is where the result is waited for.
    begin_load();
}

ImageSourceWasm::~ImageSourceWasm() { release_load(); }

bool ImageSourceWasm::stop()
{
    release_load();
    return true;
}

void ImageSourceWasm::begin_load()
{
    release_load();
    __atomic_store_n(&d_control.width, 0, __ATOMIC_RELAXED);
    __atomic_store_n(&d_control.height, 0, __ATOMIC_RELAXED);
    __atomic_store_n(&d_control.error_length, 0, __ATOMIC_RELAXED);
    __atomic_store_n(&d_control.state, LOADING, __ATOMIC_RELEASE);

    // The decode needs the browser main thread (createImageBitmap and
    // OffscreenCanvas are reached through it here). Construction already runs
    // there; a REPEAT_RELOAD pass calls this from the scheduler thread, where
    // MAIN_THREAD_EM_ASM proxies and returns once the job has been *started* --
    // it is the promise inside that is asynchronous.
    d_load_id = MAIN_THREAD_EM_ASM_INT(
        {
            try {
                return window.__grLoadImageSource(UTF8ToString($0),
                                                  wasmMemory,
                                                  $1,
                                                  $2,
                                                  $3,
                                                  $4,
                                                  $5,
                                                  !!$6,
                                                  !!$7,
                                                  !!$8,
                                                  !!$9);
            } catch (error) {
                console.error("Image File Source load failed:", error);
                return 0;
            }
        },
        d_url.c_str(),
        &d_control,
        d_error,
        static_cast<int>(ERROR_BYTES),
        static_cast<int>(MAX_WIDTH),
        static_cast<int>(MAX_PIXELS),
        d_flip ? 1 : 0,
        d_bt709_map ? 1 : 0,
        d_invert ? 1 : 0,
        d_autocontrast ? 1 : 0);

    if (!d_load_id) {
        // Leave a terminal state behind: a later await_load() would otherwise
        // wait on a job that was never started.
        __atomic_store_n(&d_control.state, FAILED, __ATOMIC_RELEASE);
        throw std::runtime_error("could not start the browser image decoder");
    }
}

void ImageSourceWasm::release_load()
{
    const int load_id = d_load_id;
    if (!load_id)
        return;
    d_load_id = 0;
    MAIN_THREAD_EM_ASM({ window.__grReleaseImageSource($0); }, load_id);
}

std::string ImageSourceWasm::load_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load_i32(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("the image could not be decoded");
}

void ImageSourceWasm::await_load()
{
    // A source owns its scheduler pthread, so waiting here holds up nothing
    // else. The decode job wakes this futex; the timeout only bounds the wait
    // if the page is torn down underneath us.
    while (load_i32(&d_control.state) == LOADING)
        emscripten_futex_wait(&d_control.state, LOADING, 100.0);

    if (load_i32(&d_control.state) != READY)
        throw std::runtime_error("Image File Source: " + load_error());

    d_width = load_i32(&d_control.width);
    d_height = load_i32(&d_control.height);
    if (d_width <= 0 || d_height <= 0)
        throw std::runtime_error("Image File Source: the image has no pixels");

    d_pixels.resize(static_cast<std::size_t>(d_width) *
                    static_cast<std::size_t>(d_height));
    const int copied = MAIN_THREAD_EM_ASM_INT(
        { return window.__grTakeImageSource($0, wasmMemory, $1, $2) ? 1 : 0; },
        d_load_id,
        d_pixels.data(),
        static_cast<int>(d_pixels.size()));
    d_load_id = 0;  // the decode job hands its pixels over exactly once
    if (!copied)
        throw std::runtime_error("Image File Source: the decoded image was lost");

    d_row = 0;
    d_col = 0;

    // The Spectrum Painter downstream needs this width typed into its own
    // "Image Width" parameter, so say it out loud. runner.html forwards stdout
    // to the editor's console pane. Upstream prints this on every re-read; once
    // is enough, and a REPEAT_RELOAD source re-reads continuously.
    if (!d_announced) {
        d_announced = true;
        std::printf("paint.image_source: %d bytes, %dpx width\n",
                    static_cast<int>(d_pixels.size()),
                    d_width);
        std::fflush(stdout);
    }
}

int ImageSourceWasm::work(int noutput_items,
                          gr_vector_const_void_star&,
                          gr_vector_void_star& output_items)
{
    if (d_exhausted)
        return WORK_DONE;
    if (d_pixels.empty())
        await_load();

    auto* output = static_cast<unsigned char*>(output_items[0]);
    int produced = 0;

    while (produced < noutput_items) {
        if (d_row >= d_height) {
            if (d_repeat_mode == ONCE) {
                d_exhausted = true;
                return produced ? produced : WORK_DONE;
            }
            if (d_repeat_mode == REPEAT_RELOAD) {
                // Hand back what is already in the output buffer first: the
                // re-fetch blocks this thread on the network. d_row is left
                // past the end, so the next call comes straight back here.
                if (produced)
                    return produced;
                d_pixels.clear();
                begin_load();
                await_load();  // rewinds to the top of the new image
            } else {
                d_row = 0;
            }
        }

        // Upstream tags the first sample of every line. The Spectrum Painter
        // reads neither tag -- it takes the width from its own parameter -- but
        // they are what makes a line boundary visible to anything downstream.
        if (d_col == 0) {
            const auto offset = nitems_written(0) + produced;
            add_item_tag(0, offset, d_width_key, pmt::from_long(d_width), d_tag_source);
            add_item_tag(0, offset, d_line_key, pmt::from_long(d_row), d_tag_source);
        }

        const int take = std::min(noutput_items - produced, d_width - d_col);
        std::memcpy(output + produced,
                    d_pixels.data() +
                        static_cast<std::size_t>(d_row) * d_width + d_col,
                    static_cast<std::size_t>(take));
        produced += take;
        d_col += take;
        if (d_col == d_width) {
            d_col = 0;
            ++d_row;
        }
    }
    return produced;
}
