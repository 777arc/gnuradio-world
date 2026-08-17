#include "hackrf_sink.hpp"

#include <gnuradio/io_signature.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>

HackRfSink::sptr HackRfSink::make(const std::string& serial,
                                  double sample_rate,
                                  double center_freq,
                                  double bandwidth,
                                  double txvga_gain,
                                  bool amp,
                                  bool bias_tee,
                                  int transfer_bytes)
{
    hackrf::Command initial;
    initial.sample_rate = sample_rate;
    initial.center_freq = center_freq;
    initial.bandwidth = bandwidth;
    initial.txvga_gain = txvga_gain;
    initial.amp = amp;
    initial.bias_tee = bias_tee;
    return sptr(new HackRfSink(serial, sample_rate, transfer_bytes, initial));
}

HackRfSink::HackRfSink(const std::string& serial,
                       double sample_rate,
                       int transfer_bytes,
                       const hackrf::Command& initial)
    : gr::sync_block("hackrf_sink",
                     gr::io_signature::make(1, 1, sizeof(gr_complex)),
                     gr::io_signature::make(0, 0, 0)),
      d_link("HackRF Sink", "tx", serial, sample_rate, transfer_bytes, initial)
{
}

HackRfSink::~HackRfSink() { stop(); }

bool HackRfSink::start()
{
    d_link.start();
    return true;
}

bool HackRfSink::stop()
{
    d_link.stop();
    return true;
}

int HackRfSink::work(int noutput_items,
                     gr_vector_const_void_star& input_items,
                     gr_vector_void_star&)
{
    d_link.report_rate();
    if (const auto events = d_link.due_event_report())
        std::printf("HackRF Sink: %d underflow%s; transmitter stopped\n",
                    events,
                    events == 1 ? "" : "s");

    const auto* input = static_cast<const gr_complex*>(input_items[0]);
    const auto capacity = d_link.capacity_pairs();
    int consumed = 0;
    while (consumed < noutput_items) {
        const auto state = d_link.state();
        if (state == hackrf::ERROR) throw std::runtime_error(d_link.worker_error());
        if (state == hackrf::CANCELLED) return consumed ? consumed : WORK_DONE;

        const auto read_pos = d_link.read_pos();
        const auto write_pos = d_link.write_pos();
        const auto free = capacity - d_link.used_pairs(read_pos, write_pos) - 1;
        if (!free) {
            d_link.await_read(read_pos);
            continue;
        }

        const auto take = std::min({ free,
                                     static_cast<std::size_t>(noutput_items - consumed),
                                     capacity - static_cast<std::size_t>(write_pos) });
        auto* raw = d_link.ring() + static_cast<std::size_t>(write_pos) * 2;
        for (std::size_t i = 0; i < take; ++i) {
            const auto sample = input[consumed + i];
            raw[i * 2] = static_cast<std::int8_t>(std::clamp(
                static_cast<int>(std::lrint(sample.real() * 127.0f)), -128, 127));
            raw[i * 2 + 1] = static_cast<std::int8_t>(std::clamp(
                static_cast<int>(std::lrint(sample.imag() * 127.0f)), -128, 127));
        }
        consumed += static_cast<int>(take);
        d_link.advance_write(take);
    }
    return consumed;
}
