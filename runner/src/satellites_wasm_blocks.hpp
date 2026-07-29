// Browser-native ports of gr-satellites Python utility blocks.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <gnuradio/basic_block.h>

#include <string>
#include <vector>

namespace wasm_satellites {

gr::basic_block_sptr make_aausat4_check_fsm();
gr::basic_block_sptr make_beesat_classifier();
gr::basic_block_sptr make_cc11xx_packet_crop(bool use_crc16);
gr::basic_block_sptr make_check_address(const std::string& address,
                                        const std::string& direction,
                                        const std::string& digicallsign);
gr::basic_block_sptr make_check_astrocast_crc(bool verbose);
gr::basic_block_sptr make_check_hex_string(const std::string& hex_string,
                                           int start_index);
gr::basic_block_sptr make_csp_address_filter(
    const std::vector<int>& allowed_sources,
    const std::vector<int>& allowed_destinations);
gr::basic_block_sptr make_eseo_packet_crop(bool drop_rs);
gr::basic_block_sptr make_hdlc_framer(int preamble_bytes, int postamble_bytes);
gr::basic_block_sptr make_ks1q_header_remover(bool verbose);
gr::basic_block_sptr make_ngham_packet_crop();
gr::basic_block_sptr make_ngham_remove_padding();
gr::basic_block_sptr make_print_header();
gr::basic_block_sptr make_print_timestamp(const std::string& format,
                                          bool count_packets);
gr::basic_block_sptr make_reflect_bytes();
gr::basic_block_sptr make_snet_classifier();
gr::basic_block_sptr make_swap_crc();
gr::basic_block_sptr make_swap_header();
gr::basic_block_sptr make_swiatowid_packet_crop();
gr::basic_block_sptr make_swiatowid_packet_split();
gr::basic_block_sptr make_sx12xx_packet_crop(int crc_len);

} // namespace wasm_satellites
