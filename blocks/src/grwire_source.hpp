#pragma once

#include <gnuradio/sync_block.h>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// A radio on another machine, over one WebSocket.
//
// Structurally this is RtlSdrSource with the transport swapped: a dedicated Web
// Worker owns the socket, parses grwire.v1 frames and writes their payload into
// this block's shared-memory ring; work() drains that ring on the block's own
// scheduler pthread and converts. The producer lives in another JavaScript
// realm and cannot take a C++ mutex, so the handoff is a futex on shared memory
// -- see docs/grwire.md and docs/rtlsdr.md, which describes the same mechanism.
//
// What differs from the USB radios is only what a network adds: the ring holds
// wire-format bytes rather than one fixed sample type, and two extra counters
// separate "the network could not keep up" from "the browser could not".
namespace grwire {

enum State : std::int32_t {
    INITIAL = 0,
    RUNNING = 1,
    ERROR = 2,
    CANCELLED = 3,
};

constexpr std::int32_t FLAG_AGC = 1 << 0;

// A stage that is not driven. Zero cannot mean this: 0 dB is a real gain, and
// silently forcing every stage to it would deafen a radio the moment a
// flowgraph was opened.
constexpr std::int32_t STAGE_UNSET = INT32_MIN;

// Shared-memory ABI, mirrored index-for-index by CTRL in
// runner/src/grwire_worker.js and specified once in grwire/proto/wire.json.
// Adding a field means editing both files in the same order, and the test in
// editor/test/grwire.test.mjs checks all three against that spec.
struct alignas(4) Control {
    std::int32_t read_pos = 0;       // block  -> worker, wire samples
    std::int32_t write_pos = 0;      // worker -> block
    std::int32_t state = INITIAL;    // worker -> block
    std::int32_t error_length = 0;   // worker -> block
    std::int32_t overruns = 0;       // worker -> block, ring-full events
    std::int32_t lost_samples = 0;   // worker -> block
    std::int32_t actual_rate = 0;    // worker -> block, the daemon's out_rate
    std::int32_t cmd_seq = 0;        // block  -> worker, seqlock counter
    std::int32_t cmd_ack = 0;        // worker -> block
    std::int32_t freq_hi = 0;        // block  -> worker, Hz split in two
    std::int32_t freq_lo = 0;
    std::int32_t offset_hi = 0;      // block  -> worker, digital offset in Hz
    std::int32_t offset_lo = 0;
    std::int32_t gain_tenths = 0;    // block  -> worker, dB * 10
    std::int32_t bandwidth = 0;      // block  -> worker, Hz, 0 means automatic
    std::int32_t flags = 0;          // block  -> worker, FLAG_*
    std::int32_t net_drop = 0;       // worker -> block, daemon's net drops
    std::int32_t client_drop = 0;    // worker -> block, daemon's client drops
    // Three positional live gain stages, tenths of a dB. Slot n drives the n-th
    // element the radio reported, so one block covers a HackRF's LNA/AMP/VGA
    // and an RTL-SDR's lone TUNER without naming either.
    std::int32_t stage1 = 0;         // block  -> worker
    std::int32_t stage2 = 0;
    std::int32_t stage3 = 0;
};
static_assert(sizeof(Control) == 21 * sizeof(std::int32_t),
              "GRWire worker control ABI changed: update grwire_worker.js and "
              "grwire/proto/wire.json in the same order");

// Half a second of buffering, the same figure the other live sources use. A
// network source cannot backpressure any more than a dongle can, so a deeper
// ring only delays the moment losses start.
constexpr double RING_SECONDS = 0.5;
constexpr std::size_t MIN_RING_SAMPLES = 256 * 1024;
constexpr std::size_t MAX_RING_SAMPLES = 8 * 1024 * 1024;
constexpr std::size_t ERROR_BYTES = 512;

// How IQ arrives on the wire. Must match Format in grwire/src/proto.rs.
enum class Wire : std::int32_t {
    CI8 = 1,
    CI16 = 2,
    CF32 = 3,
};

std::size_t wire_bytes(Wire wire);

} // namespace grwire

class GrWireSource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<GrWireSource>;

    // How samples reach the flowgraph. The interleaved forms are two items per
    // IQ sample, the convention GNU Radio uses for ci16/ci8 files and the one
    // the other radio blocks here already follow.
    enum class Output {
        COMPLEX,
        SHORT,
        BYTE,
    };

    static sptr make(const std::string& server,
                     const std::string& device,
                     Output output,
                     grwire::Wire wire,
                     double samp_rate,
                     double center_freq,
                     double offset,
                     int decim,
                     bool agc,
                     double gain_db,
                     const double* stages,
                     double bandwidth);

    ~GrWireSource() override;

    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    // Live setters, bound by GRC parameter name in registry.cpp so a QT GUI
    // Range can drive them while the graph runs. Each only stages a value in
    // the command mailbox; the worker forwards it to the daemon as JSON.
    void set_center_freq(double hz);
    void set_offset(double hz);
    void set_gain(double db);
    void set_gain_mode(bool agc);
    void set_bandwidth(double hz);
    // Positional: 1, 2 or 3, matching the radio's own element order.
    void set_stage(int which, double db);

private:
    GrWireSource(std::string server,
                 std::string device,
                 Output output,
                 grwire::Wire wire,
                 double samp_rate,
                 double center_freq,
                 double offset,
                 int decim,
                 bool agc,
                 double gain_db,
                 const double* stages,
                 double bandwidth);

    std::string d_server;
    std::string d_device;
    Output d_output;
    grwire::Wire d_wire;
    double d_samp_rate;
    int d_decim;

    std::size_t d_wire_bytes;      // bytes per IQ sample on the wire
    std::size_t d_item_size;       // bytes per output item
    int d_items_per_sample;        // 1 for complex, 2 interleaved
    std::size_t d_capacity_samples;

    std::vector<unsigned char> d_ring;
    grwire::Control d_control;
    char d_error[grwire::ERROR_BYTES]{};
    int d_worker_id = 0;

    std::mutex d_command_mutex;
    std::int32_t d_reported_rate = 0;
    std::int32_t d_reported_overruns = 0;

    float d_lut[256];  // int8 -> float, for the common ci8 wire format

    static std::int32_t load(const std::int32_t* value);
    static void store(std::int32_t* value, std::int32_t next);
    static void wake(std::int32_t* value);
    void stage(const std::function<void()>& write_slots);
    void set_flag(std::int32_t flag, bool on);
    void set_frequency_slots(double hz);
    void set_offset_slots(double hz);
    std::string worker_error() const;
    void convert(const unsigned char* wire, std::size_t count, void* out) const;
};
