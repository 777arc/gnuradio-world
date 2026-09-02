#include "bb60_source.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace {

constexpr double PI = 3.14159265358979323846;

// The FIR that follows the CIC. It does two jobs: the sharp cut that keeps
// aliases out of the retained band, and undoing the CIC's passband droop,
// which is otherwise about 2.3 dB down at the band edge for a fourth-order
// stage. Designed by integrating the desired response rather than windowing a
// sinc, because that desired response is not flat.
std::vector<float> design_decimation_filter(double cutoff, std::size_t taps,
                                            int cic_factor, int cic_order)
{
    constexpr std::size_t GRID = 512;
    std::vector<double> response(taps);
    const auto centre = static_cast<double>(taps - 1) / 2.0;
    for (std::size_t i = 0; i < taps; ++i) {
        const double n = static_cast<double>(i) - centre;
        double sum = 0.0;
        for (std::size_t g = 0; g <= GRID; ++g) {
            const double u = 0.5 * static_cast<double>(g) / GRID;  // cycles/sample
            double wanted = 0.0;
            if (u <= cutoff) {
                double droop = 1.0;
                if (cic_factor > 1 && u > 0.0) {
                    const double num = std::sin(PI * u);
                    const double den = cic_factor * std::sin(PI * u / cic_factor);
                    if (den != 0.0) droop = std::pow(std::abs(num / den), cic_order);
                }
                wanted = droop > 1e-3 ? 1.0 / droop : 1.0;
            }
            const double weight = (g == 0 || g == GRID) ? 0.5 : 1.0;
            sum += weight * wanted * std::cos(2.0 * PI * u * n);
        }
        // Blackman keeps the stopband deep enough that the CIC, not the FIR,
        // sets the alias floor.
        const double window = 0.42 - 0.5 * std::cos(2.0 * PI * i / (taps - 1)) +
                              0.08 * std::cos(4.0 * PI * i / (taps - 1));
        response[i] = 2.0 * sum * (0.5 / GRID) * window;
    }
    double sum = 0.0;
    for (const auto tap : response) sum += tap;
    std::vector<float> taps_out(taps);
    for (std::size_t i = 0; i < taps; ++i)
        taps_out[i] = static_cast<float>(sum != 0.0 ? response[i] / sum : response[i]);
    return taps_out;
}

} // namespace

Bb60Source::sptr Bb60Source::make(const std::string& serial,
                                  double sample_rate,
                                  double center_freq,
                                  double bandwidth,
                                  double ref_level)
{
    return sptr(new Bb60Source(serial, sample_rate, center_freq, bandwidth, ref_level));
}

Bb60Source::Bb60Source(const std::string& serial,
                       double sample_rate,
                       double center_freq,
                       double bandwidth,
                       double ref_level)
    : gr::sync_block("bb60_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(1, 1, sizeof(gr_complex))),
      d_serial(serial)
{
    if (!(sample_rate >= 17.0e3 && sample_rate <= bb60::NATIVE_RATE))
        throw std::runtime_error(
            "BB60 Source: sample rate must be 17 kS/s to 70 MS/s");
    if (!(center_freq >= 9.0e3 && center_freq <= 6.4e9))
        throw std::runtime_error("BB60 Source: centre frequency must be 9 kHz to 6.4 GHz");
    if (!(ref_level >= -100.0 && ref_level <= 20.0))
        throw std::runtime_error("BB60 Source: reference level must be -100 to +20 dBm");

    d_decimation = std::max(1, static_cast<int>(std::llround(bb60::NATIVE_RATE / sample_rate)));
    // A CIC's response nulls sit at multiples of its own output rate, and that
    // is exactly where folding happens, so the whole game is to keep the CIC's
    // output rate well above the final one and let an FIR do the last factor.
    // Splitting 35 as 7x5 is worth 60 dB at the band edge over doing it in one
    // stage. The smallest available factor is preferred because the FIR's tap
    // count grows as the CIC's output rate does.
    d_post_decim = 1;
    for (int factor = 2; factor <= 5; ++factor)
        if (d_decimation % factor == 0 && d_decimation / factor >= 1) {
            d_post_decim = factor;
            break;
        }
    d_cic_factor = d_decimation / d_post_decim;
    d_cic_scale = 1.0 / std::pow(static_cast<double>(d_cic_factor), CIC_ORDER);

    const double output_rate = bb60::NATIVE_RATE / d_decimation;
    const double wanted = bandwidth > 0.0 ? bandwidth : output_rate * 0.8;
    if (wanted > output_rate)
        throw std::runtime_error(
            "BB60 Source: filter bandwidth exceeds the output sample rate");
    // Cutoff as a fraction of the rate the FIR runs at, which is the CIC's
    // output rate, not the block's.
    const double fir_rate = bb60::NATIVE_RATE / d_cic_factor;
    const double cutoff = std::clamp(wanted / 2.0 / fir_rate, 0.002, 0.47);
    // The first alias folds in at (output rate - passband edge), so that is
    // where the stopband has to start. Size the filter from that transition
    // rather than guessing a tap count: a wide output bandwidth leaves a
    // narrow transition and genuinely needs a longer filter.
    const double stopband = std::max(output_rate - wanted / 2.0, wanted / 2.0 * 1.05);
    const double transition = std::max((stopband - wanted / 2.0) / fir_rate, 1e-4);
    auto tap_count = static_cast<std::size_t>(std::ceil(5.5 / transition));
    tap_count = std::clamp<std::size_t>(tap_count | 1u, 31, 191);
    d_taps = design_decimation_filter(cutoff, tap_count, d_cic_factor, CIC_ORDER);
    std::printf("BB60 Source: decimate %d = CIC %d (order %d) x FIR %d, %zu taps\n",
                d_decimation, d_cic_factor, CIC_ORDER, d_post_decim, tap_count);
    d_history.assign(d_taps.size(), gr_complex(0.0f, 0.0f));

    d_capacity_samples = static_cast<std::size_t>(
        std::clamp(bb60::NATIVE_RATE * bb60::RING_SECONDS,
                   static_cast<double>(bb60::MIN_RING_SAMPLES),
                   static_cast<double>(bb60::MAX_RING_SAMPLES)));
    // Whole decimated blocks keep work() from splitting an integrate-and-dump.
    d_capacity_samples -= d_capacity_samples % static_cast<std::size_t>(d_decimation);
    d_ring.assign(d_capacity_samples, 0);

    stage([&] {
        set_frequency_slots(center_freq);
        store(&d_control.ref_level, static_cast<std::int32_t>(std::llround(ref_level)));
    });
}

Bb60Source::~Bb60Source() { stop(); }

std::int32_t Bb60Source::load(const std::int32_t* value)
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void Bb60Source::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void Bb60Source::stage(const std::function<void()>& write_slots)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    write_slots();
    store(&d_control.cmd_seq, load(&d_control.cmd_seq) + 1);
}

void Bb60Source::set_frequency_slots(double hz)
{
    if (!(hz >= 9.0e3 && hz <= 6.4e9))
        throw std::runtime_error("BB60 Source: centre frequency must be 9 kHz to 6.4 GHz");
    const auto value = static_cast<std::int64_t>(std::llround(hz));
    store(&d_control.freq_hi, static_cast<std::int32_t>(value >> 32));
    store(&d_control.freq_lo, static_cast<std::int32_t>(value & 0xffffffff));
}

void Bb60Source::set_center_freq(double hz) { stage([&] { set_frequency_slots(hz); }); }

void Bb60Source::set_ref_level(double dbm)
{
    stage([&] {
        store(&d_control.ref_level,
              static_cast<std::int32_t>(std::llround(std::clamp(dbm, -100.0, 20.0))));
    });
}

bool Bb60Source::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.events, 0);
    store(&d_control.lost_samples, 0);
    store(&d_control.actual_rate, 0);
    store(&d_control.state, bb60::INITIAL);
    d_reported_rate = 0;
    d_reported_events = 0;

    d_worker_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartBb60(
                UTF8ToString($0), wasmMemory, $1 >>> 0, $2, $3 >>> 0, $4 >>> 0);
        } catch (error) {
            console.error('BB60 worker launch failed:', error);
            return 0;
        }
    },
                                        d_serial.c_str(),
                                        d_ring.data(),
                                        static_cast<int>(d_capacity_samples),
                                        &d_control,
                                        d_error);
    if (!d_worker_id) {
        store(&d_control.state, bb60::ERROR);
        throw std::runtime_error("could not start the BB60 Source worker");
    }
    return true;
}

bool Bb60Source::stop()
{
    const int worker_id = d_worker_id;
    if (!worker_id) return true;
    store(&d_control.state, bb60::CANCELLED);
    emscripten_futex_wake(&d_control.read_pos, INT_MAX);
    emscripten_futex_wake(&d_control.write_pos, INT_MAX);
    MAIN_THREAD_EM_ASM({ window.__grStopBb60($0); }, worker_id);
    d_worker_id = 0;
    return true;
}

std::size_t Bb60Source::used_samples(std::int32_t read_pos, std::int32_t write_pos) const
{
    return write_pos >= read_pos
        ? static_cast<std::size_t>(write_pos - read_pos)
        : d_capacity_samples - static_cast<std::size_t>(read_pos - write_pos);
}

void Bb60Source::advance_read(std::size_t samples)
{
    store(&d_control.read_pos,
          static_cast<std::int32_t>(
              (static_cast<std::size_t>(load(&d_control.read_pos)) + samples) %
              d_capacity_samples));
    emscripten_futex_wake(&d_control.read_pos, INT_MAX);
}

// The worker publishes where the requested centre landed inside the 70 MS/s
// stream; the NCO only has to undo that. Rebuilt whenever the worker retunes.
void Bb60Source::refresh_rotator()
{
    const auto offset = load(&d_control.offset_hz);
    if (offset == d_rotator_offset && d_rotator_age) return;
    d_rotator_offset = offset;
    const double radians = -2.0 * PI * static_cast<double>(offset) / bb60::NATIVE_RATE;
    d_rotator_step = gr_complex(static_cast<float>(std::cos(radians)),
                                static_cast<float>(std::sin(radians)));
    d_rotator = gr_complex(1.0f, 0.0f);
    d_rotator_age = 1;
}

std::string Bb60Source::worker_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(bb60::ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : "the BB60 Source worker failed";
}

int Bb60Source::work(int noutput_items,
                     gr_vector_const_void_star&,
                     gr_vector_void_star& output_items)
{
    const auto rate = load(&d_control.actual_rate);
    if (rate && rate != d_reported_rate) {
        d_reported_rate = rate;
        std::printf("BB60 Source: device streaming at %d S/s, producing %.0f S/s\n",
                    rate, actual_sample_rate());
    }
    const auto events = load(&d_control.events);
    if (events > d_reported_events) {
        d_reported_events = d_reported_events ? d_reported_events * 2 : 1;
        std::printf("BB60 Source: %d overrun%s, %d samples lost\n",
                    events, events == 1 ? "" : "s", load(&d_control.lost_samples));
    }
    refresh_rotator();

    auto* output = static_cast<gr_complex*>(output_items[0]);
    const auto decimation = static_cast<std::size_t>(d_decimation);
    const auto taps = d_taps.size();
    int produced = 0;

    // The mixed sample is quantised before the CIC because a CIC needs
    // integer, wrap-around arithmetic to be exact: its integrators grow
    // without bound and only the comb differences bring the value back. The
    // input is 16-bit and the rotator has unit magnitude, so this loses
    // nothing that was there to begin with.
    while (produced < noutput_items) {
        const auto write_pos = load(&d_control.write_pos);
        const auto available = used_samples(load(&d_control.read_pos), write_pos);
        if (available < decimation) {
            const auto state = load(&d_control.state);
            if (state == bb60::ERROR) throw std::runtime_error(worker_error());
            if (state == bb60::CANCELLED) return produced ? produced : WORK_DONE;
            if (produced) break;
            emscripten_futex_wait(&d_control.write_pos, write_pos, 100.0);
            continue;
        }

        const auto position = static_cast<std::size_t>(load(&d_control.read_pos));
        const auto contiguous = d_capacity_samples - position;
        auto usable = std::min(available, contiguous);
        const auto room = static_cast<std::size_t>(noutput_items - produced);
        usable = std::min(usable, room * decimation + decimation);
        if (!usable) break;

        const std::int16_t* raw = d_ring.data() + position;
        float rot_r = d_rotator.real(), rot_i = d_rotator.imag();
        const float step_r = d_rotator_step.real(), step_i = d_rotator_step.imag();
        std::size_t consumed = 0;

        for (; consumed < usable; ++consumed) {
            const float sample = static_cast<float>(raw[consumed]);
            const auto xr = static_cast<std::int64_t>(std::lrint(rot_r * sample));
            const auto xi = static_cast<std::int64_t>(std::lrint(rot_i * sample));
            const float next_r = rot_r * step_r - rot_i * step_i;
            rot_i = rot_r * step_i + rot_i * step_r;
            rot_r = next_r;
            if (++d_rotator_age >= 4096) {
                const float magnitude = std::sqrt(rot_r * rot_r + rot_i * rot_i);
                if (magnitude > 0.0f) { rot_r /= magnitude; rot_i /= magnitude; }
                d_rotator_age = 1;
            }

            d_integrator_r[0] += static_cast<std::uint64_t>(xr);
            d_integrator_i[0] += static_cast<std::uint64_t>(xi);
            for (int stage = 1; stage < CIC_ORDER; ++stage) {
                d_integrator_r[stage] += d_integrator_r[stage - 1];
                d_integrator_i[stage] += d_integrator_i[stage - 1];
            }

            if (++d_cic_phase < d_cic_factor) continue;
            d_cic_phase = 0;

            std::uint64_t vr = d_integrator_r[CIC_ORDER - 1];
            std::uint64_t vi = d_integrator_i[CIC_ORDER - 1];
            for (int stage = 0; stage < CIC_ORDER; ++stage) {
                const std::uint64_t dr = vr - d_comb_r[stage];
                const std::uint64_t di = vi - d_comb_i[stage];
                d_comb_r[stage] = vr;
                d_comb_i[stage] = vi;
                vr = dr;
                vi = di;
            }
            d_history[d_history_pos] = gr_complex(
                static_cast<float>(static_cast<std::int64_t>(vr) * d_cic_scale / 32768.0),
                static_cast<float>(static_cast<std::int64_t>(vi) * d_cic_scale / 32768.0));

            if (++d_fir_phase < d_post_decim) {
                d_history_pos = d_history_pos + 1 == taps ? 0 : d_history_pos + 1;
                continue;
            }
            d_fir_phase = 0;

            gr_complex accumulated(0.0f, 0.0f);
            std::size_t index = d_history_pos;
            for (std::size_t t = 0; t < taps; ++t) {
                accumulated += d_history[index] * d_taps[t];
                index = index ? index - 1 : taps - 1;
            }
            d_history_pos = d_history_pos + 1 == taps ? 0 : d_history_pos + 1;
            output[produced++] = accumulated;
            if (produced == noutput_items) { ++consumed; break; }
        }

        d_rotator = gr_complex(rot_r, rot_i);
        advance_read(consumed);
    }
    return produced;
}
