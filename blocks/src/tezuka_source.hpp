#pragma once

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// A Tezuka SDR board (Zynq-7020/AD9363), reached entirely over the network:
// IQ samples over a plain WebSocket (the board's iio_ws_proxy, same wire
// format as WebSocketSource -- see websocket_source.hpp -- but interleaved
// raw int16 I/Q pairs converted to gr_complex here, exactly as
// PlutoSdrSource converts its own IIO buffer) and RF properties (frequency,
// sample rate, bandwidth, gain, gain mode) over MQTT-over-WebSocket, matching
// api_controller.sh's cmd/rx/<path> topics one for one -- see docs/tezuka.md.
//
// Unlike PlutoSDR/RTL-SDR/HackRF there is no local device and no worker-owned
// command mailbox: a property setter is a fire-and-forget MQTT PUBLISH to the
// board, which applies it to the same AD9361/AD9363 IIO sysfs attributes
// PlutoSDR's own worker writes locally -- so the numeric ranges and the
// gain_mode strings are the same, only the transport differs.
class TezukaSource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<TezukaSource>;

    static sptr make(const std::string& host,
                     double sample_rate,
                     double center_freq,
                     double bandwidth,
                     double gain,
                     const std::string& gain_mode);

    ~TezukaSource() override;

    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    // Live setters. Each is one MQTT publish to cmd/rx/<path>; the board is
    // the only side that ever applies or confirms the change, so these never
    // block and never report failure -- the same fire-and-forget contract
    // the Dashboard's own d.publish() has.
    void set_sample_rate(double samples_per_second);
    void set_center_freq(double hz);
    void set_bandwidth(double hz);
    void set_gain(double db);

private:
    TezukaSource(std::string host,
                double sample_rate,
                double center_freq,
                double bandwidth,
                double gain,
                std::string gain_mode);

    enum State : std::int32_t {
        INITIAL = 0,
        RUNNING = 1,
        EOF_REACHED = 2,
        ERROR = 3,
        CANCELLED = 4,
    };

    // Same shape as WebSocketSource::Control -- see websocket_source.hpp.
    struct alignas(4) Control {
        std::int32_t read_pos = 0;       // item index (one IQ pair) in the ring
        std::int32_t write_pos = 0;
        std::int32_t state = INITIAL;
        std::int32_t error_length = 0;
        std::int32_t overruns = 0;
        std::int32_t dropped_items = 0;
    };

    static constexpr std::size_t ITEM_BYTES = 2 * sizeof(std::int16_t);  // one IQ pair
    static constexpr std::size_t RING_BYTES = 16 * 1024 * 1024;
    static constexpr std::size_t ERROR_BYTES = 512;
    // AD9361/AD9363 IIO ABI: raw samples are 12-bit codes held in int16, full
    // scale +-2048. Identical constant to PlutoSdrSource's conversion --
    // same silicon and driver, only the transport differs.
    static constexpr float RAW_SCALE = 2048.0f;

    std::string d_host;
    double d_sample_rate;
    double d_center_freq;
    double d_bandwidth;
    double d_gain;
    std::string d_gain_mode;

    std::size_t d_capacity_items;
    std::vector<unsigned char> d_ring;
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_reader_id = 0;

    std::int32_t load(const std::int32_t* value) const;
    void store(std::int32_t* value, std::int32_t next);
    void wake(std::int32_t* value);
    std::string reader_error() const;
    // Publishes cmd/rx/<path> = value on this board's shared MQTT connection.
    void publish_rx(const char* path, const std::string& value) const;
};
