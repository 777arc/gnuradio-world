// C++ rebuilds of gr-satellites' Python gr.hier_block2 compositions.
// See satellites_hier.hpp. Each class mirrors the block layout and
// connection order of the corresponding file under gr-satellites/python/, so a
// diff against the Python stays readable.
// SPDX-License-Identifier: GPL-3.0-or-later
#include "satellites_hier.hpp"

#include <gnuradio/blocks/add_const_ff.h>
#include <gnuradio/filter/fir_filter_blk.h>
#include <gnuradio/blocks/divide.h>
#include <gnuradio/blocks/float_to_complex.h>
#include <gnuradio/blocks/multiply_const.h>
#include <gnuradio/blocks/pack_k_bits_bb.h>
#include <gnuradio/blocks/rms_cf.h>
#include <gnuradio/blocks/rms_ff.h>
#include <gnuradio/blocks/tagged_stream_multiply_length.h>
#include <gnuradio/blocks/unpacked_to_packed.h>
#include <gnuradio/blocks/float_to_uchar.h>
#include <gnuradio/digital/additive_scrambler.h>
#include <gnuradio/digital/correlate_access_code_tag_bb.h>
#include <gnuradio/digital/correlate_access_code_tag_ff.h>
#include <gnuradio/fec/cc_decoder.h>
#include <gnuradio/fec/decoder.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/pdu/pdu_to_tagged_stream.h>
#include <gnuradio/pdu/tagged_stream_to_pdu.h>
#include <gnuradio/types.h>
#include <pmt/pmt.h>
#include <gnuradio/analog/quadrature_demod_cf.h>
#include <gnuradio/blocks/complex_to_real.h>
#include <gnuradio/blocks/delay.h>
#include <gnuradio/blocks/multiply_conjugate_cc.h>
#include <gnuradio/digital/constellation.h>
#include <gnuradio/digital/costas_loop_cc.h>
#include <gnuradio/digital/fll_band_edge_cc.h>
#include <gnuradio/digital/symbol_sync_cc.h>
#include <gnuradio/digital/symbol_sync_ff.h>
#include <gnuradio/filter/dc_blocker_ff.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/filter/freq_xlating_fir_filter.h>
#include <satellites/manchester_sync.h>
#include <satellites/fixedlen_to_pdu.h>

#include <cmath>
#include <cstddef>
#include <stdexcept>

namespace wasm_satellites {
namespace {

// A message-in / message-out hierarchy: no stream ports, one "in" and one "out"
// message port, matching gr-satellites' scrambler hierarchies.
class MessageHier : public gr::hier_block2
{
public:
    explicit MessageHier(const char* name)
        : gr::hier_block2(name,
                          gr::io_signature::make(0, 0, 0),
                          gr::io_signature::make(0, 0, 0))
    {
        message_port_register_hier_in(pmt::mp("in"));
        message_port_register_hier_out(pmt::mp("out"));
    }
};

// python/hier/ccsds_descrambler.py
class CcsdsDescrambler : public MessageHier
{
public:
    using sptr = std::shared_ptr<CcsdsDescrambler>;
    static sptr make() { return gnuradio::make_block_sptr<CcsdsDescrambler>(); }

    CcsdsDescrambler() : MessageHier("ccsds_descrambler")
    {
        auto scrambler = gr::digital::additive_scrambler_bb::make(
            0xA9, 0xFF, 7, 0, 1, "packet_len");
        auto unpacked_to_packed = gr::blocks::unpacked_to_packed_bb::make(
            1, gr::GR_MSB_FIRST);
        auto to_pdu = gr::pdu::tagged_stream_to_pdu::make(gr::types::byte_t,
                                                          "packet_len");
        auto multiply_length = gr::blocks::tagged_stream_multiply_length::make(
            sizeof(char) * 1, "packet_len", 1 / 8.0);
        auto from_pdu = gr::pdu::pdu_to_tagged_stream::make(gr::types::byte_t,
                                                            "packet_len");

        msg_connect(to_pdu, "pdus", self(), "out");
        msg_connect(self(), "in", from_pdu, "pdus");
        connect(from_pdu, 0, scrambler, 0);
        connect(multiply_length, 0, to_pdu, 0);
        connect(unpacked_to_packed, 0, multiply_length, 0);
        connect(scrambler, 0, unpacked_to_packed, 0);
    }
};

// python/hier/ccsds_viterbi.py -- a rate-1/2 K=7 Viterbi decoder wrapped in
// gr-fec's Python fec.extended_decoder. With threading=None, ann=None and
// puncpat='11' (what this hierarchy passes) that wrapper collapses to the
// decoder's declared input conversion followed by fec::decoder: cc_decoder
// reports get_input_conversion()=="uchar" and get_shift()==128, so the chain is
// float_to_uchar(scale=48, bias=128) -> fec::decoder.
class CcsdsViterbi : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<CcsdsViterbi>;
    static sptr make(const std::string& code)
    {
        return gnuradio::make_block_sptr<CcsdsViterbi>(code);
    }

    explicit CcsdsViterbi(const std::string& code)
        : gr::hier_block2("ccsds_viterbi",
                          gr::io_signature::make(1, 1, sizeof(float)),
                          gr::io_signature::make(1, 1, sizeof(char)))
    {
        // Viterbi27 with convention (POLYB, ~POLYA); a negative polynomial
        // means that output branch is inverted.
        std::vector<int> polys;
        if (code == "CCSDS")
            polys = { 79, -109 };
        else if (code == "NASA-DSN")
            polys = { -109, 79 };
        else if (code == "CCSDS uninverted")
            polys = { 79, 109 };
        else if (code == "NASA-DSN uninverted")
            polys = { 109, 79 };
        else
            throw std::runtime_error("unknown CCSDS Viterbi code: " + code);

        auto decoder = gr::fec::code::cc_decoder::make(
            80, 7, 2, polys, 0, -1, CC_STREAMING, false);
        auto to_uchar = gr::blocks::float_to_uchar::make(1, 48.0f, 128.0f);
        auto fec_decoder =
            gr::fec::decoder::make(decoder,
                                   gr::fec::get_decoder_input_item_size(decoder),
                                   gr::fec::get_decoder_output_item_size(decoder));

        connect(self(), 0, to_uchar, 0);
        connect(to_uchar, 0, fec_decoder, 0);
        connect(fec_decoder, 0, self(), 0);
    }
};

// python/hier/pn9_scrambler.py
class Pn9Scrambler : public MessageHier
{
public:
    using sptr = std::shared_ptr<Pn9Scrambler>;
    static sptr make() { return gnuradio::make_block_sptr<Pn9Scrambler>(); }

    Pn9Scrambler() : MessageHier("pn9_scrambler")
    {
        auto scrambler = gr::digital::additive_scrambler_bb::make(
            0x21, 0x1FF, 8, 0, 8, "packet_len");
        auto to_pdu = gr::pdu::tagged_stream_to_pdu::make(gr::types::byte_t,
                                                          "packet_len");
        auto from_pdu = gr::pdu::pdu_to_tagged_stream::make(gr::types::byte_t,
                                                            "packet_len");

        msg_connect(to_pdu, "pdus", self(), "out");
        msg_connect(self(), "in", from_pdu, "pdus");
        connect(from_pdu, 0, scrambler, 0);
        connect(scrambler, 0, to_pdu, 0);
    }
};

// python/hier/si4463_scrambler.py
class Si4463Scrambler : public MessageHier
{
public:
    using sptr = std::shared_ptr<Si4463Scrambler>;
    static sptr make() { return gnuradio::make_block_sptr<Si4463Scrambler>(); }

    Si4463Scrambler() : MessageHier("si4463_scrambler")
    {
        auto scrambler = gr::digital::additive_scrambler_bb::make(
            0x21, 0x1e1, 8, 0, 1, "packet_len");
        auto to_pdu = gr::pdu::tagged_stream_to_pdu::make(gr::types::byte_t,
                                                          "packet_len");
        auto multiply_length = gr::blocks::tagged_stream_multiply_length::make(
            sizeof(char) * 1, "packet_len", 1.0 / 8);
        auto from_pdu = gr::pdu::pdu_to_tagged_stream::make(gr::types::byte_t,
                                                            "packet_len");
        auto pack = gr::blocks::pack_k_bits_bb::make(8);

        msg_connect(to_pdu, "pdus", self(), "out");
        msg_connect(self(), "in", from_pdu, "pdus");
        connect(pack, 0, multiply_length, 0);
        connect(from_pdu, 0, scrambler, 0);
        connect(multiply_length, 0, to_pdu, 0);
        connect(scrambler, 0, pack, 0);
    }
};

// python/hier/rms_agc.py -- complex in, complex out.
class RmsAgc : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<RmsAgc>;
    static sptr make(double alpha, double reference)
    {
        return gnuradio::make_block_sptr<RmsAgc>(alpha, reference);
    }

    RmsAgc(double alpha, double reference)
        : gr::hier_block2("rms_agc",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        auto rms = gr::blocks::rms_cf::make(alpha);
        auto scale = gr::blocks::multiply_const_ff::make(1.0 / reference);
        auto to_complex = gr::blocks::float_to_complex::make(1);
        auto divide = gr::blocks::divide_cc::make(1);
        // Floor the divisor so a silent input cannot divide by zero.
        auto floor = gr::blocks::add_const_ff::make(1e-19);

        connect(floor, 0, to_complex, 0);
        connect(divide, 0, self(), 0);
        connect(to_complex, 0, divide, 1);
        connect(scale, 0, floor, 0);
        connect(rms, 0, scale, 0);
        connect(self(), 0, divide, 0);
        connect(self(), 0, rms, 0);
    }
};

// python/hier/rms_agc_f.py -- the same loop on a real input.
class RmsAgcF : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<RmsAgcF>;
    static sptr make(double alpha, double reference)
    {
        return gnuradio::make_block_sptr<RmsAgcF>(alpha, reference);
    }

    RmsAgcF(double alpha, double reference)
        : gr::hier_block2("rms_agc_f",
                          gr::io_signature::make(1, 1, sizeof(float)),
                          gr::io_signature::make(1, 1, sizeof(float)))
    {
        auto rms = gr::blocks::rms_ff::make(alpha);
        auto scale = gr::blocks::multiply_const_ff::make(1.0 / reference);
        auto divide = gr::blocks::divide_ff::make(1);
        auto floor = gr::blocks::add_const_ff::make(1e-19);

        connect(divide, 0, self(), 0);
        connect(floor, 0, divide, 1);
        connect(scale, 0, floor, 0);
        connect(rms, 0, scale, 0);
        connect(self(), 0, divide, 0);
        connect(self(), 0, rms, 0);
    }
};

// python/hier/sync_to_pdu{,_packed,_soft}.py -- correlate a syncword on a
// stream and cut fixed-length PDUs after each match. The three variants differ
// only in item type and whether fixedlen_to_pdu packs bits into bytes.
class SyncToPdu : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<SyncToPdu>;
    static sptr make(const char* name,
                     size_t itemsize,
                     gr::types::vector_type type,
                     size_t packet_len,
                     bool pack,
                     const std::string& sync,
                     int threshold)
    {
        return gnuradio::make_block_sptr<SyncToPdu>(
            name, itemsize, type, packet_len, pack, sync, threshold);
    }

    SyncToPdu(const char* name,
              size_t itemsize,
              gr::types::vector_type type,
              size_t packet_len,
              bool pack,
              const std::string& sync,
              int threshold)
        : gr::hier_block2(name,
                          gr::io_signature::make(1, 1, itemsize),
                          gr::io_signature::make(0, 0, 0))
    {
        message_port_register_hier_out(pmt::mp("out"));

        auto fixedlen = gr::satellites::fixedlen_to_pdu::make(
            type, "syncword", packet_len, pack);
        gr::basic_block_sptr correlate;
        if (type == gr::types::float_t)
            correlate = gr::digital::correlate_access_code_tag_ff::make(
                sync, threshold, "syncword");
        else
            correlate = gr::digital::correlate_access_code_tag_bb::make(
                sync, threshold, "syncword");

        msg_connect(fixedlen, "pdus", self(), "out");
        connect(correlate, 0, fixedlen, 0);
        connect(self(), 0, correlate, 0);
    }
};

// gr_satellites' argparse defaults for the demodulator options_blocks. The GRC
// `options` parameter is a command-line string; nothing in the browser supplies
// one, so these stand in for what options_block would have parsed.
constexpr float kClkRelBw = 0.06f;      // --clk_bw
constexpr float kClkLimit = 0.004f;     // --clk_limit
constexpr float kRrcAlpha = 0.35f;      // --rrc_alpha
constexpr float kFllBw = 25.0f;         // --fll_bw
constexpr float kCostasBw = 50.0f;      // --costas_bw
constexpr int kManchesterBlockSize = 32; // --manchester_block_size
constexpr double kFmDeviationHz = 3000.0; // --fm_deviation (AFSK)

// python/components/demodulators/fsk_demodulator.py
//
// use_agc is options.use_agc || !iq, and the AFSK demodulator instantiates this
// with iq=true and dc_block=false, so both flags are constructor arguments here
// rather than being derived twice.
class FskDemodulator : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<FskDemodulator>;
    static sptr make(double baudrate,
                     double samp_rate,
                     bool iq,
                     double deviation,
                     bool subaudio,
                     bool dc_block)
    {
        return gnuradio::make_block_sptr<FskDemodulator>(
            baudrate, samp_rate, iq, deviation, subaudio, dc_block);
    }

    FskDemodulator(double baudrate,
                   double samp_rate,
                   bool iq,
                   double deviation,
                   bool subaudio,
                   bool dc_block)
        : gr::hier_block2("fsk_demodulator",
                          gr::io_signature::make(
                              1, 1, iq ? sizeof(gr_complex) : sizeof(float)),
                          gr::io_signature::make(1, 1, sizeof(float)))
    {
        const bool use_agc = !iq;
        // Prevent problems due to baudrate too high.
        if (baudrate >= samp_rate)
            baudrate = samp_rate / 2;

        // Front end: FM-demodulate IQ input, optionally band-limiting to
        // Carson's rule first. Real input is assumed already FM-demodulated.
        gr::basic_block_sptr head;
        if (iq) {
            const double carson_cutoff = std::abs(deviation) + baudrate / 2;
            auto demod = gr::analog::quadrature_demod_cf::make(
                samp_rate / (2 * M_PI * deviation));
            if (carson_cutoff >= samp_rate / 2) {
                connect(self(), 0, demod, 0);
            } else {
                auto demod_filter = gr::filter::fir_filter_ccf::make(
                    1,
                    gr::filter::firdes::low_pass(
                        1, samp_rate, carson_cutoff, 0.1 * carson_cutoff));
                connect(self(), 0, demod_filter, 0);
                connect(demod_filter, 0, demod, 0);
            }
            head = demod;
        }

        double sps = samp_rate / baudrate;
        const int max_sps = 10;
        const int decimation =
            sps > max_sps ? static_cast<int>(std::ceil(sps / max_sps)) : 1;
        sps /= decimation;

        std::vector<gr::basic_block_sptr> chain;
        if (subaudio) {
            const double subaudio_cutoff = 2.0 / 3.0 * baudrate;
            chain.push_back(gr::filter::fir_filter_fff::make(
                1,
                gr::filter::firdes::low_pass(
                    1, samp_rate, subaudio_cutoff, subaudio_cutoff / 4.0)));
        }
        // Square pulse matched filter.
        const int sqfilter_len = static_cast<int>(samp_rate / baudrate);
        chain.push_back(gr::filter::fir_filter_fff::make(
            decimation,
            std::vector<float>(sqfilter_len, 1.0f / sqfilter_len)));
        if (dc_block)
            chain.push_back(gr::filter::dc_blocker_ff::make(
                static_cast<int>(std::ceil(sps * 32)), true));
        if (use_agc)
            // 2e-2 / sps gives a time constant of 50 symbols.
            chain.push_back(RmsAgcF::make(2e-2 / sps, 1));

        // "Empiric" formula for the TED gain of a Gardner detector: 1.47/symbol.
        chain.push_back(gr::digital::symbol_sync_ff::make(
            gr::digital::TED_GARDNER,
            static_cast<float>(sps),
            kClkRelBw,
            1.0f,
            1.47f,
            static_cast<float>(kClkLimit * sps),
            1,
            gr::digital::constellation_bpsk::make()->base(),
            gr::digital::IR_PFB_NO_MF));

        if (!iq && deviation < 0)
            // With FM-demodulated input a negative deviation means the tone
            // mapping is inverted, so undo it here.
            chain.push_back(gr::blocks::multiply_const_ff::make(-1, 1));

        if (head)
            connect(head, 0, chain.front(), 0);
        else
            connect(self(), 0, chain.front(), 0);
        for (std::size_t i = 0; i + 1 < chain.size(); ++i)
            connect(chain[i], 0, chain[i + 1], 0);
        connect(chain.back(), 0, self(), 0);
    }
};

// python/components/demodulators/afsk_demodulator.py -- FM-demodulate (for IQ),
// shift the audio subcarrier down to baseband, then reuse the FSK demodulator.
class AfskDemodulator : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<AfskDemodulator>;
    static sptr make(double baudrate,
                     double samp_rate,
                     bool iq,
                     double af_carrier,
                     double deviation)
    {
        return gnuradio::make_block_sptr<AfskDemodulator>(
            baudrate, samp_rate, iq, af_carrier, deviation);
    }

    AfskDemodulator(double baudrate,
                    double samp_rate,
                    bool iq,
                    double af_carrier,
                    double deviation)
        : gr::hier_block2("afsk_demodulator",
                          gr::io_signature::make(
                              1, 1, iq ? sizeof(gr_complex) : sizeof(float)),
                          gr::io_signature::make(1, 1, sizeof(float)))
    {
        gr::basic_block_sptr head;
        if (iq) {
            const double carson_cutoff =
                kFmDeviationHz + af_carrier + std::abs(deviation);
            auto demod = gr::analog::quadrature_demod_cf::make(1);
            if (carson_cutoff >= samp_rate / 2) {
                connect(self(), 0, demod, 0);
            } else {
                auto demod_filter = gr::filter::fir_filter_ccf::make(
                    1,
                    gr::filter::firdes::low_pass(
                        1, samp_rate, carson_cutoff, 0.1 * carson_cutoff));
                connect(self(), 0, demod_filter, 0);
                connect(demod_filter, 0, demod, 0);
            }
            head = demod;
        }

        auto xlating = gr::filter::freq_xlating_fir_filter_fcf::make(
            1,
            gr::filter::firdes::low_pass(1,
                                         samp_rate,
                                         2 * std::abs(deviation),
                                         0.1 * std::abs(deviation)),
            af_carrier,
            samp_rate);
        // The inner FSK demodulator sees the already-shifted audio tone pair,
        // so it runs in iq=true mode with the DC blocker disabled.
        auto fsk = FskDemodulator::make(
            baudrate, samp_rate, true, deviation, false, false);

        if (head)
            connect(head, 0, xlating, 0);
        else
            connect(self(), 0, xlating, 0);
        connect(xlating, 0, fsk, 0);
        connect(fsk, 0, self(), 0);
    }
};

// python/components/demodulators/bpsk_demodulator.py
class BpskDemodulator : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<BpskDemodulator>;
    static sptr make(double baudrate,
                     double samp_rate,
                     double f_offset,
                     bool differential,
                     bool manchester,
                     bool iq)
    {
        return gnuradio::make_block_sptr<BpskDemodulator>(
            baudrate, samp_rate, f_offset, differential, manchester, iq);
    }

    BpskDemodulator(double baudrate,
                    double samp_rate,
                    double f_offset,
                    bool differential,
                    bool manchester,
                    bool iq)
        : gr::hier_block2("bpsk_demodulator",
                          gr::io_signature::make(
                              1, 1, iq ? sizeof(gr_complex) : sizeof(float)),
                          gr::io_signature::make(1, 1, sizeof(float)))
    {
        if (manchester)
            baudrate *= 2;
        // Prevent problems due to baudrate too high.
        if (baudrate >= samp_rate / 4)
            baudrate = samp_rate / 4;

        double sps = samp_rate / baudrate;
        const int max_sps = 10;
        const int decimation =
            sps > max_sps ? static_cast<int>(std::ceil(sps / max_sps)) : 1;
        sps /= decimation;

        const auto taps = gr::filter::firdes::low_pass(
            1, samp_rate, baudrate * 2.0, baudrate * 0.2);
        gr::basic_block_sptr xlating;
        if (iq)
            xlating = gr::filter::freq_xlating_fir_filter_ccf::make(
                decimation, taps, f_offset, samp_rate);
        else
            xlating = gr::filter::freq_xlating_fir_filter_fcf::make(
                decimation, taps, f_offset, samp_rate);

        // 2e-2 / sps gives a time constant of 50 symbols.
        auto agc = RmsAgc::make(2e-2 / sps, 1);
        auto fll = gr::digital::fll_band_edge_cc::make(
            sps, kRrcAlpha, 100, 2 * M_PI * decimation / samp_rate * kFllBw);

        const int nfilts = 16;
        const auto rrc_taps = gr::filter::firdes::root_raised_cosine(
            nfilts,
            nfilts,
            1.0 / sps,
            kRrcAlpha,
            static_cast<int>(std::ceil(11 * sps * nfilts)));
        // "Empiric" formula for the TED gain of a PFB MF TED for complex BPSK:
        // 0.5/sample.
        auto clock_recovery = gr::digital::symbol_sync_cc::make(
            gr::digital::TED_SIGNAL_TIMES_SLOPE_ML,
            static_cast<float>(sps),
            kClkRelBw,
            1.0f,
            0.5f,
            static_cast<float>(kClkLimit * sps),
            1,
            gr::digital::constellation_bpsk::make()->base(),
            gr::digital::IR_PFB_MF,
            nfilts,
            rrc_taps);

        connect(self(), 0, xlating, 0);
        connect(xlating, 0, agc, 0);
        connect(agc, 0, fll, 0);
        connect(fll, 0, clock_recovery, 0);

        auto complex_to_real = gr::blocks::complex_to_real::make(1);
        gr::basic_block_sptr symbols = clock_recovery;
        if (manchester) {
            auto manchester_sync =
                gr::satellites::manchester_sync_cc::make(kManchesterBlockSize);
            connect(clock_recovery, 0, manchester_sync, 0);
            symbols = manchester_sync;
        }

        if (differential) {
            auto delay = gr::blocks::delay::make(sizeof(gr_complex), 1);
            auto multiply_conj = gr::blocks::multiply_conjugate_cc::make(1);
            // Manchester decoding inverts the sense of the differential.
            auto sign =
                gr::blocks::multiply_const_ff::make(manchester ? -1 : 1, 1);
            connect(symbols, 0, multiply_conj, 0);
            connect(symbols, 0, delay, 0);
            connect(delay, 0, multiply_conj, 1);
            connect(multiply_conj, 0, complex_to_real, 0);
            connect(complex_to_real, 0, sign, 0);
            connect(sign, 0, self(), 0);
        } else {
            auto costas = gr::digital::costas_loop_cc::make(
                2 * M_PI / baudrate * kCostasBw, 2, false);
            connect(symbols, 0, costas, 0);
            connect(costas, 0, complex_to_real, 0);
            connect(complex_to_real, 0, self(), 0);
        }
    }
};

} // namespace

gr::basic_block_sptr make_ccsds_descrambler() { return CcsdsDescrambler::make(); }

gr::basic_block_sptr
make_fsk_demodulator(double baudrate, double samp_rate, bool iq, bool subaudio)
{
    // --deviation default; only used to size the Carson's-rule filter and to
    // set the quadrature demod gain in the IQ case.
    constexpr double kDeviationHz = 5000.0;
    return FskDemodulator::make(
        baudrate, samp_rate, iq, kDeviationHz, subaudio, true);
}

gr::basic_block_sptr make_afsk_demodulator(
    double baudrate, double samp_rate, bool iq, double af_carrier, double deviation)
{
    return AfskDemodulator::make(baudrate, samp_rate, iq, af_carrier, deviation);
}

gr::basic_block_sptr make_bpsk_demodulator(double baudrate,
                                           double samp_rate,
                                           double f_offset,
                                           bool differential,
                                           bool manchester,
                                           bool iq)
{
    return BpskDemodulator::make(
        baudrate, samp_rate, f_offset, differential, manchester, iq);
}

gr::basic_block_sptr make_ccsds_viterbi(const std::string& code)
{
    return CcsdsViterbi::make(code);
}

gr::basic_block_sptr make_pn9_scrambler() { return Pn9Scrambler::make(); }

gr::basic_block_sptr make_si4463_scrambler() { return Si4463Scrambler::make(); }

gr::basic_block_sptr make_rms_agc(double alpha, double reference)
{
    return RmsAgc::make(alpha, reference);
}

gr::basic_block_sptr make_rms_agc_f(double alpha, double reference)
{
    return RmsAgcF::make(alpha, reference);
}

gr::basic_block_sptr
make_sync_to_pdu(int packlen, const std::string& sync, int threshold)
{
    return SyncToPdu::make("sync_to_pdu",
                           sizeof(char),
                           gr::types::byte_t,
                           static_cast<size_t>(packlen),
                           false,
                           sync,
                           threshold);
}

gr::basic_block_sptr
make_sync_to_pdu_packed(int packlen, const std::string& sync, int threshold)
{
    // The packed variant reads packlen *bytes* off a bit stream, so it asks
    // fixedlen_to_pdu for packlen*8 items and lets it pack them.
    return SyncToPdu::make("sync_to_pdu_packed",
                           sizeof(char),
                           gr::types::byte_t,
                           static_cast<size_t>(packlen) * 8,
                           true,
                           sync,
                           threshold);
}

gr::basic_block_sptr
make_sync_to_pdu_soft(int packlen, const std::string& sync, int threshold)
{
    return SyncToPdu::make("sync_to_pdu_soft",
                           sizeof(float),
                           gr::types::float_t,
                           static_cast<size_t>(packlen),
                           false,
                           sync,
                           threshold);
}

} // namespace wasm_satellites
