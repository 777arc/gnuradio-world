#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// The browser's sound card, standing in for gr-audio -- which is not built here
// (no ALSA, no OSS, no PortAudio, and -DENABLE_GR_AUDIO=OFF in the GNU Radio
// configure line). Both blocks keep upstream's ids, parameters and ports; what
// changes is the device underneath, which is a Web Audio AudioContext driven by
// an AudioWorkletProcessor in runner/src/audio_worklet.js.
//
// The split is the one every browser-backed block here uses: the worklet runs
// in the browser's audio realm and cannot take a C++ mutex, so the two sides
// share a single-producer/single-consumer ring in shared WASM memory and hand
// off through atomics. See docs/audio.md.
namespace browser_audio {

enum State : std::int32_t {
    INITIAL = 0,    // the worklet has not rendered its first quantum yet
    RUNNING = 1,
    ERROR = 2,
    CANCELLED = 3,
};

// Shared-memory ABI mirrored by the CTRL indices in
// runner/src/audio_worklet.js. This is one layout in two files: adding a field
// means editing both, in the same order. Every field is written by exactly one
// side -- the ring position each direction advances, and the counters the
// worklet keeps.
struct alignas(4) Control {
    std::int32_t read_pos = 0;      // frame index; sink: worklet, source: block
    std::int32_t write_pos = 0;     // frame index; sink: block, source: worklet
    std::int32_t state = INITIAL;
    std::int32_t error_length = 0;
    std::int32_t events = 0;        // sink underruns / source overruns
    std::int32_t lost_frames = 0;
    std::int32_t actual_rate = 0;   // AudioContext.sampleRate, once it is known
    std::int32_t device_channels = 0;  // what the device really gave the worklet
};
static_assert(sizeof(Control) == 8 * sizeof(std::int32_t),
              "audio worklet control ABI changed");

// About 200 ms. With the sink blocking on ring space the ring runs full in the
// steady state, so this is also the output latency -- the same trade a native
// audio sink makes with its device buffer. Shallower clicks on any scheduler
// hiccup; deeper only delays the sound.
constexpr double RING_SECONDS = 0.2;
constexpr std::size_t MIN_RING_FRAMES = 4096;
constexpr std::size_t MAX_RING_FRAMES = 1 << 20;
constexpr std::size_t ERROR_BYTES = 512;

// Both blocks need their channel count checked before io_signature::make() is
// called with it, which is before either has a Link to check it.
int checked_channels(const std::string& label, int channels);

// The direction-independent half of the two blocks: ring sizing, the control
// block's atomics, the worklet's lifetime and the diagnostics both report. The
// browser owns every Web Audio call; this class is strictly the synchronous
// GNU Radio side of that boundary.
class Link
{
public:
    Link(std::string label,
         std::string direction,
         std::string device,
         double sample_rate,
         int channels);

    void start();
    void stop();

    std::size_t capacity_frames() const { return d_capacity_frames; }
    int channels() const { return d_channels; }
    float* ring() { return d_ring.data(); }

    std::int32_t state() const { return load(&d_control.state); }
    std::int32_t read_pos() const { return load(&d_control.read_pos); }
    std::int32_t write_pos() const { return load(&d_control.write_pos); }
    std::size_t used_frames(std::int32_t read_pos, std::int32_t write_pos) const;
    void advance_read(std::size_t frames);
    void advance_write(std::size_t frames);
    // Both wait on the position the *other* side advances, with a timeout, so a
    // stop() that arrives while the device is quiet is still noticed promptly.
    void await_read(std::int32_t seen);
    void await_write(std::int32_t seen);
    void count_lost(std::size_t frames);

    // Everything the block reports to the console pane, on a schedule that
    // survives a device that is dropping continuously.
    void report_device();
    std::int32_t due_event_report();
    std::string worker_error() const;

    // Waits up to `milliseconds` for the worklet's state to move. Used where a
    // block would otherwise busy-wait; stop() wakes it.
    void await_state(double milliseconds);

private:
    static std::int32_t load(const std::int32_t* value);
    static void store(std::int32_t* value, std::int32_t next);
    static void wake(std::int32_t* value);

    std::string d_label;
    std::string d_direction;
    std::string d_device;
    double d_sample_rate;
    int d_channels;
    std::size_t d_capacity_frames;
    std::vector<float> d_ring;
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_worklet_id = 0;
    bool d_reported_device = false;
    std::int32_t d_reported_events = 0;
};

} // namespace browser_audio

// gr-audio's audio_sink: N float streams out to the default (or named) output
// device. Upstream this block is the flowgraph's clock -- the graph runs at the
// rate the sound card consumes it, which is why GRC gives it the `throttle`
// flag -- and it is that here too, by blocking on ring space.
class BrowserAudioSink : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<BrowserAudioSink>;

    static sptr make(double sample_rate,
                     const std::string& device_name,
                     bool ok_to_block,
                     int num_inputs);

    ~BrowserAudioSink() override;
    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    BrowserAudioSink(double sample_rate,
                     const std::string& device_name,
                     bool ok_to_block,
                     int num_inputs);

    // How many frames the wall clock says are due since the last one the device
    // actually took, sleeping when none are. Only reached when the ring is full
    // and waiting is not allowed -- see the comment at its definition.
    int paced_allowance(int wanted);

    browser_audio::Link d_link;
    double d_sample_rate;
    bool d_ok_to_block;
    int d_idle_waits = 0;
    std::int64_t d_pace_start = 0;
    std::int64_t d_paced_frames = 0;
};

// gr-audio's audio_source: N float streams in from the microphone (or the named
// input device). getUserMedia's permission is granted by the editor on the Run
// click; the runner frame only re-acquires it. See docs/audio.md.
class BrowserAudioSource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<BrowserAudioSource>;

    static sptr make(double sample_rate,
                     const std::string& device_name,
                     bool ok_to_block,
                     int num_outputs);

    ~BrowserAudioSource() override;
    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    BrowserAudioSource(double sample_rate,
                       const std::string& device_name,
                       bool ok_to_block,
                       int num_outputs);

    browser_audio::Link d_link;
    bool d_ok_to_block;
    int d_silent_waits = 0;
    bool d_reported_silence = false;
};
