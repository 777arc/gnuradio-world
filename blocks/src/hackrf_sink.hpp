#pragma once

#include "hackrf_common.hpp"

#include <gnuradio/sync_block.h>
#include <memory>
#include <string>

class HackRfSink : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<HackRfSink>;

    static sptr make(const std::string& serial,
                     double sample_rate,
                     double center_freq,
                     double bandwidth,
                     double txvga_gain,
                     bool amp,
                     bool bias_tee,
                     int transfer_bytes);

    ~HackRfSink() override;
    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

    void set_center_freq(double hz) { d_link.set_center_freq(hz); }
    void set_txvga_gain(double db) { d_link.set_txvga_gain(db); }
    void set_amp(bool on) { d_link.set_amp(on); }
    void set_bias_tee(bool on) { d_link.set_bias_tee(on); }

private:
    HackRfSink(const std::string& serial,
               double sample_rate,
               int transfer_bytes,
               const hackrf::Command& initial);

    hackrf::WorkerLink d_link;
};
