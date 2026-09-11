#include "tezuka_source.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <utility>

TezukaSource::sptr TezukaSource::make(const std::string& host,
                                      double sample_rate,
                                      double center_freq,
                                      double bandwidth,
                                      double gain,
                                      const std::string& gain_mode)
{
    return sptr(new TezukaSource(host, sample_rate, center_freq, bandwidth, gain, gain_mode));
}

TezukaSource::TezukaSource(std::string host,
                           double sample_rate,
                           double center_freq,
                           double bandwidth,
                           double gain,
                           std::string gain_mode)
    : gr::sync_block("tezuka_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(1, 1, sizeof(gr_complex))),
      d_host(std::move(host)),
      d_sample_rate(sample_rate),
      d_center_freq(center_freq),
      d_bandwidth(bandwidth),
      d_gain(gain),
      d_gain_mode(std::move(gain_mode))
{
    if (d_host.empty())
        throw std::runtime_error("Tezuka Source: no host given");

    d_capacity_items = std::max<std::size_t>(2, RING_BYTES / ITEM_BYTES);
    if (d_capacity_items > static_cast<std::size_t>(INT32_MAX))
        d_capacity_items = INT32_MAX;
    d_ring.resize(d_capacity_items * ITEM_BYTES);
}

TezukaSource::~TezukaSource() { stop(); }

std::int32_t TezukaSource::load(const std::int32_t* value) const
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void TezukaSource::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void TezukaSource::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

namespace {
// Hz, rounded to the nearest integer -- api_controller.sh does the same
// (`printf "%0.f"`) before it ever compares the value to a sweep threshold.
std::string hz_string(double hz)
{
    return std::to_string(static_cast<long long>(std::llround(hz)));
}
} // namespace

void TezukaSource::publish_rx(const char* path, const std::string& value) const
{
    // A fire-and-forget PUBLISH: start() and every live setter run on a
    // scheduler pthread and proxy only this short call to the browser main
    // thread, exactly like every other block's worker-launch proxy. There is
    // nothing to wait for here -- the board is the only side that applies or
    // confirms a cmd/ message, and the console mirrors state/ echoes when the
    // board disagrees.
    MAIN_THREAD_EM_ASM({
        try {
            window.__grTezukaPublish(UTF8ToString($0), 'rx/' + UTF8ToString($1), UTF8ToString($2));
        } catch (error) {
            console.error("Tezuka Source publish failed:", error);
        }
    },
                       d_host.c_str(),
                       path,
                       value.c_str());
}

void TezukaSource::set_sample_rate(double samples_per_second)
{
    d_sample_rate = samples_per_second;
    publish_rx("sampling", hz_string(samples_per_second));
}

void TezukaSource::set_center_freq(double hz)
{
    d_center_freq = hz;
    publish_rx("frequency", hz_string(hz));
}

void TezukaSource::set_bandwidth(double hz)
{
    d_bandwidth = hz;
    publish_rx("bandwidth", hz_string(hz));
}

void TezukaSource::set_gain(double db)
{
    d_gain = db;
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.3f", db);
    publish_rx("gain", buf);
}

bool TezukaSource::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.state, INITIAL);
    store(&d_control.overruns, 0);
    store(&d_control.dropped_items, 0);

    // Configure the board to the flowgraph's parameters before the stream
    // starts, the same convention RTL-SDR/PlutoSDR follow. window.__grTezukaConfigure
    // waits for the MQTT connection (and, only once per board, for the
    // on-device streaming proxy to confirm it is up -- see runner.html) before
    // publishing any cmd/rx/* message, so these are not lost to a race with
    // the connection handshake.
    char gain_buf[32];
    std::snprintf(gain_buf, sizeof(gain_buf), "%.3f", d_gain);
    const std::string sampling_str = hz_string(d_sample_rate);
    const std::string frequency_str = hz_string(d_center_freq);
    const std::string bandwidth_str = hz_string(d_bandwidth);
    MAIN_THREAD_EM_ASM({
        try {
            window.__grTezukaConfigure(UTF8ToString($0), {
                sampling: UTF8ToString($1),
                frequency: UTF8ToString($2),
                bandwidth: UTF8ToString($3),
                gain: UTF8ToString($4),
                gain_mode: UTF8ToString($5),
            });
        } catch (error) {
            console.error("Tezuka Source configure failed:", error);
        }
    },
                       d_host.c_str(),
                       sampling_str.c_str(),
                       frequency_str.c_str(),
                       bandwidth_str.c_str(),
                       gain_buf,
                       d_gain_mode.c_str());

    // top_block::run() invokes start() from a pthread. Proxy only this short
    // worker-launch operation to the browser main thread; work() never proxies.
    // The actual WebSocket connection is opened asynchronously, after the
    // streaming proxy is confirmed running -- see __grStartTezukaSource in
    // runner.html -- so this returns immediately with a ring already primed
    // to receive it.
    d_reader_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartTezukaSource(
                UTF8ToString($0),
                wasmMemory,
                $1 >>> 0,
                $2,
                $3,
                $4 >>> 0,
                $5 >>> 0);
        } catch (error) {
            console.error("Tezuka Source launch failed:", error);
            return 0;
        }
    },
                                                   d_host.c_str(),
                                                   d_ring.data(),
                                                   static_cast<int>(d_capacity_items),
                                                   static_cast<int>(ITEM_BYTES),
                                                   &d_control,
                                                   d_error);
    if (!d_reader_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start Tezuka Source");
    }
    return true;
}

bool TezukaSource::stop()
{
    const int reader_id = d_reader_id;
    if (!reader_id)
        return true;

    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    // Releases this block's share of the board's streaming proxy -- see
    // tezukaReleaseStreaming in runner.html. Only the last Tezuka block to
    // stop against a given host actually asks the board to stop streaming.
    MAIN_THREAD_EM_ASM({
        window.__grStopTezukaSource($0, UTF8ToString($1));
    }, reader_id, d_host.c_str());
    d_reader_id = 0;
    return true;
}

std::string TezukaSource::reader_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("Tezuka Source reader failed");
}

int TezukaSource::work(int noutput_items,
                       gr_vector_const_void_star&,
                       gr_vector_void_star& output_items)
{
    auto* output = static_cast<gr_complex*>(output_items[0]);
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

            emscripten_futex_wait(&d_control.write_pos, write_pos, 100.0);
            continue;
        }

        const std::size_t until_wrap = d_capacity_items - read_pos;
        const auto take = static_cast<std::size_t>(std::min<std::uint64_t>(
            { static_cast<std::uint64_t>(available),
              static_cast<std::uint64_t>(noutput_items - produced),
              static_cast<std::uint64_t>(until_wrap) }));

        const auto* raw = reinterpret_cast<const std::int16_t*>(
            d_ring.data() + static_cast<std::size_t>(read_pos) * ITEM_BYTES);
        for (std::size_t i = 0; i < take; ++i) {
            output[produced + i] =
                gr_complex(static_cast<float>(raw[i * 2]) / RAW_SCALE,
                          static_cast<float>(raw[i * 2 + 1]) / RAW_SCALE);
        }
        produced += static_cast<int>(take);

        const auto next_read =
            static_cast<std::int32_t>((static_cast<std::size_t>(read_pos) + take) %
                                      d_capacity_items);
        store(&d_control.read_pos, next_read);
        wake(&d_control.read_pos);
    }
    return produced;
}
