#pragma once

#include "hackrf_common.hpp"

#include <gnuradio/sync_block.h>
#include <memory>
#include <string>

class HackRfSource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<HackRfSource>;

    static sptr make(const std::string& serial,
                     double sample_rate,
                     double center_freq,
                     double bandwidth,
                     double lna_gain,
                     double vga_gain,
                     bool amp,
                     bool bias_tee,
                     int transfer_bytes);

    ~HackRfSource() override;
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
    void set_lna_gain(double db) { d_link.set_lna_gain(db); }
    void set_vga_gain(double db) { d_link.set_vga_gain(db); }
    void set_amp(bool on) { d_link.set_amp(on); }
    void set_bias_tee(bool on) { d_link.set_bias_tee(on); }

private:
    HackRfSource(const std::string& serial,
                 double sample_rate,
                 int transfer_bytes,
                 const hackrf::Command& initial);

    hackrf::WorkerLink d_link;
};
