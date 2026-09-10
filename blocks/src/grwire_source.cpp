#include "grwire_source.hpp"

#include <gnuradio/io_signature.h>
#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <utility>

// A flowgraph writes a gain in dB, so anything this far below the range of a
// real amplifier means "leave this stage alone" rather than a setting.
static constexpr double STAGE_UNSET_THRESHOLD = -999.0;

namespace grwire {

std::size_t wire_bytes(Wire wire)
{
    switch (wire) {
    case Wire::CI8: return 2;
    case Wire::CI16: return 4;
    case Wire::CF32: return 8;
    }
    return 2;
}

} // namespace grwire

GrWireSource::sptr GrWireSource::make(const std::string& server,
                                      const std::string& device,
                                      Output output,
                                      grwire::Wire wire,
                                      double samp_rate,
                                      double center_freq,
                                      double offset,
                                      int decim,
                                      bool agc,
                                      double gain_db,
                                      const double* stages,
                                      double bandwidth)
{
    return sptr(new GrWireSource(server,
                                 device,
                                 output,
                                 wire,
                                 samp_rate,
                                 center_freq,
                                 offset,
                                 decim,
                                 agc,
                                 gain_db,
                                 stages,
                                 bandwidth));
}

GrWireSource::GrWireSource(std::string server,
                           std::string device,
                           Output output,
                           grwire::Wire wire,
                           double samp_rate,
                           double center_freq,
                           double offset,
                           int decim,
                           bool agc,
                           double gain_db,
                           const double* stages,
                           double bandwidth)
    : gr::sync_block("grwire_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(
                         1,
                         1,
                         output == Output::COMPLEX ? sizeof(gr_complex)
                             : output == Output::SHORT ? sizeof(std::int16_t)
                                                       : sizeof(std::int8_t))),
      d_server(std::move(server)),
      d_device(std::move(device)),
      d_output(output),
      d_wire(wire),
      d_samp_rate(samp_rate),
      d_decim(decim)
{
    if (d_server.empty())
        throw std::runtime_error("GRWire Source: no server URL given");
    if (!(d_samp_rate > 0.0) || d_samp_rate > static_cast<double>(INT32_MAX))
        throw std::runtime_error("GRWire Source: sample rate must be positive");
    // Zero is "let the daemon choose", which is the default and the only way
    // to reach a rate below what the radio can sample directly.
    if (d_decim < 0)
        throw std::runtime_error("GRWire Source: decimation cannot be negative");

    d_wire_bytes = grwire::wire_bytes(d_wire);
    switch (d_output) {
    case Output::COMPLEX:
        d_item_size = sizeof(gr_complex);
        d_items_per_sample = 1;
        break;
    case Output::SHORT:
        d_item_size = sizeof(std::int16_t);
        d_items_per_sample = 2;
        break;
    case Output::BYTE:
        d_item_size = sizeof(std::int8_t);
        d_items_per_sample = 2;
        break;
    }
    // Without this a work() producing an odd count would put Q where the next
    // I belongs, and every sample after it would be swapped.
    if (d_items_per_sample != 1) set_output_multiple(d_items_per_sample);

    d_capacity_samples = static_cast<std::size_t>(
        std::clamp(d_samp_rate * grwire::RING_SECONDS,
                   static_cast<double>(grwire::MIN_RING_SAMPLES),
                   static_cast<double>(grwire::MAX_RING_SAMPLES)));
    d_ring.resize(d_capacity_samples * d_wire_bytes);

    for (int i = 0; i < 256; ++i)
        d_lut[i] = static_cast<float>(static_cast<std::int8_t>(i)) / 127.0f;

    // The opening configuration goes through the same mailbox as every later
    // change, so the worker has one code path rather than two.
    stage([&] {
        set_frequency_slots(center_freq);
        set_offset_slots(offset);
        store(&d_control.gain_tenths, static_cast<std::int32_t>(std::llround(gain_db * 10.0)));
        store(&d_control.bandwidth, static_cast<std::int32_t>(std::llround(bandwidth)));
        set_flag(grwire::FLAG_AGC, agc);
        std::int32_t* const slots[3] = {
            &d_control.stage1, &d_control.stage2, &d_control.stage3
        };
        for (int i = 0; i < 3; ++i)
            store(slots[i],
                  stages && stages[i] > STAGE_UNSET_THRESHOLD
                      ? static_cast<std::int32_t>(std::llround(stages[i] * 10.0))
                      : grwire::STAGE_UNSET);
    });
}

GrWireSource::~GrWireSource() { stop(); }

std::int32_t GrWireSource::load(const std::int32_t* value)
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void GrWireSource::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void GrWireSource::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

void GrWireSource::stage(const std::function<void()>& write_slots)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    write_slots();
    // Seqlock publish: the release store on cmd_seq is what makes the slot
    // writes above visible to the worker as one update.
    store(&d_control.cmd_seq, load(&d_control.cmd_seq) + 1);
}

void GrWireSource::set_flag(std::int32_t flag, bool on)
{
    const auto flags = load(&d_control.flags);
    store(&d_control.flags, on ? flags | flag : flags & ~flag);
}

void GrWireSource::set_frequency_slots(double hz)
{
    const auto value = static_cast<std::int64_t>(std::llround(hz));
    store(&d_control.freq_hi, static_cast<std::int32_t>(value >> 32));
    store(&d_control.freq_lo, static_cast<std::int32_t>(value & 0xffffffff));
}

void GrWireSource::set_offset_slots(double hz)
{
    const auto value = static_cast<std::int64_t>(std::llround(hz));
    store(&d_control.offset_hi, static_cast<std::int32_t>(value >> 32));
    store(&d_control.offset_lo, static_cast<std::int32_t>(value & 0xffffffff));
}

void GrWireSource::set_center_freq(double hz)
{
    stage([&] { set_frequency_slots(hz); });
}

void GrWireSource::set_offset(double hz)
{
    stage([&] { set_offset_slots(hz); });
}

void GrWireSource::set_gain(double db)
{
    stage([&] {
        store(&d_control.gain_tenths, static_cast<std::int32_t>(std::llround(db * 10.0)));
    });
}

void GrWireSource::set_gain_mode(bool agc)
{
    stage([&] { set_flag(grwire::FLAG_AGC, agc); });
}

void GrWireSource::set_stage(int which, double db)
{
    if (which < 1 || which > 3) return;
    stage([&] {
        std::int32_t* const slots[3] = {
            &d_control.stage1, &d_control.stage2, &d_control.stage3
        };
        store(slots[which - 1],
              db > STAGE_UNSET_THRESHOLD
                  ? static_cast<std::int32_t>(std::llround(db * 10.0))
                  : grwire::STAGE_UNSET);
    });
}

void GrWireSource::set_bandwidth(double hz)
{
    stage([&] {
        store(&d_control.bandwidth, static_cast<std::int32_t>(std::llround(hz)));
    });
}

bool GrWireSource::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.overruns, 0);
    store(&d_control.lost_samples, 0);
    store(&d_control.net_drop, 0);
    store(&d_control.client_drop, 0);
    store(&d_control.actual_rate, 0);
    store(&d_control.state, grwire::INITIAL);
    d_reported_rate = 0;
    d_reported_overruns = 0;

    // start() runs on GNU Radio's scheduler-launch pthread, and new Worker() is
    // a main-thread operation. work() never proxies -- it blocks on a futex on
    // the block's own thread, where blocking stalls nothing else.
    d_worker_id = MAIN_THREAD_EM_ASM_INT(
        {
            try {
                return window.__grStartGrWireSource(
                    UTF8ToString($0), UTF8ToString($1), wasmMemory, $2 >>> 0, $3,
                    $4 >>> 0, $5 >>> 0, $6, Number($7), $8);
            } catch (error) {
                console.error('GRWire worker launch failed:', error);
                return 0;
            }
        },
        d_server.c_str(),
        d_device.c_str(),
        d_ring.data(),
        static_cast<int>(d_capacity_samples),
        &d_control,
        d_error,
        static_cast<int>(d_wire),
        d_samp_rate,
        d_decim);

    if (!d_worker_id) {
        store(&d_control.state, grwire::ERROR);
        throw std::runtime_error("could not start the GRWire worker");
    }
    return true;
}

bool GrWireSource::stop()
{
    const int worker_id = d_worker_id;
    if (!worker_id) return true;
    store(&d_control.state, grwire::CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({ window.__grStopGrWireSource($0); }, worker_id);
    d_worker_id = 0;
    return true;
}

std::string GrWireSource::worker_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(grwire::ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : std::string("the GRWire worker failed");
}

void GrWireSource::convert(const unsigned char* wire, std::size_t count, void* out) const
{
    switch (d_output) {
    case Output::COMPLEX: {
        auto* output = static_cast<gr_complex*>(out);
        switch (d_wire) {
        case grwire::Wire::CI8:
            for (std::size_t i = 0; i < count; ++i)
                output[i] = gr_complex(d_lut[wire[i * 2]], d_lut[wire[i * 2 + 1]]);
            break;
        case grwire::Wire::CI16:
            for (std::size_t i = 0; i < count; ++i) {
                std::int16_t re, im;
                std::memcpy(&re, wire + i * 4, 2);
                std::memcpy(&im, wire + i * 4 + 2, 2);
                output[i] = gr_complex(re / 32767.0f, im / 32767.0f);
            }
            break;
        case grwire::Wire::CF32:
            // Already the output format: the daemon's cf32 is native
            // little-endian floats, which is what gr_complex is here.
            std::memcpy(output, wire, count * sizeof(gr_complex));
            break;
        }
        break;
    }
    case Output::SHORT: {
        auto* output = static_cast<std::int16_t*>(out);
        for (std::size_t i = 0; i < count; ++i) {
            float re, im;
            switch (d_wire) {
            case grwire::Wire::CI8:
                re = d_lut[wire[i * 2]];
                im = d_lut[wire[i * 2 + 1]];
                break;
            case grwire::Wire::CI16: {
                std::int16_t a, b;
                std::memcpy(&a, wire + i * 4, 2);
                std::memcpy(&b, wire + i * 4 + 2, 2);
                re = a / 32767.0f;
                im = b / 32767.0f;
                break;
            }
            default:
                std::memcpy(&re, wire + i * 8, 4);
                std::memcpy(&im, wire + i * 8 + 4, 4);
                break;
            }
            output[i * 2] = static_cast<std::int16_t>(
                std::clamp(re * 32767.0f, -32767.0f, 32767.0f));
            output[i * 2 + 1] = static_cast<std::int16_t>(
                std::clamp(im * 32767.0f, -32767.0f, 32767.0f));
        }
        break;
    }
    case Output::BYTE: {
        auto* output = static_cast<std::int8_t*>(out);
        for (std::size_t i = 0; i < count; ++i) {
            float re, im;
            switch (d_wire) {
            case grwire::Wire::CI8:
                // Straight through: the wire format already is the output.
                output[i * 2] = static_cast<std::int8_t>(wire[i * 2]);
                output[i * 2 + 1] = static_cast<std::int8_t>(wire[i * 2 + 1]);
                continue;
            case grwire::Wire::CI16: {
                std::int16_t a, b;
                std::memcpy(&a, wire + i * 4, 2);
                std::memcpy(&b, wire + i * 4 + 2, 2);
                re = a / 32767.0f;
                im = b / 32767.0f;
                break;
            }
            default:
                std::memcpy(&re, wire + i * 8, 4);
                std::memcpy(&im, wire + i * 8 + 4, 4);
                break;
            }
            output[i * 2] =
                static_cast<std::int8_t>(std::clamp(re * 127.0f, -127.0f, 127.0f));
            output[i * 2 + 1] =
                static_cast<std::int8_t>(std::clamp(im * 127.0f, -127.0f, 127.0f));
        }
        break;
    }
    }
}

int GrWireSource::work(int noutput_items,
                       gr_vector_const_void_star&,
                       gr_vector_void_star& output_items)
{
    // The rate the daemon reports is the one the graph actually runs at, and it
    // is frequently not the one requested -- the daemon snaps to what the radio
    // can do. Saying so once is what stops a wrong frequency axis going
    // unnoticed.
    if (const auto rate = load(&d_control.actual_rate); rate && rate != d_reported_rate) {
        d_reported_rate = rate;
        std::printf("GRWire Source: running at %d S/s\n", rate);
    }

    // Report on a doubling schedule, so the first loss is visible and a storm
    // does not flood the console pane.
    if (const auto overruns = load(&d_control.overruns); overruns > d_reported_overruns) {
        d_reported_overruns = d_reported_overruns ? d_reported_overruns * 2 : 1;
        const auto net = load(&d_control.net_drop);
        const auto client = load(&d_control.client_drop);
        std::printf(
            "GRWire Source: %d ring overrun%s, %d samples lost"
            " (daemon reported %d network and %d client drops)\n",
            overruns,
            overruns == 1 ? "" : "s",
            load(&d_control.lost_samples),
            net,
            client);
    }

    auto* output = static_cast<unsigned char*>(output_items[0]);
    const int samples_wanted = noutput_items / d_items_per_sample;
    int produced = 0;

    while (produced < samples_wanted) {
        const auto read_pos = load(&d_control.read_pos);
        const auto write_pos = load(&d_control.write_pos);
        const std::size_t available =
            write_pos >= read_pos
                ? static_cast<std::size_t>(write_pos - read_pos)
                : d_capacity_samples - static_cast<std::size_t>(read_pos - write_pos);

        if (!available) {
            const auto state = load(&d_control.state);
            if (state == grwire::ERROR) throw std::runtime_error(worker_error());
            if (state == grwire::CANCELLED)
                return produced ? produced * d_items_per_sample : WORK_DONE;
            // A partial pass keeps the graph moving rather than holding the
            // whole flowgraph for a full buffer.
            if (produced) break;
            emscripten_futex_wait(&d_control.write_pos, write_pos, 100.0);
            continue;
        }

        const auto take = std::min({ available,
                                     static_cast<std::size_t>(samples_wanted - produced),
                                     d_capacity_samples - static_cast<std::size_t>(read_pos) });
        convert(d_ring.data() + static_cast<std::size_t>(read_pos) * d_wire_bytes,
                take,
                output + static_cast<std::size_t>(produced) * d_items_per_sample * d_item_size);
        produced += static_cast<int>(take);
        store(&d_control.read_pos,
              static_cast<std::int32_t>(
                  (static_cast<std::size_t>(read_pos) + take) % d_capacity_samples));
        wake(&d_control.read_pos);
    }

    return produced * d_items_per_sample;
}
