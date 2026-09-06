// Browser-native C++ ports of gr-bbc's pure-Python GNU Radio blocks.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <gnuradio/basic_block.h>

#include <string>

namespace wasm_bbc {

gr::basic_block_sptr make_encoder(int message_length,
                                  int codeword_length,
                                  int checksum_length,
                                  const std::string& checksum_mode);
gr::basic_block_sptr make_decoder(int message_length,
                                  int codeword_length,
                                  int checksum_length,
                                  int max_candidates,
                                  int max_steps,
                                  const std::string& checksum_mode);
gr::basic_block_sptr
make_ook_modulator(double carrier_freq, double samp_rate, double symbol_rate);
gr::basic_block_sptr make_ook_demodulator(double carrier_freq,
                                          double samp_rate,
                                          double symbol_rate,
                                          double bandwidth,
                                          double threshold);

} // namespace wasm_bbc
