#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// The SDRplay RSP1A block (also RSP1B and RSP1: the same MSi2500 + MSi001
// pair). The GNU Radio side of a shared-memory ring that
// runner/src/sdrplay_worker.js fills with int16 IQ pairs over WebUSB. The
// worker owns the whole USB protocol; this class is the synchronous consumer
// plus the command mailbox a QT GUI control writes into. See docs/sdrplay.md.
namespace sdrplay {

enum State : std::int32_t {
    INITIAL = 0,
    RUNNING = 1,
    ERROR = 2,
    CANCELLED = 3,
};

constexpr std::int32_t FLAG_BIAS_TEE = 1 << 0;
constexpr std::int32_t FLAG_FM_NOTCH = 1 << 1;
constexpr std::int32_t FLAG_DAB_NOTCH = 1 << 2;

// Shared-memory ABI mirrored by CTRL in runner/src/sdrplay_worker.js: one
// layout in two files, fields in the same order.
struct alignas(4) Control {
    std::int32_t read_pos = 0;
    std::int32_t write_pos = 0;
    std::int32_t state = INITIAL;
    std::int32_t error_length = 0;
    std::int32_t events = 0;          // overruns plus counter gaps
    std::int32_t lost_samples = 0;    // IQ pairs dropped or missing
    std::int32_t actual_rate = 0;
    std::int32_t cmd_seq = 0;
    std::int32_t cmd_ack = 0;
    std::int32_t freq_hi = 0;
    std::int32_t freq_lo = 0;
    std::int32_t sample_rate = 0;
    std::int32_t bandwidth = 0;       // zero means worker-selected automatic
    std::int32_t gain = 0;
    std::int32_t flags = 0;
    std::int32_t model = 0;           // USB product id the worker opened
};
static_assert(sizeof(Control) == 16 * sizeof(std::int32_t),
              "SDRplay worker control ABI changed");

constexpr double MIN_RATE = 1.3e6;
constexpr double MAX_RATE = 12.096e6;
constexpr double MIN_FREQ = 10e3;
constexpr double MAX_FREQ = 2e9;
constexpr double MAX_GAIN = 102.0;
constexpr int FRAME_BYTES = 1024;
constexpr int MAX_PAIRS_PER_FRAME = 504;
constexpr int TRANSFER_DEPTH = 4;
constexpr double RING_SECONDS = 0.25;
constexpr std::size_t MIN_RING_PAIRS = 128 * 1024;
constexpr std::size_t MAX_RING_PAIRS = 4 * 1024 * 1024;
constexpr std::size_t ERROR_BYTES = 512;

} // namespace sdrplay

class SdrplaySource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<SdrplaySource>;

    static sptr make(const std::string& device,
                     double sample_rate,
                     double center_freq,
                     double bandwidth,
                     double gain,
                     bool bias_tee,
                     bool fm_notch,
                     bool dab_notch,
                     int transfer_bytes);

    ~SdrplaySource() override;
    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    void set_center_freq(double hz);
    void set_gain(double db);
    void set_bias_tee(bool on);
    void set_fm_notch(bool on);
    void set_dab_notch(bool on);

private:
    SdrplaySource(const std::string& device,
                  double sample_rate,
                  double center_freq,
                  double bandwidth,
                  double gain,
                  std::int32_t flags,
                  int transfer_bytes);

    static std::int32_t load(const std::int32_t* value);
    static void store(std::int32_t* value, std::int32_t next);
    void stage(const std::function<void()>& write_slots);
    void set_frequency_slots(double hz);
    void set_flag(std::int32_t flag, bool on);
    std::size_t used_pairs(std::int32_t read_pos, std::int32_t write_pos) const;
    std::string worker_error() const;

    std::string d_device;
    double d_sample_rate;
    int d_transfer_bytes;
    std::size_t d_capacity_pairs;
    std::vector<std::int16_t> d_ring;
    sdrplay::Control d_control;
    char d_error[sdrplay::ERROR_BYTES]{};
    int d_worker_id = 0;
    std::mutex d_command_mutex;
    std::int32_t d_reported_rate = 0;
    std::int32_t d_reported_events = 0;
};
