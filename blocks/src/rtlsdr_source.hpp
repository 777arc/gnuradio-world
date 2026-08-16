#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// A WebUSB-backed RTL-SDR receiver. The browser keeps the USBDevice outside
// WASM: a dedicated Web Worker owns the dongle, runs the RTL2832U register
// protocol, and keeps several bulk transfers in flight, writing raw unsigned
// 8-bit IQ pairs into this block's fixed-size shared-memory ring. work() drains
// that ring on the block's own scheduler pthread and converts.
//
// This is structurally gr-osmosdr's rtl_source_c with the producer moved into
// JavaScript: librtlsdr's async transfer callback becomes the worker's transfer
// loop, its circular buffer becomes the ring below, and its condition variable
// becomes a futex on shared memory -- the producer lives in another JS realm
// and cannot take a C++ mutex. See docs/rtlsdr.md.
class RtlSdrSource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<RtlSdrSource>;

    // How the unsigned 8-bit IQ pairs the dongle produces reach the flowgraph.
    // COMPLEX is one gr_complex per pair; the interleaved forms are two items
    // per pair, the convention GNU Radio uses for ci16/ci8 files and the one
    // wasm_gr_world_recording already follows.
    enum class Output {
        COMPLEX,  // gr_complex, (v - 127.4) / 128
        SHORT,    // interleaved int16, (v - 128) << 8
        BYTE,     // interleaved int8, v - 128
    };

    static sptr make(const std::string& serial,
                     Output output,
                     double samp_rate,
                     double center_freq,
                     bool agc,
                     double gain_db,
                     double freq_correction_ppm,
                     int direct_sampling,
                     bool bias_tee,
                     int bufflen);

    ~RtlSdrSource() override;

    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    // Live setters. Bound by GRC parameter name in registry.cpp so a QT GUI
    // Range can drive them while the flowgraph runs. Each only stages a value
    // in the command mailbox; the worker applies it between bulk transfers.
    void set_center_freq(double hz);
    void set_gain(double db);
    void set_gain_mode(bool agc);
    void set_freq_correction(double ppm);
    void set_bias_tee(bool on);

private:
    RtlSdrSource(std::string serial,
                 Output output,
                 double samp_rate,
                 double center_freq,
                 bool agc,
                 double gain_db,
                 double freq_correction_ppm,
                 int direct_sampling,
                 bool bias_tee,
                 int bufflen);

    enum State : std::int32_t {
        INITIAL = 0,
        RUNNING = 1,
        ERROR = 2,
        CANCELLED = 3,
    };

    // Command mailbox bits, mirrored in runner/src/rtlsdr_reader.js.
    static constexpr std::int32_t FLAG_AGC = 1 << 0;
    static constexpr std::int32_t FLAG_BIAS_TEE = 1 << 1;

    // Shared with the reader worker as an Int32Array. Every field is written by
    // exactly one side except the command slots, which the worker only reads.
    // Keep the field order in step with the CTRL_* indices in the worker.
    struct alignas(4) Control {
        std::int32_t read_pos = 0;       // block  -> worker, IQ pairs into ring
        std::int32_t write_pos = 0;      // worker -> block
        std::int32_t state = INITIAL;    // worker -> block
        std::int32_t error_length = 0;   // worker -> block
        std::int32_t overruns = 0;       // worker -> block, transfers dropped
        std::int32_t dropped_pairs = 0;  // worker -> block
        std::int32_t actual_rate = 0;    // worker -> block, achievable S/s
        std::int32_t cmd_seq = 0;        // block  -> worker, seqlock counter
        std::int32_t cmd_ack = 0;        // worker -> block
        std::int32_t freq_hi = 0;        // block  -> worker, Hz split in two
        std::int32_t freq_lo = 0;
        std::int32_t gain_tenths = 0;    // block  -> worker, dB * 10
        std::int32_t ppm = 0;            // block  -> worker
        std::int32_t flags = 0;          // block  -> worker, FLAG_*
    };

    // Half a second of buffering, clamped. A live source cannot backpressure
    // the dongle, so a deeper ring only delays the moment losses start; a
    // shallower one loses on any scheduler hiccup.
    static constexpr double RING_SECONDS = 0.5;
    static constexpr std::size_t MIN_RING_PAIRS = 256 * 1024;
    static constexpr std::size_t MAX_RING_PAIRS = 8 * 1024 * 1024;
    static constexpr std::size_t ERROR_BYTES = 512;

    std::string d_serial;
    Output d_output;
    double d_samp_rate;
    int d_direct_sampling;
    int d_bufflen;

    std::size_t d_item_size;       // bytes per output item
    int d_items_per_pair;          // 1 for complex, 2 interleaved
    std::size_t d_capacity_pairs;  // IQ pairs the ring holds

    std::vector<unsigned char> d_ring;  // 2 bytes per IQ pair
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_reader_id = 0;

    std::mutex d_command_mutex;    // serializes setters against each other
    std::int32_t d_reported_rate = 0;
    std::int32_t d_reported_overruns = 0;

    float d_lut[256];  // u8 -> float, filled once in the constructor

    std::int32_t load(const std::int32_t* value) const;
    void store(std::int32_t* value, std::int32_t next);
    void wake(std::int32_t* value);
    // Writes the command slots under d_command_mutex and bumps cmd_seq, which
    // is what publishes them. Every setter is one of these.
    void stage(const std::function<void()>& write_slots);
    void set_flag(std::int32_t flag, bool on);   // slot writers; call from stage()
    void set_frequency_slots(double hz);
    std::string reader_error() const;
    void convert(const unsigned char* pairs, std::size_t count, void* out) const;
};
