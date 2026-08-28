// C++ rebuilds of gr-gsm's Python-only gr.hier_block2 compositions.
// Copyright 2016 Piotr Krysik <ptrkrysik@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <gnuradio/gsm/misc_utils/controlled_fractional_resampler_cc.h>
#include <gnuradio/gsm/misc_utils/controlled_rotator_cc.h>
#include <gnuradio/hier_block2.h>

#include <memory>

namespace wasm_gsm {

class bcch_ccch_demapper : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<bcch_ccch_demapper>;
    static sptr make(int timeslot_nr);
    explicit bcch_ccch_demapper(int timeslot_nr);

    int timeslot_nr() const { return d_timeslot_nr; }
    void set_timeslot_nr(int timeslot_nr) { d_timeslot_nr = timeslot_nr; }

private:
    int d_timeslot_nr;
};

class bcch_ccch_sdcch4_demapper : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<bcch_ccch_sdcch4_demapper>;
    static sptr make(int timeslot_nr);
    explicit bcch_ccch_sdcch4_demapper(int timeslot_nr);

    int timeslot_nr() const { return d_timeslot_nr; }
    void set_timeslot_nr(int timeslot_nr) { d_timeslot_nr = timeslot_nr; }

private:
    int d_timeslot_nr;
};

class sdcch8_demapper : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<sdcch8_demapper>;
    static sptr make(int timeslot_nr);
    explicit sdcch8_demapper(int timeslot_nr);

    int timeslot_nr() const { return d_timeslot_nr; }
    void set_timeslot_nr(int timeslot_nr) { d_timeslot_nr = timeslot_nr; }

private:
    int d_timeslot_nr;
};

class clock_offset_corrector_tagged : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<clock_offset_corrector_tagged>;
    static sptr make(double fc, int osr, double ppm, double samp_rate_in);
    clock_offset_corrector_tagged(double fc, int osr, double ppm, double samp_rate_in);

    double fc() const { return d_fc; }
    int osr() const { return d_osr; }
    double ppm() const { return d_ppm; }
    double samp_rate_in() const { return d_samp_rate_in; }

    void set_fc(double fc);
    void set_osr(int osr);
    void set_ppm(double ppm);
    void set_samp_rate_in(double samp_rate_in);

private:
    void update_corrections();

    double d_fc;
    int d_osr;
    double d_ppm;
    double d_samp_rate_in;
    double d_gsm_symbol_rate;
    double d_samp_rate_out;
    gr::gsm::controlled_fractional_resampler_cc::sptr d_resampler;
    gr::gsm::controlled_rotator_cc::sptr d_rotator;
};

} // namespace wasm_gsm
