#include "tezuka_sink.hpp"

#include <emscripten.h>
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

TezukaSink::sptr TezukaSink::make(const std::string& host,
                                  double sample_rate,
                                  double center_freq,
                                  double bandwidth,
                                  double gain)
{
    return sptr(new TezukaSink(host, sample_rate, center_freq, bandwidth, gain));
}

TezukaSink::TezukaSink(std::string host,
                       double sample_rate,
                       double center_freq,
                       double bandwidth,
                       double gain)
    : gr::sync_block("tezuka_sink",
                     gr::io_signature::make(1, 1, sizeof(gr_complex)),
                     gr::io_signature::make(0, 0, 0)),
      d_host(std::move(host)),
      d_sample_rate(sample_rate),
      d_center_freq(center_freq),
      d_bandwidth(bandwidth),
      d_gain(gain)
{
    if (d_host.empty())
        throw std::runtime_error("Tezuka Sink: no host given");

    d_capacity_items = std::max<std::size_t>(2, RING_BYTES / ITEM_BYTES);
    if (d_capacity_items > static_cast<std::size_t>(INT32_MAX))
        d_capacity_items = INT32_MAX;
    d_ring.resize(d_capacity_items * ITEM_BYTES);
}

// Not stop(): a sink being destroyed without having been stopped has nothing
// worth draining -- the socket is just closed. Mirrors WebSocketSink.
TezukaSink::~TezukaSink() { cancel(); }

std::int32_t TezukaSink::load(const std::int32_t* value) const
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void TezukaSink::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void TezukaSink::wake(std::int32_t* value)
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

void TezukaSink::publish_tx(const char* path, const std::string& value) const
{
    // Fire-and-forget, exactly like TezukaSource::publish_rx -- start() and
    // every live setter run on a scheduler pthread and proxy only this short
    // call to the browser main thread.
    MAIN_THREAD_EM_ASM({
        try {
            window.__grTezukaPublish(UTF8ToString($0), 'tx/' + UTF8ToString($1), UTF8ToString($2));
        } catch (error) {
            console.error("Tezuka Sink publish failed:", error);
        }
    },
                       d_host.c_str(),
                       path,
                       value.c_str());
}

void TezukaSink::set_sample_rate(double samples_per_second)
{
    d_sample_rate = samples_per_second;
    publish_tx("sampling", hz_string(samples_per_second));
}

void TezukaSink::set_center_freq(double hz)
{
    d_center_freq = hz;
    publish_tx("frequency", hz_string(hz));
}

void TezukaSink::set_bandwidth(double hz)
{
    d_bandwidth = hz;
    publish_tx("bandwidth", hz_string(hz));
}

void TezukaSink::set_gain(double db)
{
    d_gain = db;
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.3f", db);
    publish_tx("gain", buf);
}

bool TezukaSink::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.state, INITIAL);

    // Configure the board to the flowgraph's parameters before the stream
    // starts, the same convention TezukaSource follows -- window.__grTezukaConfigure
    // waits for the MQTT connection before publishing any cmd/tx/* message, so
    // these are not lost to a race with the connection handshake. No "active"
    // property here -- see tezuka_sink.hpp for why this block never touches
    // cmd/tx/active.
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
            }, 'tx');
        } catch (error) {
            console.error("Tezuka Sink configure failed:", error);
        }
    },
                       d_host.c_str(),
                       sampling_str.c_str(),
                       frequency_str.c_str(),
                       bandwidth_str.c_str(),
                       gain_buf);

    // top_block::run() invokes start() from a pthread. Proxy only this short
    // worker-launch operation to the browser main thread; work() never proxies.
    d_writer_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartTezukaSink(
                UTF8ToString($0),
                wasmMemory,
                $1 >>> 0,
                $2,
                $3,
                $4 >>> 0,
                $5 >>> 0);
        } catch (error) {
            console.error("Tezuka Sink launch failed:", error);
            return 0;
        }
    },
                                                   d_host.c_str(),
                                                   d_ring.data(),
                                                   static_cast<int>(d_capacity_items),
                                                   static_cast<int>(ITEM_BYTES),
                                                   &d_control,
                                                   d_error);
    if (!d_writer_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start Tezuka Sink");
    }
    return true;
}

void TezukaSink::cancel()
{
    const int writer_id = d_writer_id;
    if (!writer_id)
        return;
    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    // Releases this block's share of the board's streaming proxy -- see
    // tezukaReleaseStreaming in runner.html.
    MAIN_THREAD_EM_ASM({
        window.__grStopTezukaSink($0, UTF8ToString($1));
    }, writer_id, d_host.c_str());
    d_writer_id = 0;
}

bool TezukaSink::stop()
{
    const int writer_id = d_writer_id;
    if (!writer_id)
        return true;

    store(&d_control.state, FINISHING);
    wake(&d_control.write_pos);

    // Wait for the worker to drain the ring and close the socket, exactly as
    // WebSocketSink::stop() does -- see websocket_sink.cpp. Without this the
    // tab can move on with the tail of the transmit stream still sitting in
    // shared memory.
    const double deadline = emscripten_get_now() + FINISH_TIMEOUT_MS;
    while (true) {
        const auto state = load(&d_control.state);
        if (state == CLOSED || state == ERROR || state == CANCELLED)
            break;
        if (emscripten_get_now() >= deadline) {
            d_logger->error("Tezuka Sink: writer did not finish within {}s; "
                            "the tail of the stream may not have been sent",
                            FINISH_TIMEOUT_MS / 1000);
            break;
        }
        emscripten_futex_wait(&d_control.state, state, 50.0);
    }

    const bool failed = load(&d_control.state) == ERROR;
    const std::string message = failed ? writer_error() : std::string();

    d_writer_id = 0;
    MAIN_THREAD_EM_ASM({
        window.__grStopTezukaSink($0, UTF8ToString($1));
    }, writer_id, d_host.c_str());

    // Reported rather than thrown: stop() runs while the flowgraph is already
    // coming down, where an exception is swallowed.
    if (failed)
        d_logger->error("Tezuka Sink: {}", message);
    return true;
}

std::string TezukaSink::writer_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("Tezuka Sink writer failed");
}

int TezukaSink::work(int noutput_items,
                     gr_vector_const_void_star& input_items,
                     gr_vector_void_star&)
{
    const auto* input = static_cast<const gr_complex*>(input_items[0]);
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
            // A sink owns its scheduler pthread. Blocking here backpressures
            // the graph onto how fast the socket can actually drain.
            emscripten_futex_wait(&d_control.read_pos, read_pos, 100.0);
            continue;
        }

        const std::size_t until_wrap = d_capacity_items - write_pos;
        const auto take = static_cast<std::size_t>(
            std::min({ free_items,
                       static_cast<std::size_t>(noutput_items - consumed),
                       until_wrap }));

        // AD9361/AD9363 TX conversion: full int16 range, the mirror image of
        // TezukaSource::work()'s RAW_SCALE=2048 RX conversion -- see
        // tezuka_sink.hpp for why the two directions use different scales.
        auto* raw = reinterpret_cast<std::int16_t*>(
            d_ring.data() + static_cast<std::size_t>(write_pos) * ITEM_BYTES);
        for (std::size_t i = 0; i < take; ++i) {
            const auto sample = input[consumed + i];
            raw[i * 2] = static_cast<std::int16_t>(std::clamp(
                static_cast<int>(std::lrint(sample.real() * RAW_SCALE)), -32768, 32767));
            raw[i * 2 + 1] = static_cast<std::int16_t>(std::clamp(
                static_cast<int>(std::lrint(sample.imag() * RAW_SCALE)), -32768, 32767));
        }
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
