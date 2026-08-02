// C++ rebuilds of gr-satellites' Python deframer components and the Python
// stream blocks they depend on.
//
// Everything under gr-satellites/python/components/deframers is a Python
// gr.hier_block2 with no C++ path upstream; each takes a float stream of soft
// symbols and emits frames as PDUs on a message port named "out". Wired up
// through the metadata.yml beside this file so the pinned submodule stays pristine.
//
// Signatures mirror the Python constructors, except that the argparse `options`
// object is dropped: nothing in the browser supplies a command line, so each
// GRC block passes gr_satellites' own default for the values it would carry.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <gnuradio/basic_block.h>

#include <string>
#include <vector>

namespace wasm_satellites {

// python/hdlc_deframer.py: a real sync_block, not a hierarchy.
gr::basic_block_sptr make_hdlc_deframer(bool check_fcs, int max_length);

gr::basic_block_sptr make_ax25_deframer(bool g3ruh_scrambler);
gr::basic_block_sptr make_ua01_deframer();
gr::basic_block_sptr make_ax100_deframer(const std::string& mode,
                                         const std::string& scrambler,
                                         int syncword_threshold,
                                         const std::string& syncword);
gr::basic_block_sptr make_u482c_deframer(int syncword_threshold);
gr::basic_block_sptr make_ccsds_rs_deframer(int frame_size,
                                            const std::string& precoding,
                                            bool rs_en,
                                            const std::string& rs_basis,
                                            int rs_interleaving,
                                            const std::string& scrambler,
                                            int syncword_threshold);
gr::basic_block_sptr
make_ccsds_concatenated_deframer(int frame_size,
                                 const std::string& precoding,
                                 bool rs_en,
                                 const std::string& rs_basis,
                                 int rs_interleaving,
                                 const std::string& scrambler,
                                 int syncword_threshold,
                                 const std::string& convolutional);
gr::basic_block_sptr make_aistechsat_2_deframer(int syncword_threshold);
gr::basic_block_sptr make_ao40_uncoded_deframer(int syncword_threshold);
gr::basic_block_sptr
make_ao40_fec_deframer(int syncword_threshold, bool short_frames, bool crc);
gr::basic_block_sptr make_aalto1_deframer(int syncword_threshold);
gr::basic_block_sptr make_reaktor_hello_world_deframer(int syncword_threshold,
                                                       const std::string& syncword);
gr::basic_block_sptr make_binar1_deframer(int syncword_threshold);
gr::basic_block_sptr make_endurosat_deframer(int syncword_threshold);
gr::basic_block_sptr make_binar2_deframer(int syncword_threshold);
gr::basic_block_sptr make_geoscan_deframer(int frame_size, int syncword_threshold);
gr::basic_block_sptr make_lucky7_deframer(int syncword_threshold);
gr::basic_block_sptr make_nusat_deframer(int syncword_threshold);
gr::basic_block_sptr make_astrocast_fx25_deframer(int syncword_threshold, bool nrzi);
gr::basic_block_sptr make_fossasat_deframer(int syncword_threshold);
gr::basic_block_sptr make_grizu263a_deframer(int syncword_threshold);
gr::basic_block_sptr make_smogp_signalling_deframer(bool new_protocol,
                                                    int syncword_threshold);
gr::basic_block_sptr make_lilacsat_1_deframer(int syncword_threshold);
gr::basic_block_sptr make_ngham_deframer(bool decode_rs, int syncword_threshold);
gr::basic_block_sptr make_qubik_deframer(int syncword_threshold);
gr::basic_block_sptr make_sat_3cat_1_deframer(int syncword_threshold);
gr::basic_block_sptr make_tt64_deframer(int syncword_threshold);
gr::basic_block_sptr make_swiatowid_deframer(int syncword_threshold);
gr::basic_block_sptr make_ops_sat_deframer();

} // namespace wasm_satellites
