// C++ rebuilds of gr-ais's Python hierarchies and the trellis tables they need.
//
// gr-ais ships its five DSP blocks as C++ but assembles them into a receiver
// only in Python: python/ais/gmsk_sync.py (the square-and-FFT frequency sync),
// ais_demod.py (the streaming receiver) and burst_demod.py (the data-aided
// burst receiver), with the GMSK trellis both decoders run on synthesized in
// cpm_trellis.py with numpy. None of that has a C++ path upstream, so the
// browser gets the same block ids backed by the same chains reassembled here
// as real hier_block2s, wired up through the metadata.yml beside this file so
// the pinned submodule stays pristine.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <gnuradio/basic_block.h>
#include <gnuradio/gr_complex.h>

#include <vector>

namespace wasm_ais {

// python/ais/cpm_trellis.py gmsk_trellis(): the branch signals (flattened
// [num_branches][samples_per_symbol]) and next-state table of GMSK with h=1/2
// at the given integer samples per symbol, for viterbi_cpm_cb.
struct GmskTrellis {
    std::vector<gr_complex> signals;
    std::vector<int> next_state;
    int num_states = 0;
};
GmskTrellis gmsk_trellis(int samples_per_symbol, double bt = 0.4);

// python/ais/gmsk_sync.py square_and_fft_sync_cc
gr::basic_block_sptr make_square_and_fft_sync(double sample_rate,
                                              double bits_per_sec,
                                              int fftlen);

// python/ais/ais_demod.py ais_demod, whose options dict is flattened here.
gr::basic_block_sptr make_ais_demod(double samples_per_symbol,
                                    double bits_per_sec,
                                    double clockrec_gain,
                                    double omega_relative_limit,
                                    int fftlen,
                                    bool coherent);

// python/ais/burst_demod.py ais_burst_demod
gr::basic_block_sptr make_ais_burst_demod(int samples_per_symbol,
                                          double bits_per_sec,
                                          double freq_span,
                                          double threshold,
                                          int burst_slots);

// lib/viterbi_cpm_cb over gmsk_trellis(): the trellis is derived from the
// samples-per-symbol rather than passed, which is the only way a GRC block can
// carry a 128-branch table.
gr::basic_block_sptr make_gmsk_viterbi(int samples_per_symbol,
                                       int traceback_len,
                                       double phase_gain);

} // namespace wasm_ais
