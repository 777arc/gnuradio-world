#include "plutosdr_source.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <utility>

PlutoSdrSource::sptr PlutoSdrSource::make(const std::string& serial,
                                          int channels,
                                          double sample_rate,
                                          double center_freq,
                                          double bandwidth,
                                          int buffer_size,
                                          plutosdr::GainMode gain_mode1,
                                          double gain1,
                                          plutosdr::GainMode gain_mode2,
                                          double gain2,
                                          bool quadrature,
                                          bool rf_dc,
                                          bool bb_dc)
{
    return sptr(new PlutoSdrSource(serial,
                                   channels,
                                   sample_rate,
                                   center_freq,
                                   bandwidth,
                                   buffer_size,
                                   gain_mode1,
                                   gain1,
                                   gain_mode2,
                                   gain2,
                                   quadrature,
                                   rf_dc,
                                   bb_dc));
}

PlutoSdrSource::PlutoSdrSource(std::string serial,
                               int channels,
                               double sample_rate,
                               double center_freq,
                               double bandwidth,
                               int buffer_size,
                               plutosdr::GainMode gain_mode1,
                               double gain1,
                               plutosdr::GainMode gain_mode2,
                               double gain2,
                               bool quadrature,
                               bool rf_dc,
                               bool bb_dc)
    : gr::sync_block("plutosdr_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(channels, channels, sizeof(gr_complex))),
      d_serial(std::move(serial)),
      d_channels(channels),
      d_sample_rate(sample_rate),
      d_buffer_size(buffer_size)
{
    if (d_channels != 1 && d_channels != 2)
        throw std::runtime_error("PlutoSDR Source: channels must be 1 or 2");
    if (!(d_sample_rate > 0.0))
        throw std::runtime_error("PlutoSDR Source: sample rate must be positive");
    if (!(bandwidth > 0.0) || bandwidth > static_cast<double>(INT32_MAX))
        throw std::runtime_error("PlutoSDR Source: invalid RF bandwidth");
    if (d_buffer_size <= 0 ||
        static_cast<std::uint64_t>(d_buffer_size) * d_channels * sizeof(gr_complex) >
            1024u * 1024u)
        throw std::runtime_error(
            "PlutoSDR Source: IIO buffer must fit in one 1 MiB USB transfer");

    const auto minimum_capacity = std::max(
        static_cast<double>(plutosdr::MIN_RING_FRAMES),
        static_cast<double>(d_buffer_size) * 2.0 + 1.0);
    d_capacity_frames = static_cast<std::size_t>(std::clamp(
        d_sample_rate * plutosdr::RING_SECONDS,
        minimum_capacity,
        static_cast<double>(plutosdr::MAX_RING_FRAMES)));
    d_ring.resize(d_capacity_frames * static_cast<std::size_t>(d_channels) * 2);

    stage([&] {
        set_frequency_slots(center_freq);
        store(&d_control.bandwidth, static_cast<std::int32_t>(std::llround(bandwidth)));
        store(&d_control.value1_milli,
              static_cast<std::int32_t>(std::llround(gain1 * 1000.0)));
        store(&d_control.value2_milli,
              static_cast<std::int32_t>(std::llround(gain2 * 1000.0)));
        store(&d_control.mode1, gain_mode1);
        store(&d_control.mode2, gain_mode2);
        std::int32_t flags = 0;
        if (quadrature) flags |= plutosdr::FLAG_QUADRATURE;
        if (rf_dc) flags |= plutosdr::FLAG_RF_DC;
        if (bb_dc) flags |= plutosdr::FLAG_BB_DC;
        store(&d_control.flags, flags);
    });
}

PlutoSdrSource::~PlutoSdrSource() { stop(); }

std::int32_t PlutoSdrSource::load(const std::int32_t* value) const
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void PlutoSdrSource::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void PlutoSdrSource::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

void PlutoSdrSource::stage(const std::function<void()>& write_slots)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    write_slots();
    store(&d_control.cmd_seq, load(&d_control.cmd_seq) + 1);
}

void PlutoSdrSource::set_frequency_slots(double hz)
{
    const auto value = static_cast<std::int64_t>(std::llround(hz));
    store(&d_control.freq_hi, static_cast<std::int32_t>(value >> 32));
    store(&d_control.freq_lo, static_cast<std::int32_t>(value & 0xffffffff));
}

bool PlutoSdrSource::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.events, 0);
    store(&d_control.lost_samples, 0);
    store(&d_control.actual_rate, 0);
    store(&d_control.state, plutosdr::INITIAL);
    d_reported_rate = 0;
    d_reported_events = 0;

    d_worker_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartPlutoSdr(
                'rx', UTF8ToString($0), wasmMemory, $1 >>> 0, $2, $3,
                $4 >>> 0, $5 >>> 0, Number($6), $7, false);
        } catch (error) {
            console.error('PlutoSDR Source worker launch failed:', error);
            return 0;
        }
    },
                                          d_serial.c_str(),
                                          d_ring.data(),
                                          static_cast<int>(d_capacity_frames),
                                          d_channels,
                                          &d_control,
                                          d_error,
                                          d_sample_rate,
                                          d_buffer_size);
    if (!d_worker_id) {
        store(&d_control.state, plutosdr::ERROR);
        throw std::runtime_error("could not start the PlutoSDR Source worker");
    }
    return true;
}

bool PlutoSdrSource::stop()
{
    const int worker_id = d_worker_id;
    if (!worker_id) return true;
    store(&d_control.state, plutosdr::CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({ window.__grStopPlutoSdr($0); }, worker_id);
    d_worker_id = 0;
    return true;
}

void PlutoSdrSource::set_center_freq(double hz)
{
    stage([&] { set_frequency_slots(hz); });
}

void PlutoSdrSource::set_bandwidth(double hz)
{
    stage([&] {
        store(&d_control.bandwidth, static_cast<std::int32_t>(std::llround(hz)));
    });
}

void PlutoSdrSource::set_gain1(double db)
{
    stage([&] {
        store(&d_control.value1_milli,
              static_cast<std::int32_t>(std::llround(db * 1000.0)));
    });
}

void PlutoSdrSource::set_gain2(double db)
{
    stage([&] {
        store(&d_control.value2_milli,
              static_cast<std::int32_t>(std::llround(db * 1000.0)));
    });
}

std::string PlutoSdrSource::worker_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length),
        0,
        static_cast<std::int32_t>(plutosdr::ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("the PlutoSDR Source worker failed");
}

int PlutoSdrSource::work(int noutput_items,
                         gr_vector_const_void_star&,
                         gr_vector_void_star& output_items)
{
    if (!d_reported_rate) {
        const auto rate = load(&d_control.actual_rate);
        if (rate) {
            d_reported_rate = rate;
            std::printf("PlutoSDR Source: running at %d S/s with %d channel%s\n",
                        rate,
                        d_channels,
                        d_channels == 1 ? "" : "s");
        }
    }
    const auto events = load(&d_control.events);
    if (events > d_reported_events) {
        d_reported_events = d_reported_events ? d_reported_events * 2 : 1;
        std::printf("PlutoSDR Source: %d overrun%s, %d samples lost\n",
                    events,
                    events == 1 ? "" : "s",
                    load(&d_control.lost_samples));
    }

    int produced = 0;
    while (produced < noutput_items) {
        const auto read_pos = load(&d_control.read_pos);
        const auto write_pos = load(&d_control.write_pos);
        const std::size_t available = write_pos >= read_pos
            ? static_cast<std::size_t>(write_pos - read_pos)
            : d_capacity_frames - static_cast<std::size_t>(read_pos - write_pos);
        if (!available) {
            const auto state = load(&d_control.state);
            if (state == plutosdr::ERROR) throw std::runtime_error(worker_error());
            if (state == plutosdr::CANCELLED)
                return produced ? produced : WORK_DONE;
            if (produced) break;
            emscripten_futex_wait(&d_control.write_pos, write_pos, 100.0);
            continue;
        }

        const auto take = std::min({ available,
                                     static_cast<std::size_t>(noutput_items - produced),
                                     d_capacity_frames - static_cast<std::size_t>(read_pos) });
        for (std::size_t frame = 0; frame < take; ++frame) {
            const auto* raw = d_ring.data() +
                (static_cast<std::size_t>(read_pos) + frame) * d_channels * 2;
            for (int channel = 0; channel < d_channels; ++channel) {
                auto* output = static_cast<gr_complex*>(output_items[channel]);
                output[produced + frame] = gr_complex(
                    static_cast<float>(raw[channel * 2]) / 2048.0f,
                    static_cast<float>(raw[channel * 2 + 1]) / 2048.0f);
            }
        }
        produced += static_cast<int>(take);
        store(&d_control.read_pos,
              static_cast<std::int32_t>(
                  (static_cast<std::size_t>(read_pos) + take) % d_capacity_frames));
        wake(&d_control.read_pos);
    }
    return produced;
}
