#include "browser_audio.hpp"

#include <emscripten/em_asm.h>
#include <emscripten/threading.h>
#include <gnuradio/high_res_timer.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <utility>

namespace browser_audio {
namespace {

// The rates gr-audio's own GRC block offers, which are also the ones every
// browser's AudioContext accepts. Outside this the constructor would be asking
// the platform for something no sound card resamples to.
constexpr double MIN_RATE = 3000.0;
constexpr double MAX_RATE = 384000.0;
// Web Audio's own limit on a node's channel count.
constexpr int MAX_CHANNELS = 32;

} // namespace

int checked_channels(const std::string& label, int channels)
{
    if (channels < 1 || channels > MAX_CHANNELS)
        throw std::runtime_error(label + ": channel count must be 1 to " +
                                 std::to_string(MAX_CHANNELS));
    return channels;
}

Link::Link(std::string label,
           std::string direction,
           std::string device,
           double sample_rate,
           int channels)
    : d_label(std::move(label)),
      d_direction(std::move(direction)),
      d_device(std::move(device)),
      d_sample_rate(sample_rate),
      d_channels(channels)
{
    if (!(d_sample_rate >= MIN_RATE && d_sample_rate <= MAX_RATE))
        throw std::runtime_error(
            d_label + ": sample rate must be 3 kHz to 384 kHz (got " +
            std::to_string(static_cast<long long>(d_sample_rate)) + ")");
    checked_channels(d_label, d_channels);

    d_capacity_frames = static_cast<std::size_t>(
        std::clamp(d_sample_rate * RING_SECONDS,
                   static_cast<double>(MIN_RING_FRAMES),
                   static_cast<double>(MAX_RING_FRAMES)));
    d_ring.assign(d_capacity_frames * static_cast<std::size_t>(d_channels), 0.0f);
}

std::int32_t Link::load(const std::int32_t* value)
{
    return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

void Link::store(std::int32_t* value, std::int32_t next)
{
    __atomic_store_n(value, next, __ATOMIC_RELEASE);
}

void Link::wake(std::int32_t* value)
{
    emscripten_futex_wake(value, INT_MAX);
}

void Link::start()
{
    store(&d_control.read_pos, 0);
    store(&d_control.write_pos, 0);
    store(&d_control.error_length, 0);
    store(&d_control.events, 0);
    store(&d_control.lost_frames, 0);
    store(&d_control.actual_rate, 0);
    store(&d_control.device_channels, 0);
    store(&d_control.state, INITIAL);
    d_reported_device = false;
    d_reported_events = 0;

    // start() runs on GNU Radio's scheduler-launch pthread; an AudioContext,
    // audioWorklet.addModule() and getUserMedia() are all main-thread work, so
    // this one short launch call proxies. work() never proxies -- it blocks on
    // a futex on the block's own scheduler thread, where blocking stalls
    // nothing else. Everything the launch does asynchronously (module fetch,
    // microphone permission) reports back through the control block, not here.
    d_worklet_id = MAIN_THREAD_EM_ASM_INT({
        try {
            return window.__grStartAudio(
                UTF8ToString($0), UTF8ToString($1), wasmMemory, $2 >>> 0, $3, $4,
                $5 >>> 0, $6 >>> 0, Number($7));
        } catch (error) {
            console.error('Audio worklet launch failed:', error);
            return 0;
        }
    },
                                          d_direction.c_str(),
                                          d_device.c_str(),
                                          d_ring.data(),
                                          static_cast<int>(d_capacity_frames),
                                          d_channels,
                                          &d_control,
                                          d_error,
                                          d_sample_rate);
    if (!d_worklet_id) {
        store(&d_control.state, ERROR);
        throw std::runtime_error("could not start " + d_label);
    }
}

void Link::stop()
{
    const int worklet_id = d_worklet_id;
    if (!worklet_id) return;
    store(&d_control.state, CANCELLED);
    wake(&d_control.read_pos);
    wake(&d_control.write_pos);
    wake(&d_control.state);
    MAIN_THREAD_EM_ASM({ window.__grStopAudio($0); }, worklet_id);
    d_worklet_id = 0;
}

std::size_t Link::used_frames(std::int32_t read_pos, std::int32_t write_pos) const
{
    return write_pos >= read_pos
        ? static_cast<std::size_t>(write_pos - read_pos)
        : d_capacity_frames - static_cast<std::size_t>(read_pos - write_pos);
}

void Link::advance_read(std::size_t frames)
{
    store(&d_control.read_pos,
          static_cast<std::int32_t>(
              (static_cast<std::size_t>(load(&d_control.read_pos)) + frames) %
              d_capacity_frames));
    wake(&d_control.read_pos);
}

void Link::advance_write(std::size_t frames)
{
    store(&d_control.write_pos,
          static_cast<std::int32_t>(
              (static_cast<std::size_t>(load(&d_control.write_pos)) + frames) %
              d_capacity_frames));
    wake(&d_control.write_pos);
}

void Link::await_read(std::int32_t seen)
{
    emscripten_futex_wait(&d_control.read_pos, seen, 100.0);
}

void Link::await_write(std::int32_t seen)
{
    emscripten_futex_wait(&d_control.write_pos, seen, 100.0);
}

void Link::await_state(double milliseconds)
{
    emscripten_futex_wait(&d_control.state, load(&d_control.state), milliseconds);
}

void Link::count_lost(std::size_t frames)
{
    store(&d_control.lost_frames,
          load(&d_control.lost_frames) + static_cast<std::int32_t>(frames));
}

void Link::report_device()
{
    if (d_reported_device) return;
    const auto rate = load(&d_control.actual_rate);
    if (!rate) return;
    d_reported_device = true;
    // Both facts are only knowable once a device has opened, and both change
    // what the samples mean: a rate the browser refused to give us is the one
    // case the worklet resamples, and a device channel count that is not the
    // block's is the one case its channels are copies or discards.
    std::string notes;
    if (rate != static_cast<std::int32_t>(std::llround(d_sample_rate)))
        notes += ", resampled from the flowgraph's " +
                 std::to_string(static_cast<long long>(d_sample_rate)) + " Hz";
    const auto device_channels = load(&d_control.device_channels);
    if (device_channels && device_channels != d_channels)
        notes += ", from a device with " + std::to_string(device_channels);
    // Printed even when there is nothing to note: it is the proof a device
    // opened at all, which is otherwise indistinguishable from silence.
    std::printf("%s: running at %d Hz, %d channel%s%s\n",
                d_label.c_str(),
                rate,
                d_channels,
                d_channels == 1 ? "" : "s",
                notes.c_str());
}

std::int32_t Link::due_event_report()
{
    const auto events = load(&d_control.events);
    if (events <= d_reported_events) return 0;
    // A doubling schedule: the first loss is visible and a storm does not flood
    // the console pane, which is what an audio device that cannot keep up
    // produces -- one event every 128 frames.
    d_reported_events = d_reported_events ? d_reported_events * 2 : 1;
    return events;
}

std::string Link::worker_error() const
{
    const auto length = std::clamp<std::int32_t>(
        load(&d_control.error_length), 0, static_cast<std::int32_t>(ERROR_BYTES - 1));
    return length ? std::string(d_error, d_error + length)
                  : d_label + " failed to open an audio device";
}

} // namespace browser_audio

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

BrowserAudioSink::sptr BrowserAudioSink::make(double sample_rate,
                                              const std::string& device_name,
                                              bool ok_to_block,
                                              int num_inputs)
{
    return sptr(new BrowserAudioSink(sample_rate, device_name, ok_to_block, num_inputs));
}

BrowserAudioSink::BrowserAudioSink(double sample_rate,
                                   const std::string& device_name,
                                   bool ok_to_block,
                                   int num_inputs)
    : gr::sync_block("audio_sink",
                     gr::io_signature::make(
                         browser_audio::checked_channels("Audio Sink", num_inputs),
                         num_inputs,
                         sizeof(float)),
                     gr::io_signature::make(0, 0, 0)),
      d_link("Audio Sink", "output", device_name, sample_rate, num_inputs),
      d_sample_rate(sample_rate),
      d_ok_to_block(ok_to_block)
{
}

BrowserAudioSink::~BrowserAudioSink() { stop(); }

bool BrowserAudioSink::start()
{
    d_idle_waits = 0;
    d_pace_start = 0;
    d_paced_frames = 0;
    d_link.start();
    return true;
}

bool BrowserAudioSink::stop()
{
    d_link.stop();
    return true;
}

// Bounded waits of 100 ms each (Link::await_read), so ten of them without the
// device taking a single frame is a second of a ring nothing is draining.
constexpr int STALL_WAITS = 10;

// The wall clock as a fallback device. Reached only when the ring is full and
// this block is not allowed to wait for it to drain -- either because OK to
// Block is off, or because there is nothing draining it at all: an AudioContext
// the browser's autoplay policy has not let start yet, or one suspended
// mid-run. Pacing rather than free-running is what keeps the rest of the
// flowgraph moving at its real rate (and the plots alive) while the samples
// themselves go nowhere, so sound simply joins in when the device opens.
int BrowserAudioSink::paced_allowance(int wanted)
{
    const auto now = gr::high_res_timer_now();
    if (!d_pace_start) {
        d_pace_start = now;
        d_paced_frames = 0;
    }
    const double elapsed = static_cast<double>(now - d_pace_start) /
                           static_cast<double>(gr::high_res_timer_tps());
    const auto due =
        static_cast<std::int64_t>(elapsed * d_sample_rate) - d_paced_frames;
    if (due <= 0) {
        // Sleeps on the control block's state word, so stop() wakes it.
        d_link.await_state(5.0);
        return 0;
    }
    const auto take = static_cast<int>(std::min<std::int64_t>(due, wanted));
    d_paced_frames += take;
    return take;
}

int BrowserAudioSink::work(int noutput_items,
                           gr_vector_const_void_star& input_items,
                           gr_vector_void_star&)
{
    d_link.report_device();
    if (const auto events = d_link.due_event_report())
        std::printf("Audio Sink: %d underrun%s; the flowgraph is not keeping up\n",
                    events, events == 1 ? "" : "s");

    const auto channels = static_cast<std::size_t>(d_link.channels());
    const auto capacity = d_link.capacity_frames();
    auto* ring = d_link.ring();
    int consumed = 0;

    while (consumed < noutput_items) {
        const auto state = d_link.state();
        if (state == browser_audio::ERROR)
            throw std::runtime_error(d_link.worker_error());
        if (state == browser_audio::CANCELLED)
            return consumed ? consumed : WORK_DONE;

        const auto read_pos = d_link.read_pos();
        const auto write_pos = d_link.write_pos();
        const auto free = capacity - d_link.used_frames(read_pos, write_pos) - 1;
        if (!free) {
            // Waiting for the device to take samples is the normal path, and
            // it is what makes this block the flowgraph's clock. The count is
            // the watchdog on it: a device that has taken nothing for a second
            // -- an AudioContext suspended after it started, or one that never
            // started at all -- must not be allowed to wedge the whole graph,
            // so the wall-clock fallback below takes over until it drains
            // again. Each wait is bounded (await_read times out), so this is a
            // count of waits, not of calls.
            if (d_ok_to_block && state == browser_audio::RUNNING &&
                d_idle_waits < STALL_WAITS) {
                d_link.await_read(read_pos);
                if (d_link.read_pos() == read_pos) ++d_idle_waits;
                else d_idle_waits = 0;
                continue;
            }
            const auto dropped = paced_allowance(noutput_items - consumed);
            if (!dropped) return consumed;
            d_link.count_lost(static_cast<std::size_t>(dropped));
            consumed += dropped;
            continue;
        }

        const auto take = std::min({ free,
                                     static_cast<std::size_t>(noutput_items - consumed),
                                     capacity - static_cast<std::size_t>(write_pos) });
        // Interleaved, because that is what one AudioWorklet render quantum
        // wants to deinterleave into its output channels.
        float* frame = ring + static_cast<std::size_t>(write_pos) * channels;
        for (std::size_t channel = 0; channel < channels; ++channel) {
            const auto* input =
                static_cast<const float*>(input_items[channel]) + consumed;
            for (std::size_t i = 0; i < take; ++i)
                frame[i * channels + channel] = input[i];
        }
        consumed += static_cast<int>(take);
        d_link.advance_write(take);
        // There was room, so the device is alive: reset both halves of the
        // fallback, whose clock starts again from the last frame it accepted.
        d_idle_waits = 0;
        d_pace_start = 0;
    }
    return consumed;
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

BrowserAudioSource::sptr BrowserAudioSource::make(double sample_rate,
                                                  const std::string& device_name,
                                                  bool ok_to_block,
                                                  int num_outputs)
{
    return sptr(
        new BrowserAudioSource(sample_rate, device_name, ok_to_block, num_outputs));
}

BrowserAudioSource::BrowserAudioSource(double sample_rate,
                                       const std::string& device_name,
                                       bool ok_to_block,
                                       int num_outputs)
    : gr::sync_block("audio_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(
                         browser_audio::checked_channels("Audio Source", num_outputs),
                         num_outputs,
                         sizeof(float))),
      d_link("Audio Source", "input", device_name, sample_rate, num_outputs),
      d_ok_to_block(ok_to_block)
{
}

BrowserAudioSource::~BrowserAudioSource() { stop(); }

bool BrowserAudioSource::start()
{
    d_silent_waits = 0;
    d_reported_silence = false;
    d_link.start();
    return true;
}

bool BrowserAudioSource::stop()
{
    d_link.stop();
    return true;
}

int BrowserAudioSource::work(int noutput_items,
                             gr_vector_const_void_star&,
                             gr_vector_void_star& output_items)
{
    d_link.report_device();
    if (const auto events = d_link.due_event_report())
        std::printf("Audio Source: %d overrun%s; the flowgraph is not keeping up\n",
                    events, events == 1 ? "" : "s");

    const auto channels = static_cast<std::size_t>(d_link.channels());
    const auto capacity = d_link.capacity_frames();
    const auto* ring = d_link.ring();
    int produced = 0;

    while (produced < noutput_items) {
        const auto state = d_link.state();
        if (state == browser_audio::ERROR)
            throw std::runtime_error(d_link.worker_error());
        if (state == browser_audio::CANCELLED)
            return produced ? produced : WORK_DONE;

        const auto read_pos = d_link.read_pos();
        const auto write_pos = d_link.write_pos();
        const auto used = d_link.used_frames(read_pos, write_pos);
        if (!used) {
            // Anything already in hand goes downstream now: a microphone
            // delivers 128 frames at a time and there is no gain in holding
            // them back for the rest of a 4096-item buffer.
            if (produced) return produced;
            // OK to Block off means never wait for the device to deliver. It
            // cannot mean returning straight away, though: the scheduler would
            // call this right back and spin a core on an empty ring, so the
            // wait is shortened rather than removed.
            if (!d_ok_to_block) {
                d_link.await_state(2.0);
                return 0;
            }
            d_link.await_write(write_pos);
            // A microphone that is open and silent still delivers frames, so a
            // few seconds of nothing means the device never opened -- most
            // often an AudioContext the autoplay policy is still holding shut.
            if (++d_silent_waits >= 20 && !d_reported_silence) {
                d_reported_silence = true;
                std::printf("Audio Source: no audio yet -- if the browser is "
                            "waiting for a gesture, click the flowgraph window\n");
            }
            continue;
        }
        d_silent_waits = 0;

        const auto take = std::min({ used,
                                     static_cast<std::size_t>(noutput_items - produced),
                                     capacity - static_cast<std::size_t>(read_pos) });
        const float* frame = ring + static_cast<std::size_t>(read_pos) * channels;
        for (std::size_t channel = 0; channel < channels; ++channel) {
            auto* output = static_cast<float*>(output_items[channel]) + produced;
            for (std::size_t i = 0; i < take; ++i)
                output[i] = frame[i * channels + channel];
        }
        produced += static_cast<int>(take);
        d_link.advance_read(take);
    }
    return produced;
}
