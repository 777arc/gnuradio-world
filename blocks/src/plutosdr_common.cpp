#include "plutosdr_common.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <utility>

namespace plutosdr {

WorkerLink::WorkerLink(std::string label,
                       std::string direction,
                       std::string serial,
                       int channels,
                       double sample_rate,
                       int buffer_size,
                       const Command& initial)
    : d_label(std::move(label)),
      d_direction(std::move(direction)),
      d_serial(std::move(serial)),
      d_channels(channels),
      d_sample_rate(sample_rate),
      d_buffer_size(buffer_size)
{
    if (d_channels != 1 && d_channels != 2)
        throw std::runtime_error(d_label + ": channels must be 1 or 2");
    if (!(d_sample_rate > 0.0))
        throw std::runtime_error(d_label + ": sample rate must be positive");
    if (!(initial.bandwidth > 0.0) || initial.bandwidth > static_cast<double>(INT32_MAX))
        throw std::runtime_error(d_label + ": invalid RF bandwidth");
    // One IIO buffer is one USB transfer, and the worker rejects anything the
    // bulk endpoint cannot carry in one.
    if (d_buffer_size <= 0 ||
        static_cast<std::uint64_t>(d_buffer_size) * d_channels * 4u > 1024u * 1024u)
        throw std::runtime_error(
            d_label + ": IIO buffer must fit in one 1 MiB USB transfer");

    // A quarter second of samples, but never less than two IIO buffers plus the
    // slot a full ring keeps empty to tell "full" from "empty" apart.
    const auto minimum_capacity = std::max(
        static_cast<double>(MIN_RING_FRAMES),
        static_cast<double>(d_buffer_size) * 2.0 + 1.0);
    d_capacity_frames = static_cast<std::size_t>(std::clamp(
        d_sample_rate * RING_SECONDS,
        minimum_capacity,
        static_cast<double>(MAX_RING_FRAMES)));
    d_ring.resize(d_capacity_frames * static_cast<std::size_t>(d_channels) * 2);

    // Stage the opening configuration as the first mailbox command rather than
    // as start() arguments, so the worker has one code path for it and for
    // every later change. This leaves cmd_seq at 1 before the worker looks.
    stage([&] {
        store(&d_control.sample_rate,
              static_cast<std::int32_t>(std::llround(initial.sample_rate)));
        set_frequency_slots(initial.center_freq);
        store(&d_control.bandwidth,
              static_cast<std::int32_t>(std::llround(initial.bandwidth)));
        store(&d_control.value1_milli,
              static_cast<std::int32_t>(std::llround(initial.value1 * 1000.0)));
        store(&d_control.value2_milli,
              static_cast<std::int32_t>(std::llround(initial.value2 * 1000.0)));
        store(&d_control.mode1, initial.mode1);
        store(&d_control.mode2, initial.mode2);
        store(&d_control.flags, initial.flags);
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
    const auto value = static_cast<std::int64_t>(std::llround(hz));
    store(&d_control.freq_hi, static_cast<std::int32_t>(value >> 32));
    store(&d_control.freq_lo, static_cast<std::int32_t>(value & 0xffffffff));
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

    // top_block::run() invokes start() from a pthread. Proxy only this short
    // worker-launch operation to the browser main thread; work() never proxies.
    d_worker_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartPlutoSdr(
                UTF8ToString($0), UTF8ToString($1), wasmMemory, $2 >>> 0, $3, $4,
                $5 >>> 0, $6 >>> 0, Number($7), $8);
        } catch (error) {
            console.error('PlutoSDR worker launch failed:', error);
            return 0;
        }
    },
                                          d_direction.c_str(),
                                          d_serial.c_str(),
                                          d_ring.data(),
                                          static_cast<int>(d_capacity_frames),
                                          d_channels,
                                          &d_control,
                                          d_error,
                                          d_sample_rate,
                                          d_buffer_size);
    if (!d_worker_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start the " + d_label + " worker");
    }
}

void WorkerLink::stop()
{
    const int worker_id = d_worker_id;
    if (!worker_id) return;
    // The worker closes itself on the CANCELLED state set here, which is what
    // lets it release the USB interface before the page terminates it.
    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    MAIN_THREAD_EM_ASM({ window.__grStopPlutoSdr($0); }, worker_id);
    d_worker_id = 0;
}

void WorkerLink::set_center_freq(double hz)
{
    stage([&] { set_frequency_slots(hz); });
}

void WorkerLink::set_sample_rate(double samples_per_second)
{
    if (!(samples_per_second > 0.0) ||
        samples_per_second > static_cast<double>(INT32_MAX))
        throw std::runtime_error(d_label + ": invalid sample rate");
    stage([&] {
        store(&d_control.sample_rate,
              static_cast<std::int32_t>(std::llround(samples_per_second)));
    });
}

void WorkerLink::set_bandwidth(double hz)
{
    stage([&] {
        store(&d_control.bandwidth, static_cast<std::int32_t>(std::llround(hz)));
    });
}

void WorkerLink::set_value1(double db)
{
    stage([&] {
        store(&d_control.value1_milli,
              static_cast<std::int32_t>(std::llround(db * 1000.0)));
    });
}

void WorkerLink::set_value2(double db)
{
    stage([&] {
        store(&d_control.value2_milli,
              static_cast<std::int32_t>(std::llround(db * 1000.0)));
    });
}

std::size_t WorkerLink::used_frames(std::int32_t read_pos, std::int32_t write_pos) const
{
    return write_pos >= read_pos
        ? static_cast<std::size_t>(write_pos - read_pos)
        : d_capacity_frames - static_cast<std::size_t>(read_pos - write_pos);
}

void WorkerLink::advance_read(std::size_t frames)
{
    store(&d_control.read_pos,
          static_cast<std::int32_t>(
              (static_cast<std::size_t>(load(&d_control.read_pos)) + frames) %
              d_capacity_frames));
    wake(&d_control.read_pos);
}

void WorkerLink::advance_write(std::size_t frames)
{
    store(&d_control.write_pos,
          static_cast<std::int32_t>(
              (static_cast<std::size_t>(load(&d_control.write_pos)) + frames) %
              d_capacity_frames));
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
    std::printf("%s: running at %d S/s with %d channel%s\n",
                d_label.c_str(),
                rate,
                d_channels,
                d_channels == 1 ? "" : "s");
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

} // namespace plutosdr
