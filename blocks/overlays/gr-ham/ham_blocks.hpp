// Browser-native C++ ports of gr-ham's Python blocks.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// gr-ham ships no C++ at all -- its lib/ holds only a CMakeLists.txt, and every
// block is a Python gr.block in gr-ham/python/. Each class below mirrors the
// Python file named in its comment in ham_blocks.cpp, so the two stay diffable.
#pragma once

#include <gnuradio/basic_block.h>

namespace wasm_ham {

// varicode_tx.py -- ASCII byte stream -> PSK31 varicode bits (one bit per byte).
gr::basic_block_sptr make_varicode_tx();

// varicode_rx.py -- PSK31 varicode bits (one bit per byte) -> ASCII byte stream.
gr::basic_block_sptr make_varicode_rx();

// chu_decode.py -- 4800 sample/s sliced bits from CHU's AFSK -> decoded time
// printed to the console.
gr::basic_block_sptr make_chu_decode();

} // namespace wasm_ham
