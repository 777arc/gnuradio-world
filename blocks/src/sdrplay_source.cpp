#include "sdrplay_source.hpp"

#include <gnuradio/io_signature.h>
#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <stdexcept>

using namespace sdrplay;

SdrplaySource::sptr SdrplaySource::make(const std::string& device,
                                        double sample_rate,
                                        double center_freq,
                                        double bandwidth,
                                        double gain,
                                        bool bias_tee,
                                        bool fm_notch,
                                        bool dab_notch,
                                        int transfer_bytes)
{
    std::int32_t flags = 0;
    if (bias_tee) flags |= FLAG_BIAS_TEE;
    if (fm_notch) flags |= FLAG_FM_NOTCH;
    if (dab_notch) flags |= FLAG_DAB_NOTCH;
    return sptr(new SdrplaySource(
        device, sample_rate, center_freq, bandwidth, gain, flags, transfer_bytes));
}

SdrplaySource::SdrplaySource(const std::string& device,
                             double sample_rate,
                             double center_freq,
                             double bandwidth,
                             double gain,
                             std::int32_t flags,
                             int transfer_bytes)
    : gr::sync_block("sdrplay_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(1, 1, sizeof(gr_complex))),
      d_device(device),
      d_sample_rate(sample_rate),
      d_transfer_bytes(transfer_bytes)
{
    if (!(d_sample_rate >= MIN_RATE && d_sample_rate <= MAX_RATE))
        throw std::runtime_error("SDRplay RSP1A: sample rate must be 1.3 to 12.096 MS/s");
    if (d_transfer_bytes <= 0 || d_transfer_bytes > 1024 * 1024 ||
        d_transfer_bytes % FRAME_BYTES != 0)
        throw std::runtime_error(
            "SDRplay RSP1A: USB transfer size must be a positive multiple of 1024, at most 1 MiB");
    if (!(gain >= 0.0 && gain <= MAX_GAIN))
        throw std::runtime_error("SDRplay RSP1A: gain must be 0 to 102 dB");

    // Worst case a transfer unpacks to 504 pairs per frame; the ring has to
    // hold a full queue of those plus one slot, and about a quarter second.
    const auto transfer_pairs =
        static_cast<std::size_t>(d_transfer_bytes / FRAME_BYTES) * MAX_PAIRS_PER_FRAME;
    const auto minimum_capacity = std::max(MIN_RING_PAIRS, transfer_pairs * TRANSFER_DEPTH + 1);
    d_capacity_pairs = static_cast<std::size_t>(std::clamp(
        d_sample_rate * RING_SECONDS,
        static_cast<double>(minimum_capacity),
        static_cast<double>(MAX_RING_PAIRS)));
    d_ring.resize(d_capacity_pairs * 2);

    stage([&] {
        store(&d_control.sample_rate,
              static_cast<std::int32_t>(std::llround(d_sample_rate)));
        set_frequency_slots(center_freq);
        store(&d_control.bandwidth, static_cast<std::int32_t>(std::llround(bandwidth)));
        store(&d_control.gain, static_cast<std::int32_t>(std::llround(gain)));
        store(&d_control.flags, flags);
    });
}

SdrplaySource::~SdrplaySource() { stop(); }

std::int32_t SdrplaySource::load(const std::int32_t* value)
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void SdrplaySource::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void SdrplaySource::stage(const std::function<void()>& write_slots)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    write_slots();
    store(&d_control.cmd_seq, load(&d_control.cmd_seq) + 1);
}

void SdrplaySource::set_frequency_slots(double hz)
{
    if (!(hz >= MIN_FREQ && hz <= MAX_FREQ))
        throw std::runtime_error("SDRplay RSP1A: center frequency must be 10 kHz to 2 GHz");
    const auto value = static_cast<std::int64_t>(std::llround(hz));
    store(&d_control.freq_hi, static_cast<std::int32_t>(value >> 32));
    store(&d_control.freq_lo, static_cast<std::int32_t>(value & 0xffffffff));
}

void SdrplaySource::set_flag(std::int32_t flag, bool on)
{
    const auto flags = load(&d_control.flags);
    store(&d_control.flags, on ? flags | flag : flags & ~flag);
}

bool SdrplaySource::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.events, 0);
    store(&d_control.lost_samples, 0);
    store(&d_control.actual_rate, 0);
    store(&d_control.model, 0);
    store(&d_control.state, INITIAL);
    d_reported_rate = 0;
    d_reported_events = 0;

    // new Worker() is main-thread work; start() runs on GNU Radio's
    // scheduler-launch pthread, so proxy. work() never proxies: it blocks on a
    // futex on this block's own thread, where blocking stalls nothing else.
    d_worker_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartSdrplay(
                UTF8ToString($0), wasmMemory, $1 >>> 0, $2, $3 >>> 0, $4 >>> 0,
                Number($5), $6);
        } catch (error) {
            console.error('SDRplay worker launch failed:', error);
            return 0;
        }
    },
                                          d_device.c_str(),
                                          d_ring.data(),
                                          static_cast<int>(d_capacity_pairs),
                                          &d_control,
                                          d_error,
                                          d_sample_rate,
                                          d_transfer_bytes);
    if (!d_worker_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start the SDRplay RSP1A worker");
    }
    return true;
}

bool SdrplaySource::stop()
{
    const int worker_id = d_worker_id;
    if (!worker_id) return true;
    store(&d_control.state, CANCELLED);
    emscripten_futex_wake(&d_control.read_pos, INT_MAX);
    emscripten_futex_wake(&d_control.write_pos, INT_MAX);
    MAIN_THREAD_EM_ASM({ window.__grStopSdrplay($0); }, worker_id);
    d_worker_id = 0;
    return true;
}

void SdrplaySource::set_center_freq(double hz)
{
    stage([&] { set_frequency_slots(hz); });
}

void SdrplaySource::set_gain(double db)
{
    const auto clamped = std::clamp(db, 0.0, MAX_GAIN);
    stage([&] { store(&d_control.gain, static_cast<std::int32_t>(std::llround(clamped))); });
}

void SdrplaySource::set_bias_tee(bool on)
{
    stage([&] { set_flag(FLAG_BIAS_TEE, on); });
}

void SdrplaySource::set_fm_notch(bool on)
{
    stage([&] { set_flag(FLAG_FM_NOTCH, on); });
}

void SdrplaySource::set_dab_notch(bool on)
{
    stage([&] { set_flag(FLAG_DAB_NOTCH, on); });
}

std::size_t SdrplaySource::used_pairs(std::int32_t read_pos, std::int32_t write_pos) const
{
    return write_pos >= read_pos
        ? static_cast<std::size_t>(write_pos - read_pos)
        : d_capacity_pairs - static_cast<std::size_t>(read_pos - write_pos);
}

std::string SdrplaySource::worker_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : "the SDRplay RSP1A worker failed";
}

int SdrplaySource::work(int noutput_items,
                        gr_vector_const_void_star&,
                        gr_vector_void_star& output_items)
{
    const auto rate = load(&d_control.actual_rate);
    if (rate && rate != d_reported_rate) {
        d_reported_rate = rate;
        std::printf("SDRplay RSP1A: running at %d S/s\n", rate);
    }
    // Losses print on a doubling schedule: the first one is visible, a storm
    // does not flood the console pane.
    const auto events = load(&d_control.events);
    if (events > d_reported_events) {
        d_reported_events = d_reported_events ? d_reported_events * 2 : 1;
        std::printf("SDRplay RSP1A: %d loss event%s, %d IQ samples lost\n",
                    events,
                    events == 1 ? "" : "s",
                    load(&d_control.lost_samples));
    }

    auto* output = static_cast<gr_complex*>(output_items[0]);
    constexpr float SCALE = 1.0f / 32768.0f;
    int produced = 0;
    while (produced < noutput_items) {
        const auto read_pos = load(&d_control.read_pos);
        const auto write_pos = load(&d_control.write_pos);
        const auto available = used_pairs(read_pos, write_pos);
        if (!available) {
            const auto state = load(&d_control.state);
            if (state == ERROR) throw std::runtime_error(worker_error());
            if (state == CANCELLED) return produced ? produced : WORK_DONE;
            if (produced) break;
            emscripten_futex_wait(&d_control.write_pos, write_pos, 100.0);
            continue;
        }

        const auto take = std::min({ available,
                                     static_cast<std::size_t>(noutput_items - produced),
                                     d_capacity_pairs - static_cast<std::size_t>(read_pos) });
        const auto* raw = d_ring.data() + static_cast<std::size_t>(read_pos) * 2;
        for (std::size_t i = 0; i < take; ++i)
            output[produced + i] = gr_complex(
                static_cast<float>(raw[i * 2]) * SCALE,
                static_cast<float>(raw[i * 2 + 1]) * SCALE);
        produced += static_cast<int>(take);
        store(&d_control.read_pos,
              static_cast<std::int32_t>(
                  (static_cast<std::size_t>(read_pos) + take) % d_capacity_pairs));
        emscripten_futex_wake(&d_control.read_pos, INT_MAX);
    }
    return produced;
}
