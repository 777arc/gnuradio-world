#pragma once

#include "plutosdr_common.hpp"

#include <gnuradio/sync_block.h>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

class PlutoSdrSink : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<PlutoSdrSink>;

    static sptr make(const std::string& serial,
                     int channels,
                     double sample_rate,
                     double center_freq,
                     double bandwidth,
                     int buffer_size,
                     double attenuation1,
                     double attenuation2);

    ~PlutoSdrSink() override;
    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    void set_center_freq(double hz);
    void set_bandwidth(double hz);
    void set_attenuation1(double db);
    void set_attenuation2(double db);

private:
    PlutoSdrSink(std::string serial,
                 int channels,
                 double sample_rate,
                 double center_freq,
                 double bandwidth,
                 int buffer_size,
                 double attenuation1,
                 double attenuation2);

    std::string d_serial;
    int d_channels;
    double d_sample_rate;
    int d_buffer_size;
    std::size_t d_capacity_frames;
    std::vector<std::int16_t> d_ring;
    plutosdr::Control d_control;
    char d_error[plutosdr::ERROR_BYTES]{};
    int d_worker_id = 0;
    std::mutex d_command_mutex;
    std::int32_t d_reported_rate = 0;
    std::int32_t d_reported_events = 0;

    std::int32_t load(const std::int32_t* value) const;
    void store(std::int32_t* value, std::int32_t next);
    void wake(std::int32_t* value);
    void stage(const std::function<void()>& write_slots);
    void set_frequency_slots(double hz);
    std::string worker_error() const;
};
