#pragma once

#include <gnuradio/sync_block.h>
#include <complex>
#include <functional>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace bb60 {

enum State : std::int32_t {
    INITIAL = 0,
    RUNNING = 1,
    ERROR = 2,
    CANCELLED = 3,
};

// Shared-memory ABI mirrored by CTRL in runner/src/bb60_worker.js. The ring
// holds the device's own format: REAL signed 16-bit samples at a fixed
// 70 MS/s. Every bit of tuning below that rate happens on this side, which is
// how the vendor library works too -- decimation never reaches the device.
struct alignas(4) Control {
    std::int32_t read_pos = 0;
    std::int32_t write_pos = 0;
    std::int32_t state = INITIAL;
    std::int32_t error_length = 0;
    std::int32_t events = 0;         // ring overruns
    std::int32_t lost_samples = 0;
    std::int32_t actual_rate = 0;    // measured device rate, samples/second
    std::int32_t cmd_seq = 0;
    std::int32_t cmd_ack = 0;
    std::int32_t freq_hi = 0;
    std::int32_t freq_lo = 0;
    std::int32_t ref_level = 0;      // dBm, as Spike and bb_api spell it
    // Digital offset of the requested centre within the 70 MS/s stream, in Hz.
    // The worker owns the tuning arithmetic because it owns the protocol; this
    // block only needs the residual to steer its NCO. Signed, |value| < 35e6.
    std::int32_t offset_hz = 0;
};
static_assert(sizeof(Control) == 13 * sizeof(std::int32_t),
              "BB60 worker control ABI changed");

/** The device's fixed streaming rate. Not selectable: it is what the wire carries. */
constexpr double NATIVE_RATE = 70.0e6;
constexpr double RING_SECONDS = 0.12;
constexpr std::size_t MIN_RING_SAMPLES = 1u << 20;
constexpr std::size_t MAX_RING_SAMPLES = 16u << 20;
constexpr std::size_t ERROR_BYTES = 512;

} // namespace bb60

class Bb60Source : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<Bb60Source>;

    static sptr make(const std::string& serial,
                     double sample_rate,
                     double center_freq,
                     double bandwidth,
                     double ref_level);

    ~Bb60Source() override;
    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    void set_center_freq(double hz);
    void set_ref_level(double dbm);

    /** The rate actually produced: NATIVE_RATE divided by an integer. */
    double actual_sample_rate() const { return bb60::NATIVE_RATE / d_decimation; }

private:
    Bb60Source(const std::string& serial,
               double sample_rate,
               double center_freq,
               double bandwidth,
               double ref_level);

    static std::int32_t load(const std::int32_t* value);
    static void store(std::int32_t* value, std::int32_t next);
    void stage(const std::function<void()>& write_slots);
    void set_frequency_slots(double hz);
    std::size_t used_samples(std::int32_t read_pos, std::int32_t write_pos) const;
    void advance_read(std::size_t samples);
    void refresh_rotator();
    std::string worker_error() const;

    std::string d_serial;
    int d_decimation;

    // Decimation is a CIC followed by an FIR, not a single stage. An
    // integrate-and-dump (a first-order CIC) by the full factor rejects only
    // about 6 dB at the edge of the band it keeps, so every strong signal
    // within the device's 27 MHz of analogue bandwidth folds into the output.
    // A fourth-order CIC to an intermediate rate, then an FIR that does the
    // sharp cut, moves the fold points away from the retained band.
    static constexpr int CIC_ORDER = 4;
    int d_cic_factor = 1;               // CIC rate change
    int d_post_decim = 1;               // further decimation done by the FIR
    double d_cic_scale = 1.0;           // 1 / factor^order
    int d_cic_phase = 0;
    int d_fir_phase = 0;
    // Wrap-around accumulators: a CIC's integrators are meant to overflow, and
    // the comb stages recover the right answer from the wrapped values as long
    // as the final output fits. Unsigned, because signed overflow is UB.
    std::uint64_t d_integrator_r[CIC_ORDER]{};
    std::uint64_t d_integrator_i[CIC_ORDER]{};
    std::uint64_t d_comb_r[CIC_ORDER]{};
    std::uint64_t d_comb_i[CIC_ORDER]{};

    std::vector<float> d_taps;          // real lowpass, applied at the output rate
    std::vector<gr_complex> d_history;  // FIR delay line
    std::size_t d_history_pos = 0;

    gr_complex d_rotator{ 1.0f, 0.0f };
    gr_complex d_rotator_step{ 1.0f, 0.0f };
    std::int32_t d_rotator_offset = 0;  // offset_hz the step was built from
    std::size_t d_rotator_age = 0;

    std::size_t d_capacity_samples = 0;
    std::vector<std::int16_t> d_ring;
    bb60::Control d_control;
    char d_error[bb60::ERROR_BYTES]{};
    int d_worker_id = 0;
    std::mutex d_command_mutex;
    std::int32_t d_reported_rate = 0;
    std::int32_t d_reported_events = 0;
};
