#include "hackrf_source.hpp"

#include <gnuradio/io_signature.h>
#include <algorithm>
#include <cstdio>
#include <stdexcept>

HackRfSource::sptr HackRfSource::make(const std::string& serial,
                                      double sample_rate,
                                      double center_freq,
                                      double bandwidth,
                                      double lna_gain,
                                      double vga_gain,
                                      bool amp,
                                      bool bias_tee,
                                      int transfer_bytes)
{
    hackrf::Command initial;
    initial.sample_rate = sample_rate;
    initial.center_freq = center_freq;
    initial.bandwidth = bandwidth;
    initial.lna_gain = lna_gain;
    initial.vga_gain = vga_gain;
    initial.amp = amp;
    initial.bias_tee = bias_tee;
    return sptr(new HackRfSource(serial, sample_rate, transfer_bytes, initial));
}

HackRfSource::HackRfSource(const std::string& serial,
                           double sample_rate,
                           int transfer_bytes,
                           const hackrf::Command& initial)
    : gr::sync_block("hackrf_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(1, 1, sizeof(gr_complex))),
      d_link("HackRF Source", "rx", serial, sample_rate, transfer_bytes, initial)
{
}

HackRfSource::~HackRfSource() { stop(); }

bool HackRfSource::start()
{
    d_link.start();
    return true;
}

bool HackRfSource::stop()
{
    d_link.stop();
    return true;
}

int HackRfSource::work(int noutput_items,
                       gr_vector_const_void_star&,
                       gr_vector_void_star& output_items)
{
    d_link.report_rate();
    if (const auto events = d_link.due_event_report())
        std::printf("HackRF Source: %d overrun%s, %d IQ samples lost\n",
                    events,
                    events == 1 ? "" : "s",
                    d_link.lost_samples());

    auto* output = static_cast<gr_complex*>(output_items[0]);
    const auto capacity = d_link.capacity_pairs();
    int produced = 0;
    while (produced < noutput_items) {
        const auto read_pos = d_link.read_pos();
        const auto write_pos = d_link.write_pos();
        const auto available = d_link.used_pairs(read_pos, write_pos);
        if (!available) {
            const auto state = d_link.state();
            if (state == hackrf::ERROR) throw std::runtime_error(d_link.worker_error());
            if (state == hackrf::CANCELLED)
                return produced ? produced : WORK_DONE;
            if (produced) break;
            d_link.await_write(write_pos);
            continue;
        }

        const auto take = std::min({ available,
                                     static_cast<std::size_t>(noutput_items - produced),
                                     capacity - static_cast<std::size_t>(read_pos) });
        const auto* raw = d_link.ring() + static_cast<std::size_t>(read_pos) * 2;
        for (std::size_t i = 0; i < take; ++i)
            output[produced + i] = gr_complex(
                static_cast<float>(raw[i * 2]) / 128.0f,
                static_cast<float>(raw[i * 2 + 1]) / 128.0f);
        produced += static_cast<int>(take);
        d_link.advance_read(take);
    }
    return produced;
}
