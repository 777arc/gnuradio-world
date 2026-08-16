#include "plutosdr_sink.hpp"

#include <gnuradio/io_signature.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>

PlutoSdrSink::sptr PlutoSdrSink::make(const std::string& serial,
                                      int channels,
                                      double sample_rate,
                                      double center_freq,
                                      double bandwidth,
                                      int buffer_size,
                                      double attenuation1,
                                      double attenuation2)
{
    plutosdr::Command initial;
    initial.sample_rate = sample_rate;
    initial.center_freq = center_freq;
    initial.bandwidth = bandwidth;
    initial.value1 = attenuation1;
    initial.value2 = attenuation2;
    return sptr(
        new PlutoSdrSink(serial, channels, sample_rate, initial, buffer_size));
}

PlutoSdrSink::PlutoSdrSink(const std::string& serial,
                           int channels,
                           double sample_rate,
                           const plutosdr::Command& initial,
                           int buffer_size)
    : gr::sync_block("plutosdr_sink",
                     gr::io_signature::make(channels, channels, sizeof(gr_complex)),
                     gr::io_signature::make(0, 0, 0)),
      d_channels(channels),
      d_link("PlutoSDR Sink", "tx", serial, channels, sample_rate, buffer_size,
             initial)
{
}

PlutoSdrSink::~PlutoSdrSink() { stop(); }

bool PlutoSdrSink::start()
{
    d_link.start();
    return true;
}

bool PlutoSdrSink::stop()
{
    d_link.stop();
    return true;
}

int PlutoSdrSink::work(int noutput_items,
                       gr_vector_const_void_star& input_items,
                       gr_vector_void_star&)
{
    d_link.report_rate();
    if (const auto events = d_link.due_event_report())
        std::printf("PlutoSDR Sink: %d underflow%s\n",
                    events,
                    events == 1 ? "" : "s");

    const auto capacity = d_link.capacity_frames();
    int consumed = 0;
    while (consumed < noutput_items) {
        const auto state = d_link.state();
        if (state == plutosdr::ERROR) throw std::runtime_error(d_link.worker_error());
        if (state == plutosdr::CANCELLED) return consumed ? consumed : WORK_DONE;

        const auto read_pos = d_link.read_pos();
        const auto write_pos = d_link.write_pos();
        // One slot stays empty so a full ring cannot read as an empty one.
        const auto free = capacity - d_link.used_frames(read_pos, write_pos) - 1;
        if (!free) {
            // Unlike the Source, a sink must not return short: dropping transmit
            // samples silently is worse than waiting for the worker to drain.
            d_link.await_read(read_pos);
            continue;
        }

        const auto take = std::min({ free,
                                     static_cast<std::size_t>(noutput_items - consumed),
                                     capacity - static_cast<std::size_t>(write_pos) });
        for (std::size_t frame = 0; frame < take; ++frame) {
            auto* raw = d_link.ring() +
                (static_cast<std::size_t>(write_pos) + frame) * d_channels * 2;
            for (int channel = 0; channel < d_channels; ++channel) {
                const auto* input = static_cast<const gr_complex*>(input_items[channel]);
                const auto sample = input[consumed + frame];
                raw[channel * 2] = static_cast<std::int16_t>(std::clamp(
                    static_cast<int>(std::lrint(sample.real() * 32768.0f)), -32768, 32767));
                raw[channel * 2 + 1] = static_cast<std::int16_t>(std::clamp(
                    static_cast<int>(std::lrint(sample.imag() * 32768.0f)), -32768, 32767));
            }
        }
        consumed += static_cast<int>(take);
        d_link.advance_write(take);
    }
    return consumed;
}
