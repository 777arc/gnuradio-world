// C++ rebuilds of gr-lora_sdr's two Python gr.hier_block2 compositions.
//
// gr-lora_sdr ships every other block as C++, but its two headline blocks --
// the complete LoRa transmitter and receiver -- live only in
// python/lora_sdr/lora_sdr_lora_{tx,rx}.py, which has no C++ path at all. The
// browser gets the same block ids backed by the same chains reassembled here as
// real hier_block2s, wired up through the metadata.yml beside this file so the
// pinned submodule stays pristine.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <gnuradio/basic_block.h>

#include <cstdint>
#include <string>
#include <vector>

namespace wasm_lora_sdr {

// python/lora_sdr/lora_sdr_lora_tx.py
gr::basic_block_sptr make_lora_tx(int samp_rate,
                                  int bw,
                                  int sf,
                                  bool impl_head,
                                  int cr,
                                  bool has_crc,
                                  int ldro_mode,
                                  const std::vector<std::uint16_t>& sync_word,
                                  int frame_zero_padd);

// python/lora_sdr/lora_sdr_lora_rx.py. `print_rx` is GRC's `[print_header,
// print_payload]` pair, which arrives as the Python list literal it is written
// as ("[True,False]"); see the .cpp for the parse.
gr::basic_block_sptr make_lora_rx(int samp_rate,
                                  int bw,
                                  int sf,
                                  bool impl_head,
                                  int cr,
                                  bool has_crc,
                                  int pay_len,
                                  bool soft_decoding,
                                  int ldro_mode,
                                  const std::vector<std::uint16_t>& sync_word,
                                  const std::string& print_rx);

} // namespace wasm_lora_sdr
