#pragma once

#include "plutosdr_common.hpp"

#include <gnuradio/sync_block.h>
#include <memory>
#include <string>

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

    void set_sample_rate(double samples_per_second)
    {
        d_link.set_sample_rate(samples_per_second);
    }
    void set_center_freq(double hz) { d_link.set_center_freq(hz); }
    void set_bandwidth(double hz) { d_link.set_bandwidth(hz); }
    void set_attenuation1(double db) { d_link.set_value1(db); }
    void set_attenuation2(double db) { d_link.set_value2(db); }

private:
    PlutoSdrSink(const std::string& serial,
                 int channels,
                 double sample_rate,
                 const plutosdr::Command& initial,
                 int buffer_size);

    int d_channels;
    plutosdr::WorkerLink d_link;
};
