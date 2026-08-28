// C++ rebuilds of gr-gsm's four Python gr.hier_block2 blocks. The mapping
// tables and connection order mirror the corresponding files under
// gr-gsm/python/gsm/ verbatim.
// Copyright 2016 Piotr Krysik <ptrkrysik@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
#include "gsm_hier.hpp"

#include <gnuradio/gsm/demapping/universal_ctrl_chans_demapper.h>
#include <gnuradio/gsm/misc_utils/msg_to_tag.h>
#include <gnuradio/io_signature.h>
#include <pmt/pmt.h>

#include <cmath>
#include <vector>

namespace wasm_gsm {
namespace {

using ints = std::vector<int>;

void wire_demapper(gr::hier_block2* hierarchy,
                   const gr::gsm::universal_ctrl_chans_demapper::sptr& demapper)
{
    hierarchy->message_port_register_hier_in(pmt::mp("bursts"));
    hierarchy->message_port_register_hier_out(pmt::mp("bursts"));
    hierarchy->msg_connect(hierarchy->self(), "bursts", demapper, "bursts");
    hierarchy->msg_connect(demapper, "bursts", hierarchy->self(), "bursts");
}

} // namespace

bcch_ccch_demapper::sptr bcch_ccch_demapper::make(int timeslot_nr)
{
    return gnuradio::make_block_sptr<bcch_ccch_demapper>(timeslot_nr);
}

bcch_ccch_demapper::bcch_ccch_demapper(int timeslot_nr)
    : gr::hier_block2("BCCH + CCCH demapper",
                      gr::io_signature::make(0, 0, 0),
                      gr::io_signature::make(0, 0, 0)),
      d_timeslot_nr(timeslot_nr)
{
    auto demapper = gr::gsm::universal_ctrl_chans_demapper::make(
        timeslot_nr,
        ints{ 0, 0, 2, 2, 2, 2, 6, 6, 6, 6, 0, 0, 12, 12, 12, 12, 16,
              16, 16, 16, 0, 0, 22, 22, 22, 22, 26, 26, 26, 26, 0, 0, 32,
              32, 32, 32, 36, 36, 36, 36, 0, 0, 42, 42, 42, 42, 46, 46, 46,
              46, 0 },
        ints{ 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 2, 2, 2, 2, 2, 2, 2,
              2, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 2, 2, 2, 2, 2, 2,
              2, 2, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 0 },
        ints{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2,
              2, 2, 2, 0, 0, 3, 3, 3, 3, 4, 4, 4, 4, 0, 0, 5, 5,
              5, 5, 6, 6, 6, 6, 0, 0, 7, 7, 7, 7, 8, 8, 8, 8, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2,
              2, 2, 2, 0, 0, 3, 3, 3, 3, 4, 4, 4, 4, 0, 0, 5, 5,
              5, 5, 6, 6, 6, 6, 0, 0, 7, 7, 7, 7, 8, 8, 8, 8, 0 },
        ints{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
              17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
              32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46,
              47, 48, 49, 50 },
        ints(51, 3),
        ints(102, 0));
    wire_demapper(this, demapper);
}

bcch_ccch_sdcch4_demapper::sptr bcch_ccch_sdcch4_demapper::make(int timeslot_nr)
{
    return gnuradio::make_block_sptr<bcch_ccch_sdcch4_demapper>(timeslot_nr);
}

bcch_ccch_sdcch4_demapper::bcch_ccch_sdcch4_demapper(int timeslot_nr)
    : gr::hier_block2("BCCH + CCCH + SDCCH/4 demapper",
                      gr::io_signature::make(0, 0, 0),
                      gr::io_signature::make(0, 0, 0)),
      d_timeslot_nr(timeslot_nr)
{
    auto demapper = gr::gsm::universal_ctrl_chans_demapper::make(
        timeslot_nr,
        ints{ 0, 0, 2, 2, 2, 2, 6, 6, 6, 6, 0, 0, 12, 12, 12, 12, 16,
              16, 16, 16, 0, 0, 22, 22, 22, 22, 26, 26, 26, 26, 0, 0, 32,
              32, 32, 32, 36, 36, 36, 36, 0, 0, 42, 42, 42, 42, 46, 46, 46,
              46, 0 },
        ints{ 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 2, 2, 2, 2, 2, 2, 2,
              2, 0, 0, 7, 7, 7, 7, 7, 7, 7, 7, 0, 0, 7, 7, 7, 7, 7, 7,
              7, 7, 0, 0, 135, 135, 135, 135, 135, 135, 135, 135, 0 },
        ints{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2,
              2, 2, 2, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 2, 2,
              2, 2, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2,
              2, 2, 2, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 2, 2,
              2, 2, 3, 3, 3, 3, 0, 0, 2, 2, 2, 2, 3, 3, 3, 3, 0 },
        ints{ 0, 0, 0, 0, 4, 5, 6, 6, 6, 6, 10, 10, 10, 10, 14, 15, 16,
              17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
              32, 33, 34, 35, 36, 37, 37, 37, 37, 41, 41, 41, 41, 45, 46,
              47, 47, 47, 47 },
        ints{ 7, 7, 7, 7, 3, 3, 135, 135, 135, 135, 135, 135, 135, 135, 3,
              3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
              3, 3, 3, 7, 7, 7, 7, 7, 7, 7, 7, 3, 3, 7, 7, 7, 7 },
        ints{ 3, 3, 3, 3, 0, 0, 2, 2, 2, 2, 3, 3, 3, 3, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 2, 2, 2, 2,
              3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 2, 2, 2, 2 });
    wire_demapper(this, demapper);
}

sdcch8_demapper::sptr sdcch8_demapper::make(int timeslot_nr)
{
    return gnuradio::make_block_sptr<sdcch8_demapper>(timeslot_nr);
}

sdcch8_demapper::sdcch8_demapper(int timeslot_nr)
    : gr::hier_block2("SDCCH/8 demapper",
                      gr::io_signature::make(0, 0, 0),
                      gr::io_signature::make(0, 0, 0)),
      d_timeslot_nr(timeslot_nr)
{
    auto demapper = gr::gsm::universal_ctrl_chans_demapper::make(
        timeslot_nr,
        ints{ 0, 0, 0, 0, 4, 4, 4, 4, 8, 8, 8, 8, 12, 12, 12, 12, 16,
              16, 16, 16, 20, 20, 20, 20, 24, 24, 24, 24, 28, 28, 28, 28,
              32, 32, 32, 32, 36, 36, 36, 36, 40, 40, 40, 40, 44, 44, 44,
              44, 0, 0, 0 },
        ints{ 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
              8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 136, 136, 136, 136,
              136, 136, 136, 136, 136, 136, 136, 136, 136, 136, 136, 136,
              0, 0, 0 },
        ints{ 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4,
              4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 0, 0,
              0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 0, 0, 0,
              0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4,
              4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 4, 4,
              4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 0, 0, 0 },
        ints{ 0, 0, 0, 0, 4, 4, 4, 4, 8, 8, 8, 8, 0, 0, 0, 15, 15, 15,
              15, 19, 19, 19, 19, 23, 23, 23, 23, 27, 27, 27, 27, 31, 31,
              31, 31, 35, 35, 35, 35, 39, 39, 39, 39, 43, 43, 43, 43, 47,
              47, 47, 47 },
        ints{ 136, 136, 136, 136, 136, 136, 136, 136, 136, 136, 136, 136,
              0, 0, 0, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
              8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 136, 136,
              136, 136 },
        ints{ 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 0, 0, 0, 0, 0,
              0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,
              4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 0, 0, 0, 0,
              1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 0, 0, 0, 0, 0,
              0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,
              4, 5, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 4, 4, 4, 4 });
    wire_demapper(this, demapper);
}

clock_offset_corrector_tagged::sptr
clock_offset_corrector_tagged::make(double fc, int osr, double ppm, double samp_rate_in)
{
    return gnuradio::make_block_sptr<clock_offset_corrector_tagged>(
        fc, osr, ppm, samp_rate_in);
}

clock_offset_corrector_tagged::clock_offset_corrector_tagged(double fc,
                                                             int osr,
                                                             double ppm,
                                                             double samp_rate_in)
    : gr::hier_block2("Clock Offset Corrector Tagged",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex))),
      d_fc(fc),
      d_osr(osr),
      d_ppm(ppm),
      d_samp_rate_in(samp_rate_in),
      d_gsm_symbol_rate(1625000.0 / 6.0),
      d_samp_rate_out(osr * d_gsm_symbol_rate)
{
    message_port_register_hier_in(pmt::mp("ctrl"));

    auto msg_to_tag = gr::gsm::msg_to_tag::make();
    d_rotator = gr::gsm::controlled_rotator_cc::make(
        d_ppm / 1.0e6 * 2.0 * 3.14159265358979323846 * d_fc / d_samp_rate_out);
    d_resampler = gr::gsm::controlled_fractional_resampler_cc::make(
        0.0f, static_cast<float>((1.0 - d_ppm / 1.0e6) *
                                 (d_samp_rate_in / d_samp_rate_out)));

    msg_connect(self(), "ctrl", msg_to_tag, "msg");
    connect(self(), 0, msg_to_tag, 0);
    connect(msg_to_tag, 0, d_resampler, 0);
    connect(d_resampler, 0, d_rotator, 0);
    connect(d_rotator, 0, self(), 0);
}

void clock_offset_corrector_tagged::update_corrections()
{
    d_rotator->set_phase_inc(d_ppm / 1.0e6 * 2.0 * 3.14159265358979323846 *
                             d_fc / d_samp_rate_out);
    d_resampler->set_resamp_ratio(static_cast<float>(
        (1.0 - d_ppm / 1.0e6) * (d_samp_rate_in / d_samp_rate_out)));
}

void clock_offset_corrector_tagged::set_fc(double fc)
{
    d_fc = fc;
    update_corrections();
}

void clock_offset_corrector_tagged::set_osr(int osr)
{
    d_osr = osr;
    d_samp_rate_out = d_osr * d_gsm_symbol_rate;
    update_corrections();
}

void clock_offset_corrector_tagged::set_ppm(double ppm)
{
    d_ppm = ppm;
    update_corrections();
}

void clock_offset_corrector_tagged::set_samp_rate_in(double samp_rate_in)
{
    d_samp_rate_in = samp_rate_in;
    update_corrections();
}

} // namespace wasm_gsm
