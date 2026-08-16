#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace plutosdr {

enum State : std::int32_t {
    INITIAL = 0,
    RUNNING = 1,
    ERROR = 2,
    CANCELLED = 3,
};

enum GainMode : std::int32_t {
    SLOW_ATTACK = 0,
    FAST_ATTACK = 1,
    HYBRID = 2,
    MANUAL = 3,
};

constexpr std::int32_t FLAG_QUADRATURE = 1 << 0;
constexpr std::int32_t FLAG_RF_DC = 1 << 1;
constexpr std::int32_t FLAG_BB_DC = 1 << 2;

// Shared-memory ABI mirrored by CTRL in runner/src/plutosdr_worker.js. Source
// and Sink use the same layout: read_pos belongs to the consumer, write_pos to
// the producer, and the command mailbox is written only by C++ and read only by
// the worker. value*_milli is RX gain or TX attenuation, depending on direction.
struct alignas(4) Control {
    std::int32_t read_pos = 0;
    std::int32_t write_pos = 0;
    std::int32_t state = INITIAL;
    std::int32_t error_length = 0;
    std::int32_t events = 0;          // RX overruns or TX underflows
    std::int32_t lost_samples = 0;    // RX samples dropped; TX never drops
    std::int32_t actual_rate = 0;
    std::int32_t cmd_seq = 0;
    std::int32_t cmd_ack = 0;
    std::int32_t freq_hi = 0;
    std::int32_t freq_lo = 0;
    std::int32_t bandwidth = 0;
    std::int32_t value1_milli = 0;
    std::int32_t value2_milli = 0;
    std::int32_t mode1 = SLOW_ATTACK;
    std::int32_t mode2 = SLOW_ATTACK;
    std::int32_t flags = 0;
    std::int32_t sample_rate = 0;
};
static_assert(sizeof(Control) == 18 * sizeof(std::int32_t),
              "PlutoSDR worker control ABI changed");

constexpr double RING_SECONDS = 0.25;
constexpr std::size_t MIN_RING_FRAMES = 32 * 1024;
constexpr std::size_t MAX_RING_FRAMES = 1024 * 1024;
constexpr std::size_t ERROR_BYTES = 512;

// Everything the worker is told before it starts streaming, and everything a
// live setter can change afterwards. mode* and flags are RX-only; the worker
// ignores them in the TX direction, which is why the Sink leaves them default.
struct Command {
    double sample_rate = 0.0;
    double center_freq = 0.0;
    double bandwidth = 0.0;
    double value1 = 0.0;              // RX gain or TX attenuation, in dB
    double value2 = 0.0;
    GainMode mode1 = SLOW_ATTACK;
    GainMode mode2 = SLOW_ATTACK;
    std::int32_t flags = 0;
};

/**
 * The half of a PlutoSDR block that has nothing to do with its direction: the
 * ring both sides index, the shared control block, the seqlock command mailbox,
 * and the lifetime of the worker that owns the USB device. Only which end of
 * the ring a block holds, and how it converts samples, differ -- so work() and
 * the sample conversion stay in PlutoSdrSource and PlutoSdrSink, and everything
 * else lives here once. See docs/plutosdr.md.
 */
class WorkerLink
{
public:
    // `label` names the block in everything this class throws or prints;
    // `direction` is the "rx"/"tx" the worker dispatches on.
    WorkerLink(std::string label,
               std::string direction,
               std::string serial,
               int channels,
               double sample_rate,
               int buffer_size,
               const Command& initial);

    void start();   // throws unless the worker was launched
    void stop();

    // Live setters, each publishing one atomic mailbox update.
    void set_sample_rate(double samples_per_second);
    void set_center_freq(double hz);
    void set_bandwidth(double hz);
    void set_value1(double db);       // RX gain or TX attenuation
    void set_value2(double db);

    std::size_t capacity_frames() const { return d_capacity_frames; }
    std::int16_t* ring() { return d_ring.data(); }

    std::int32_t state() const { return load(&d_control.state); }
    std::int32_t read_pos() const { return load(&d_control.read_pos); }
    std::int32_t write_pos() const { return load(&d_control.write_pos); }
    // Frames the producer has written and the consumer has not taken yet.
    std::size_t used_frames(std::int32_t read_pos, std::int32_t write_pos) const;
    void advance_read(std::size_t frames);
    void advance_write(std::size_t frames);
    // Sleeps until the other side moves the position, or 100 ms passes.
    void await_read(std::int32_t seen);
    void await_write(std::int32_t seen);

    // The rate the hardware actually settled on, printed initially and after
    // each live change so the console confirms what the driver accepted.
    void report_rate();
    // The overrun/underflow count when one is worth printing, 0 otherwise. The
    // first event matters and a storm of them must not flood the pane, so this
    // reports on a doubling schedule.
    std::int32_t due_event_report();
    std::int32_t lost_samples() const { return load(&d_control.lost_samples); }

    std::string worker_error() const;

private:
    static std::int32_t load(const std::int32_t* value);
    static void store(std::int32_t* value, std::int32_t next);
    static void wake(std::int32_t* value);
    // Publishes one atomic update of the command slots: the worker re-reads
    // them whenever cmd_seq moves and retries if it moves again mid-read, so
    // the release of the counter is what makes the slot writes visible as one.
    void stage(const std::function<void()>& write_slots);
    void set_frequency_slots(double hz);

    std::string d_label;
    std::string d_direction;
    std::string d_serial;
    int d_channels;
    double d_sample_rate;
    int d_buffer_size;
    std::size_t d_capacity_frames;
    std::vector<std::int16_t> d_ring;
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_worker_id = 0;
    std::mutex d_command_mutex;
    std::int32_t d_reported_rate = 0;
    std::int32_t d_reported_events = 0;
};

} // namespace plutosdr
