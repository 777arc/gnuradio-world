#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// The transmit half of the Tezuka Supported SDR pair (see tezuka_source.hpp).
// Samples go out over a plain WebSocket to the board's iio_ws_proxy, requesting
// the "iio-tx" subprotocol so this claims only the TX half of the same
// full-duplex server a TezukaSource's "iio-rx" half can share -- and RF
// properties (frequency, sample rate, bandwidth, gain) are set over
// MQTT-over-WebSocket, publishing cmd/tx/<path> exactly as api_controller.sh's
// rVMAP expects.
//
// Deliberately does NOT publish cmd/tx/active (out_altvoltage1_TX_LO_powerdown):
// that attribute is the board's own PTT logic (watchconsoletx.sh) keying the TX
// LO from DMA activity on a poll of its own, and this is a shared network board
// other tools or operators may be pointed at too -- writing it here would fight
// that script for the same register. This block only ever streams samples at
// the configured gain; whether the LO actually radiates is the board's
// decision, not this block's. Gain defaults to -89.75 dB -- the board's
// minimum output in its own sign convention (0 dB is maximum power, confirmed
// against a live board's state/caps/tx/gain) -- for the same conservative
// reason PlutoSDR Sink defaults its attenuation to minimum output.
//
// Same wire format and backpressure contract as WebSocketSink (see
// websocket_sink.hpp): a full ring blocks rather than drops, because a sink
// owns its own scheduler pthread and stalling it backpressures the flowgraph
// instead of silently losing transmit samples.
class TezukaSink : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<TezukaSink>;

    static sptr make(const std::string& host,
                     double sample_rate,
                     double center_freq,
                     double bandwidth,
                     double gain);

    ~TezukaSink() override;

    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    // Live setters. Each is one MQTT publish to cmd/tx/<path>; fire-and-forget,
    // same contract as TezukaSource's setters.
    void set_sample_rate(double samples_per_second);
    void set_center_freq(double hz);
    void set_bandwidth(double hz);
    void set_gain(double db);

private:
    TezukaSink(std::string host,
              double sample_rate,
              double center_freq,
              double bandwidth,
              double gain);

    // Same shape as WebSocketSink::State -- see websocket_sink.hpp.
    enum State : std::int32_t {
        INITIAL = 0,
        RUNNING = 1,
        FINISHING = 2,   // no more samples; drain what is there and close
        ERROR = 3,
        CANCELLED = 4,
        CLOSED = 5,      // the worker has closed the socket
    };

    struct alignas(4) Control {
        std::int32_t read_pos = 0;   // worker -> block (item index)
        std::int32_t write_pos = 0;  // block  -> worker
        std::int32_t state = INITIAL;
        std::int32_t error_length = 0;
    };

    static constexpr std::size_t ITEM_BYTES = 2 * sizeof(std::int16_t);  // one IQ pair
    static constexpr std::size_t RING_BYTES = 16 * 1024 * 1024;
    static constexpr std::size_t ERROR_BYTES = 512;
    static constexpr int FINISH_TIMEOUT_MS = 5000;
    // Full 16-bit signed scale: the AD9361/AD9363 TX datapath
    // (cf-ad9361-dds-core-lpc) takes a sample at the full int16 range even
    // though the DAC itself is fewer significant bits -- the same convention
    // PlutoSdrSink uses for the same silicon (see plutosdr_sink.cpp), and the
    // mirror image of TezukaSource's RX conversion at RAW_SCALE=2048 (12-bit
    // ADC codes read directly, no headroom to spare). Confirmed against the
    // tezuka_fw Dashboard's own iio-tx client (Signal Generator, pages2.jsx:
    // `new Int16Array(N * 2)` and `amp/100 * 32767`) rather than assumed from
    // the RX side alone -- the RX and TX IIO devices are not guaranteed to
    // expose the same scan-element count, so this is not just "the same
    // silicon" reasoning TezukaSource's own comment leans on.
    static constexpr float RAW_SCALE = 32768.0f;

    std::string d_host;
    double d_sample_rate;
    double d_center_freq;
    double d_bandwidth;
    double d_gain;

    std::size_t d_capacity_items;
    std::vector<unsigned char> d_ring;
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_writer_id = 0;

    std::int32_t load(const std::int32_t* value) const;
    void store(std::int32_t* value, std::int32_t next);
    void wake(std::int32_t* value);
    void cancel();
    std::string writer_error() const;
    // Publishes cmd/tx/<path> = value on this board's shared MQTT connection.
    void publish_tx(const char* path, const std::string& value) const;
};
