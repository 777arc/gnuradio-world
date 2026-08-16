#include "plutosdr_source.hpp"

#include <gnuradio/io_signature.h>
#include <algorithm>
#include <cstdio>
#include <stdexcept>

PlutoSdrSource::sptr PlutoSdrSource::make(const std::string& serial,
                                          int channels,
                                          double sample_rate,
                                          double center_freq,
                                          double bandwidth,
                                          int buffer_size,
                                          plutosdr::GainMode gain_mode1,
                                          double gain1,
                                          plutosdr::GainMode gain_mode2,
                                          double gain2,
                                          bool quadrature,
                                          bool rf_dc,
                                          bool bb_dc)
{
    plutosdr::Command initial;
    initial.sample_rate = sample_rate;
    initial.center_freq = center_freq;
    initial.bandwidth = bandwidth;
    initial.value1 = gain1;
    initial.value2 = gain2;
    initial.mode1 = gain_mode1;
    initial.mode2 = gain_mode2;
    if (quadrature) initial.flags |= plutosdr::FLAG_QUADRATURE;
    if (rf_dc) initial.flags |= plutosdr::FLAG_RF_DC;
    if (bb_dc) initial.flags |= plutosdr::FLAG_BB_DC;
    return sptr(
        new PlutoSdrSource(serial, channels, sample_rate, initial, buffer_size));
}

PlutoSdrSource::PlutoSdrSource(const std::string& serial,
                               int channels,
                               double sample_rate,
                               const plutosdr::Command& initial,
                               int buffer_size)
    : gr::sync_block("plutosdr_source",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(channels, channels, sizeof(gr_complex))),
      d_channels(channels),
      d_link("PlutoSDR Source", "rx", serial, channels, sample_rate, buffer_size,
             initial)
{
}

PlutoSdrSource::~PlutoSdrSource() { stop(); }

bool PlutoSdrSource::start()
{
    d_link.start();
    return true;
}

bool PlutoSdrSource::stop()
{
    d_link.stop();
    return true;
}

int PlutoSdrSource::work(int noutput_items,
                         gr_vector_const_void_star&,
                         gr_vector_void_star& output_items)
{
    d_link.report_rate();
    if (const auto events = d_link.due_event_report())
        std::printf("PlutoSDR Source: %d overrun%s, %d samples lost\n",
                    events,
                    events == 1 ? "" : "s",
                    d_link.lost_samples());

    const auto capacity = d_link.capacity_frames();
    int produced = 0;
    while (produced < noutput_items) {
        const auto read_pos = d_link.read_pos();
        const auto write_pos = d_link.write_pos();
        const auto available = d_link.used_frames(read_pos, write_pos);
        if (!available) {
            const auto state = d_link.state();
            if (state == plutosdr::ERROR) throw std::runtime_error(d_link.worker_error());
            if (state == plutosdr::CANCELLED)
                return produced ? produced : WORK_DONE;
            // Returning what we have keeps the graph moving at low rates; only
            // an empty pass waits. A source owns its scheduler pthread, so
            // blocking here while the worker fills the ring stalls nothing else.
            if (produced) break;
            d_link.await_write(write_pos);
            continue;
        }

        const auto take = std::min({ available,
                                     static_cast<std::size_t>(noutput_items - produced),
                                     capacity - static_cast<std::size_t>(read_pos) });
        for (std::size_t frame = 0; frame < take; ++frame) {
            const auto* raw = d_link.ring() +
                (static_cast<std::size_t>(read_pos) + frame) * d_channels * 2;
            for (int channel = 0; channel < d_channels; ++channel) {
                auto* output = static_cast<gr_complex*>(output_items[channel]);
                output[produced + frame] = gr_complex(
                    static_cast<float>(raw[channel * 2]) / 2048.0f,
                    static_cast<float>(raw[channel * 2 + 1]) / 2048.0f);
            }
        }
        produced += static_cast<int>(take);
        d_link.advance_read(take);
    }
    return produced;
}
