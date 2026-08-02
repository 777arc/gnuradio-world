#include "browser_file_source.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cstring>
#include <stdexcept>
#include <utility>

namespace {

// Browser input descriptors are installed by runner.html before Qt/WASM starts.
// File.size and the manifest's remote byte length are exact JS integers for all
// practical recordings (up to Number.MAX_SAFE_INTEGER). Transfer the value as
// two i32s: an EM_JS double return is narrowed to i32 in this MAIN_MODULE build.
EM_JS(int, browser_input_size_low, (const char* filename), {
    const path = UTF8ToString(filename);
    const source = window.__grInputSources && window.__grInputSources[path];
    return source && Number.isSafeInteger(source.size) ? source.size >>> 0 : 0;
});

EM_JS(int, browser_input_size_high, (const char* filename), {
    const path = UTF8ToString(filename);
    const source = window.__grInputSources && window.__grInputSources[path];
    return source && Number.isSafeInteger(source.size)
        ? Math.floor(source.size / 4294967296)
        : -1;
});

} // namespace

BrowserFileSource::sptr BrowserFileSource::make(std::size_t item_size,
                                                const std::string& path,
                                                bool repeat,
                                                std::uint64_t offset_items,
                                                std::uint64_t length_items,
                                                pmt::pmt_t begin_tag)
{
    return sptr(new BrowserFileSource(
        item_size, path, repeat, offset_items, length_items, std::move(begin_tag)));
}

BrowserFileSource::BrowserFileSource(std::size_t item_size,
                                     std::string path,
                                     bool repeat,
                                     std::uint64_t offset_items,
                                     std::uint64_t length_items,
                                     pmt::pmt_t begin_tag)
    : gr::sync_block("browser_file_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(1, 1, item_size)),
      d_item_size(item_size),
      d_path(std::move(path)),
      d_repeat(repeat),
      d_offset_items(offset_items),
      d_begin_tag(std::move(begin_tag))
{
    if (!d_item_size)
        throw std::runtime_error("File Source item size must be positive");

    const int size_high = browser_input_size_high(d_path.c_str());
    if (size_high < 0)
        throw std::runtime_error("file is not available in this browser session: " + d_path);
    const auto file_size =
        (static_cast<std::uint64_t>(static_cast<std::uint32_t>(size_high)) << 32) |
        static_cast<std::uint32_t>(browser_input_size_low(d_path.c_str()));
    const std::uint64_t available_items = file_size / d_item_size;
    if (d_offset_items >= available_items)
        throw std::runtime_error(
            "file is too small for the requested offset (size=" +
            std::to_string(file_size) + ", offset_items=" +
            std::to_string(d_offset_items) + ", item_size=" +
            std::to_string(d_item_size) + ", available_items=" +
            std::to_string(available_items) + ")");

    const std::uint64_t remaining = available_items - d_offset_items;
    d_length_items = length_items == 0 ? remaining : std::min(length_items, remaining);
    if (!d_length_items)
        throw std::runtime_error("File Source selection is empty");

    d_capacity_items = std::max<std::size_t>(2, RING_BYTES / d_item_size);
    if (d_capacity_items > static_cast<std::size_t>(INT32_MAX))
        d_capacity_items = INT32_MAX;
    d_ring.resize(d_capacity_items * d_item_size);
    d_tag_source = pmt::string_to_symbol("browser_file_source" +
                                         std::to_string(unique_id()));
}

BrowserFileSource::~BrowserFileSource() { stop(); }

std::int32_t BrowserFileSource::load(const std::int32_t* value) const
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void BrowserFileSource::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void BrowserFileSource::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

bool BrowserFileSource::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.state, INITIAL);
    d_items_into_pass = 0;
    d_repeat_count = 0;

    // top_block::run() invokes start() from a pthread. Proxy only this short
    // worker-launch operation to the browser main thread; work() never proxies.
    d_reader_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartBrowserFileSource(
                UTF8ToString($0),
                wasmMemory,
                $1 >>> 0,
                $2,
                $3,
                $4 >>> 0,
                $5 >>> 0,
                Number($6),
                Number($7),
                !!$8);
        } catch (error) {
            console.error("File Source reader launch failed:", error);
            return 0;
        }
    },
                                                   d_path.c_str(),
                                                   d_ring.data(),
                                                   static_cast<int>(d_capacity_items),
                                                   static_cast<int>(d_item_size),
                                                   &d_control,
                                                   d_error,
                                                   static_cast<double>(d_offset_items),
                                                   static_cast<double>(d_length_items),
                                                   d_repeat ? 1 : 0);
    if (!d_reader_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start browser file reader");
    }
    return true;
}

bool BrowserFileSource::stop()
{
    const int reader_id = d_reader_id;
    if (!reader_id)
        return true;

    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({
        window.__grStopBrowserFileSource($0);
    }, reader_id);
    d_reader_id = 0;
    return true;
}

std::string BrowserFileSource::reader_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("browser file reader failed");
}

int BrowserFileSource::work(int noutput_items,
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
            // browser reader fills the ring does not stall any other block.
            emscripten_futex_wait(&d_control.write_pos, write_pos, 100.0);
            continue;
        }

        if (d_items_into_pass == 0 && d_begin_tag != pmt::PMT_NIL) {
            add_item_tag(0,
                         nitems_written(0) + produced,
                         d_begin_tag,
                         pmt::from_uint64(d_repeat_count),
                         d_tag_source);
        }

        const std::uint64_t pass_remaining = d_length_items - d_items_into_pass;
        const std::size_t until_wrap = d_capacity_items - read_pos;
        const auto take = static_cast<std::size_t>(std::min<std::uint64_t>(
            { static_cast<std::uint64_t>(available),
              static_cast<std::uint64_t>(noutput_items - produced),
              pass_remaining,
              static_cast<std::uint64_t>(until_wrap) }));

        std::memcpy(output + static_cast<std::size_t>(produced) * d_item_size,
                    d_ring.data() + static_cast<std::size_t>(read_pos) * d_item_size,
                    take * d_item_size);
        produced += static_cast<int>(take);
        d_items_into_pass += take;

        const auto next_read =
            static_cast<std::int32_t>((static_cast<std::size_t>(read_pos) + take) %
                                      d_capacity_items);
        store(&d_control.read_pos, next_read);
        wake(&d_control.read_pos);

        if (d_items_into_pass == d_length_items) {
            d_items_into_pass = 0;
            ++d_repeat_count;
        }
    }
    return produced;
}
