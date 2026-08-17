#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace hackrf {

enum State : std::int32_t {
    INITIAL = 0,
    RUNNING = 1,
    ERROR = 2,
    CANCELLED = 3,
};

constexpr std::int32_t FLAG_AMP = 1 << 0;
constexpr std::int32_t FLAG_BIAS_TEE = 1 << 1;

// Shared-memory ABI mirrored by CTRL in runner/src/hackrf_worker.js. The ring
// always contains signed interleaved 8-bit IQ pairs. Source and Sink merely own
// opposite ends of it.
struct alignas(4) Control {
    std::int32_t read_pos = 0;
    std::int32_t write_pos = 0;
    std::int32_t state = INITIAL;
    std::int32_t error_length = 0;
    std::int32_t events = 0;          // RX overruns or TX underflows
    std::int32_t lost_samples = 0;    // RX pairs dropped; TX never drops
    std::int32_t actual_rate = 0;
    std::int32_t cmd_seq = 0;
    std::int32_t cmd_ack = 0;
    std::int32_t freq_hi = 0;
    std::int32_t freq_lo = 0;
    std::int32_t bandwidth = 0;       // zero means worker-selected automatic
    std::int32_t lna_gain = 0;
    std::int32_t vga_gain = 0;
    std::int32_t txvga_gain = 0;
    std::int32_t flags = 0;
    std::int32_t sample_rate = 0;
};
static_assert(sizeof(Control) == 17 * sizeof(std::int32_t),
              "HackRF worker control ABI changed");

constexpr double RING_SECONDS = 0.25;
constexpr std::size_t MIN_RING_PAIRS = 128 * 1024;
constexpr std::size_t MAX_RING_PAIRS = 4 * 1024 * 1024;
constexpr std::size_t ERROR_BYTES = 512;

struct Command {
    double sample_rate = 0.0;
    double center_freq = 0.0;
    double bandwidth = 0.0;
    double lna_gain = 16.0;
    double vga_gain = 16.0;
    double txvga_gain = 0.0;
    bool amp = false;
    bool bias_tee = false;
};

// The direction-independent half of the two blocks: shared ring, command
// mailbox, diagnostics and worker lifetime. The worker owns all WebUSB calls;
// this class is strictly the synchronous GNU Radio side of that boundary.
class WorkerLink
{
public:
    WorkerLink(std::string label,
               std::string direction,
               std::string serial,
               double sample_rate,
               int transfer_bytes,
               const Command& initial);

    void start();
    void stop();

    void set_sample_rate(double samples_per_second);
    void set_center_freq(double hz);
    void set_lna_gain(double db);
    void set_vga_gain(double db);
    void set_txvga_gain(double db);
    void set_amp(bool on);
    void set_bias_tee(bool on);

    std::size_t capacity_pairs() const { return d_capacity_pairs; }
    std::int8_t* ring() { return d_ring.data(); }

    std::int32_t state() const { return load(&d_control.state); }
    std::int32_t read_pos() const { return load(&d_control.read_pos); }
    std::int32_t write_pos() const { return load(&d_control.write_pos); }
    std::size_t used_pairs(std::int32_t read_pos, std::int32_t write_pos) const;
    void advance_read(std::size_t pairs);
    void advance_write(std::size_t pairs);
    void await_read(std::int32_t seen);
    void await_write(std::int32_t seen);

    void report_rate();
    std::int32_t due_event_report();
    std::int32_t lost_samples() const { return load(&d_control.lost_samples); }
    std::string worker_error() const;

private:
    static std::int32_t load(const std::int32_t* value);
    static void store(std::int32_t* value, std::int32_t next);
    static void wake(std::int32_t* value);
    void stage(const std::function<void()>& write_slots);
    void set_frequency_slots(double hz);
    void set_flag(std::int32_t flag, bool on);

    std::string d_label;
    std::string d_direction;
    std::string d_serial;
    double d_sample_rate;
    int d_transfer_bytes;
    std::size_t d_capacity_pairs;
    std::vector<std::int8_t> d_ring;
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_worker_id = 0;
    std::mutex d_command_mutex;
    std::int32_t d_reported_rate = 0;
    std::int32_t d_reported_events = 0;
};

} // namespace hackrf
