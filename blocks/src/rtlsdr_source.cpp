#include "rtlsdr_source.hpp"

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

std::size_t item_size_of(RtlSdrSource::Output output)
{
    switch (output) {
    case RtlSdrSource::Output::COMPLEX:
        return sizeof(gr_complex);
    case RtlSdrSource::Output::SHORT:
        return sizeof(std::int16_t);
    case RtlSdrSource::Output::BYTE:
        return sizeof(std::int8_t);
    }
    return sizeof(gr_complex);
}

int items_per_pair_of(RtlSdrSource::Output output)
{
    return output == RtlSdrSource::Output::COMPLEX ? 1 : 2;
}

} // namespace

RtlSdrSource::sptr RtlSdrSource::make(const std::string& serial,
                                      Output output,
                                      double samp_rate,
                                      double center_freq,
                                      bool agc,
                                      double gain_db,
                                      double freq_correction_ppm,
                                      int direct_sampling,
                                      bool bias_tee,
                                      int bufflen)
{
    return sptr(new RtlSdrSource(serial,
                                 output,
                                 samp_rate,
                                 center_freq,
                                 agc,
                                 gain_db,
                                 freq_correction_ppm,
                                 direct_sampling,
                                 bias_tee,
                                 bufflen));
}

RtlSdrSource::RtlSdrSource(std::string serial,
                           Output output,
                           double samp_rate,
                           double center_freq,
                           bool agc,
                           double gain_db,
                           double freq_correction_ppm,
                           int direct_sampling,
                           bool bias_tee,
                           int bufflen)
    : gr::sync_block("rtlsdr_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(1, 1, item_size_of(output))),
      d_serial(std::move(serial)),
      d_output(output),
      d_samp_rate(samp_rate),
      d_direct_sampling(direct_sampling),
      d_bufflen(bufflen),
      d_item_size(item_size_of(output)),
      d_items_per_pair(items_per_pair_of(output))
{
    if (!(d_samp_rate > 0.0))
        throw std::runtime_error("RTL-SDR Source: sample rate must be positive");
    // The bulk endpoint delivers whole 512-byte packets, so a transfer that is
    // not a multiple of one would split an IQ pair across transfers.
    if (d_bufflen <= 0 || d_bufflen % 512 != 0)
        throw std::runtime_error(
            "RTL-SDR Source: USB transfer size must be a positive multiple of 512");
    if (d_direct_sampling < 0 || d_direct_sampling > 2)
        throw std::runtime_error("RTL-SDR Source: direct sampling must be 0, 1 or 2");

    // An interleaved output emits two items per IQ pair, so a work() that
    // produced an odd count would put Q where the next I belongs.
    if (d_items_per_pair != 1)
        set_output_multiple(d_items_per_pair);

    const auto wanted = static_cast<double>(d_samp_rate) * RING_SECONDS;
    d_capacity_pairs = static_cast<std::size_t>(
        std::clamp(wanted,
                   static_cast<double>(MIN_RING_PAIRS),
                   static_cast<double>(MAX_RING_PAIRS)));
    d_ring.resize(d_capacity_pairs * 2);

    // gr-osmosdr's rtl_source_c uses the same 127.4 centre: the RTL2832U's
    // unsigned samples sit a little below the midpoint of the 8-bit range.
    for (int i = 0; i < 256; ++i)
        d_lut[i] = (static_cast<float>(i) - 127.4f) * (1.0f / 128.0f);

    // Stage the initial tuning as the first mailbox command rather than as
    // separate start() arguments, so the worker has one code path for the
    // opening configuration and for every later retune.
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    const auto hz = static_cast<std::int64_t>(center_freq);
    d_control.freq_hi = static_cast<std::int32_t>(hz >> 32);
    d_control.freq_lo = static_cast<std::int32_t>(hz & 0xffffffff);
    d_control.gain_tenths = static_cast<std::int32_t>(gain_db * 10.0);
    d_control.ppm = static_cast<std::int32_t>(freq_correction_ppm);
    d_control.flags = (agc ? FLAG_AGC : 0) | (bias_tee ? FLAG_BIAS_TEE : 0);
    d_control.cmd_seq = 1;
}

RtlSdrSource::~RtlSdrSource() { stop(); }

std::int32_t RtlSdrSource::load(const std::int32_t* value) const
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void RtlSdrSource::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void RtlSdrSource::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

void RtlSdrSource::publish_command()
{
    // Seqlock: the worker re-reads the value slots whenever this counter moves
    // and retries if it moves again mid-read, so the release here is what makes
    // the slot writes above visible as one update.
    store(&d_control.cmd_seq, load(&d_control.cmd_seq) + 1);
}

bool RtlSdrSource::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.overruns, 0);
    store(&d_control.dropped_pairs, 0);
    store(&d_control.actual_rate, 0);
    store(&d_control.state, INITIAL);
    d_reported_rate = 0;
    d_reported_overruns = 0;

    // top_block::run() invokes start() from a pthread. Proxy only this short
    // worker-launch operation to the browser main thread; work() never proxies.
    d_reader_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartRtlSdrSource(
                UTF8ToString($0),
                wasmMemory,
                $1 >>> 0,
                $2,
                $3 >>> 0,
                $4 >>> 0,
                Number($5),
                $6,
                $7);
        } catch (error) {
            console.error("RTL-SDR Source reader launch failed:", error);
            return 0;
        }
    },
                                          d_serial.c_str(),
                                          d_ring.data(),
                                          static_cast<int>(d_capacity_pairs),
                                          &d_control,
                                          d_error,
                                          d_samp_rate,
                                          d_direct_sampling,
                                          d_bufflen);
    if (!d_reader_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start the RTL-SDR reader");
    }
    return true;
}

bool RtlSdrSource::stop()
{
    const int reader_id = d_reader_id;
    if (!reader_id)
        return true;

    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({
        window.__grStopRtlSdrSource($0);
    }, reader_id);
    d_reader_id = 0;
    return true;
}

void RtlSdrSource::set_center_freq(double hz)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    const auto value = static_cast<std::int64_t>(hz);
    store(&d_control.freq_hi, static_cast<std::int32_t>(value >> 32));
    store(&d_control.freq_lo, static_cast<std::int32_t>(value & 0xffffffff));
    publish_command();
}

void RtlSdrSource::set_gain(double db)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    store(&d_control.gain_tenths, static_cast<std::int32_t>(db * 10.0));
    publish_command();
}

void RtlSdrSource::set_gain_mode(bool agc)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    const auto flags = load(&d_control.flags);
    store(&d_control.flags, agc ? (flags | FLAG_AGC) : (flags & ~FLAG_AGC));
    publish_command();
}

void RtlSdrSource::set_freq_correction(double ppm)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    store(&d_control.ppm, static_cast<std::int32_t>(ppm));
    publish_command();
}

void RtlSdrSource::set_bias_tee(bool on)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    const auto flags = load(&d_control.flags);
    store(&d_control.flags, on ? (flags | FLAG_BIAS_TEE) : (flags & ~FLAG_BIAS_TEE));
    publish_command();
}

std::string RtlSdrSource::reader_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("the RTL-SDR reader failed");
}

void RtlSdrSource::convert(const unsigned char* pairs,
                           std::size_t count,
                           void* out) const
{
    switch (d_output) {
    case Output::COMPLEX: {
        auto* dst = static_cast<float*>(out);
        for (std::size_t i = 0; i < count; ++i) {
            dst[2 * i] = d_lut[pairs[2 * i]];
            dst[2 * i + 1] = d_lut[pairs[2 * i + 1]];
        }
        break;
    }
    case Output::SHORT: {
        auto* dst = static_cast<std::int16_t*>(out);
        for (std::size_t i = 0; i < 2 * count; ++i)
            dst[i] = static_cast<std::int16_t>((static_cast<int>(pairs[i]) - 128) << 8);
        break;
    }
    case Output::BYTE: {
        auto* dst = static_cast<std::int8_t*>(out);
        for (std::size_t i = 0; i < 2 * count; ++i)
            dst[i] = static_cast<std::int8_t>(static_cast<int>(pairs[i]) - 128);
        break;
    }
    }
}

int RtlSdrSource::work(int noutput_items,
                       gr_vector_const_void_star&,
                       gr_vector_void_star& output_items)
{
    // The dongle's achievable rate is a division of its 28.8 MHz clock, so it
    // is rarely the rate that was asked for. Report it once, where the console
    // pane shows it -- nothing downstream can be told about it after the fact.
    if (!d_reported_rate) {
        const auto rate = load(&d_control.actual_rate);
        if (rate) {
            d_reported_rate = rate;
            if (static_cast<double>(rate) != d_samp_rate)
                std::printf("RTL-SDR Source: running at %d S/s (requested %.0f)\n",
                            rate,
                            d_samp_rate);
            else
                std::printf("RTL-SDR Source: running at %d S/s\n", rate);
        }
    }
    // A live source cannot backpressure the dongle, so a ring that fills loses
    // samples. Report on a doubling schedule: the first loss matters and a
    // storm of them must not flood the pane.
    const auto overruns = load(&d_control.overruns);
    if (overruns > d_reported_overruns) {
        d_reported_overruns = d_reported_overruns ? d_reported_overruns * 2 : 1;
        std::printf("RTL-SDR Source: %d overrun%s, %d IQ samples lost\n",
                    overruns,
                    overruns == 1 ? "" : "s",
                    load(&d_control.dropped_pairs));
    }

    auto* output = static_cast<unsigned char*>(output_items[0]);
    const int pairs_wanted = noutput_items / d_items_per_pair;
    int produced_pairs = 0;

    while (produced_pairs < pairs_wanted) {
        const auto read_pos = load(&d_control.read_pos);
        const auto write_pos = load(&d_control.write_pos);
        const std::size_t available =
            write_pos >= read_pos
                ? static_cast<std::size_t>(write_pos - read_pos)
                : d_capacity_pairs - static_cast<std::size_t>(read_pos - write_pos);

        if (!available) {
            const auto state = load(&d_control.state);
            if (state == ERROR)
                throw std::runtime_error(reader_error());
            if (state == CANCELLED)
                return produced_pairs ? produced_pairs * d_items_per_pair : WORK_DONE;
            // Returning what we have keeps the graph moving at low rates; only
            // an empty pass waits. A source owns its scheduler pthread, so
            // blocking here while the reader fills the ring stalls nothing else.
            if (produced_pairs)
                break;
            emscripten_futex_wait(&d_control.write_pos, write_pos, 100.0);
            continue;
        }

        const std::size_t until_wrap = d_capacity_pairs - static_cast<std::size_t>(read_pos);
        const auto take = std::min({ available,
                                     static_cast<std::size_t>(pairs_wanted - produced_pairs),
                                     until_wrap });

        convert(d_ring.data() + static_cast<std::size_t>(read_pos) * 2,
                take,
                output + static_cast<std::size_t>(produced_pairs) *
                             static_cast<std::size_t>(d_items_per_pair) * d_item_size);
        produced_pairs += static_cast<int>(take);

        const auto next_read = static_cast<std::int32_t>(
            (static_cast<std::size_t>(read_pos) + take) % d_capacity_pairs);
        store(&d_control.read_pos, next_read);
        wake(&d_control.read_pos);
    }

    return produced_pairs * d_items_per_pair;
}
