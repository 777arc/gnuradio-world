#include "hackrf_common.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <utility>

namespace hackrf {

WorkerLink::WorkerLink(std::string label,
                       std::string direction,
                       std::string serial,
                       double sample_rate,
                       int transfer_bytes,
                       const Command& initial)
    : d_label(std::move(label)),
      d_direction(std::move(direction)),
      d_serial(std::move(serial)),
      d_sample_rate(sample_rate),
      d_transfer_bytes(transfer_bytes)
{
    if (d_direction != "rx" && d_direction != "tx")
        throw std::runtime_error(d_label + ": direction must be rx or tx");
    if (!(d_sample_rate >= 2e6 && d_sample_rate <= 20e6) ||
        d_sample_rate > static_cast<double>(INT32_MAX))
        throw std::runtime_error(d_label + ": sample rate must be 2 to 20 MS/s");
    if (d_transfer_bytes <= 0 || d_transfer_bytes > 1024 * 1024 ||
        d_transfer_bytes % 512 != 0 || d_transfer_bytes % 2 != 0)
        throw std::runtime_error(
            d_label + ": USB transfer size must be a positive multiple of 512, at most 1 MiB");

    const auto transfer_pairs = static_cast<std::size_t>(d_transfer_bytes / 2);
    const auto minimum_capacity = std::max(MIN_RING_PAIRS, transfer_pairs * 4 + 1);
    d_capacity_pairs = static_cast<std::size_t>(std::clamp(
        d_sample_rate * RING_SECONDS,
        static_cast<double>(minimum_capacity),
        static_cast<double>(MAX_RING_PAIRS)));
    d_ring.resize(d_capacity_pairs * 2);

    stage([&] {
        store(&d_control.sample_rate,
              static_cast<std::int32_t>(std::llround(initial.sample_rate)));
        set_frequency_slots(initial.center_freq);
        store(&d_control.bandwidth,
              static_cast<std::int32_t>(std::llround(initial.bandwidth)));
        store(&d_control.lna_gain,
              static_cast<std::int32_t>(std::llround(initial.lna_gain)));
        store(&d_control.vga_gain,
              static_cast<std::int32_t>(std::llround(initial.vga_gain)));
        store(&d_control.txvga_gain,
              static_cast<std::int32_t>(std::llround(initial.txvga_gain)));
        set_flag(FLAG_AMP, initial.amp);
        set_flag(FLAG_BIAS_TEE, initial.bias_tee);
    });
}

std::int32_t WorkerLink::load(const std::int32_t* value)
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void WorkerLink::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void WorkerLink::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

void WorkerLink::stage(const std::function<void()>& write_slots)
{
    const std::lock_guard<std::mutex> guard(d_command_mutex);
    write_slots();
    store(&d_control.cmd_seq, load(&d_control.cmd_seq) + 1);
}

void WorkerLink::set_frequency_slots(double hz)
{
    if (!(hz >= 1e6 && hz <= 6e9))
        throw std::runtime_error(d_label + ": center frequency must be 1 MHz to 6 GHz");
    const auto value = static_cast<std::int64_t>(std::llround(hz));
    store(&d_control.freq_hi, static_cast<std::int32_t>(value >> 32));
    store(&d_control.freq_lo, static_cast<std::int32_t>(value & 0xffffffff));
}

void WorkerLink::set_flag(std::int32_t flag, bool on)
{
    const auto flags = load(&d_control.flags);
    store(&d_control.flags, on ? flags | flag : flags & ~flag);
}

void WorkerLink::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.events, 0);
    store(&d_control.lost_samples, 0);
    store(&d_control.actual_rate, 0);
    store(&d_control.state, INITIAL);
    d_reported_rate = 0;
    d_reported_events = 0;

    d_worker_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartHackRf(
                UTF8ToString($0), UTF8ToString($1), wasmMemory, $2 >>> 0, $3,
                $4 >>> 0, $5 >>> 0, Number($6), $7);
        } catch (error) {
            console.error('HackRF worker launch failed:', error);
            return 0;
        }
    },
                                          d_direction.c_str(),
                                          d_serial.c_str(),
                                          d_ring.data(),
                                          static_cast<int>(d_capacity_pairs),
                                          &d_control,
                                          d_error,
                                          d_sample_rate,
                                          d_transfer_bytes);
    if (!d_worker_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start the " + d_label + " worker");
    }
}

void WorkerLink::stop()
{
    const int worker_id = d_worker_id;
    if (!worker_id) return;
    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({ window.__grStopHackRf($0); }, worker_id);
    d_worker_id = 0;
}

void WorkerLink::set_sample_rate(double samples_per_second)
{
    if (!(samples_per_second >= 2e6 && samples_per_second <= 20e6) ||
        samples_per_second > static_cast<double>(INT32_MAX))
        throw std::runtime_error(d_label + ": sample rate must be 2 to 20 MS/s");
    stage([&] {
        store(&d_control.sample_rate,
              static_cast<std::int32_t>(std::llround(samples_per_second)));
    });
}

void WorkerLink::set_center_freq(double hz)
{
    stage([&] { set_frequency_slots(hz); });
}

void WorkerLink::set_lna_gain(double db)
{
    stage([&] { store(&d_control.lna_gain, static_cast<std::int32_t>(std::llround(db))); });
}

void WorkerLink::set_vga_gain(double db)
{
    stage([&] { store(&d_control.vga_gain, static_cast<std::int32_t>(std::llround(db))); });
}

void WorkerLink::set_txvga_gain(double db)
{
    stage([&] { store(&d_control.txvga_gain, static_cast<std::int32_t>(std::llround(db))); });
}

void WorkerLink::set_amp(bool on)
{
    stage([&] { set_flag(FLAG_AMP, on); });
}

void WorkerLink::set_bias_tee(bool on)
{
    stage([&] { set_flag(FLAG_BIAS_TEE, on); });
}

std::size_t WorkerLink::used_pairs(std::int32_t read_pos, std::int32_t write_pos) const
{
    return write_pos >= read_pos
        ? static_cast<std::size_t>(write_pos - read_pos)
        : d_capacity_pairs - static_cast<std::size_t>(read_pos - write_pos);
}

void WorkerLink::advance_read(std::size_t pairs)
{
    store(&d_control.read_pos,
          static_cast<std::int32_t>(
              (static_cast<std::size_t>(load(&d_control.read_pos)) + pairs) %
              d_capacity_pairs));
    wake(&d_control.read_pos);
}

void WorkerLink::advance_write(std::size_t pairs)
{
    store(&d_control.write_pos,
          static_cast<std::int32_t>(
              (static_cast<std::size_t>(load(&d_control.write_pos)) + pairs) %
              d_capacity_pairs));
    wake(&d_control.write_pos);
}

void WorkerLink::await_read(std::int32_t seen)
{
    emscripten_futex_wait(&d_control.read_pos, seen, 100.0);
}

void WorkerLink::await_write(std::int32_t seen)
{
    emscripten_futex_wait(&d_control.write_pos, seen, 100.0);
}

void WorkerLink::report_rate()
{
    const auto rate = load(&d_control.actual_rate);
    if (!rate || rate == d_reported_rate) return;
    d_reported_rate = rate;
    std::printf("%s: running at %d S/s\n", d_label.c_str(), rate);
}

std::int32_t WorkerLink::due_event_report()
{
    const auto events = load(&d_control.events);
    if (events <= d_reported_events) return 0;
    d_reported_events = d_reported_events ? d_reported_events * 2 : 1;
    return events;
}

std::string WorkerLink::worker_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : "the " + d_label + " worker failed";
}

} // namespace hackrf
