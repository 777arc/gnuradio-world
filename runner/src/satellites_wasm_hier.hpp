// C++ rebuilds of gr-satellites' Python gr.hier_block2 compositions.
//
// gr-satellites keeps its hierarchies, deframers and demodulators in Python
// (python/hier, python/components/...), which has no C++ path at all, so the
// browser gets the same block ids backed by the same chains reassembled here as
// real hier_block2s. The factories are wired up through
// runner/block_overrides.yml so the pinned submodule stays pristine.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <gnuradio/basic_block.h>

#include <string>
#include <vector>

namespace wasm_satellites {

// python/hier
gr::basic_block_sptr make_ccsds_descrambler();
gr::basic_block_sptr make_ccsds_viterbi(const std::string& code);
gr::basic_block_sptr make_pn9_scrambler();
gr::basic_block_sptr make_si4463_scrambler();
gr::basic_block_sptr make_rms_agc(double alpha, double reference);
gr::basic_block_sptr make_rms_agc_f(double alpha, double reference);
gr::basic_block_sptr make_sync_to_pdu(int packlen,
                                      const std::string& sync,
                                      int threshold);
gr::basic_block_sptr make_sync_to_pdu_packed(int packlen,
                                             const std::string& sync,
                                             int threshold);
gr::basic_block_sptr make_sync_to_pdu_soft(int packlen,
                                           const std::string& sync,
                                           int threshold);

// python/components/demodulators. The GRC `options` parameter is an argparse
// command line for gr_satellites; these use the same defaults its parsers
// declare and ignore any string passed in (see the .cpp for the values).
gr::basic_block_sptr make_fsk_demodulator(double baudrate,
                                          double samp_rate,
                                          bool iq,
                                          bool subaudio);
gr::basic_block_sptr make_afsk_demodulator(double baudrate,
                                           double samp_rate,
                                           bool iq,
                                           double af_carrier,
                                           double deviation);
gr::basic_block_sptr make_bpsk_demodulator(double baudrate,
                                           double samp_rate,
                                           double f_offset,
                                           bool differential,
                                           bool manchester,
                                           bool iq);

} // namespace wasm_satellites
