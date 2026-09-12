<!-- block: digital_diff_phasor_cc -->
<!-- title: Differential Phasor -->
<!-- source: https://wiki.gnuradio.org/index.php/Differential_Phasor -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

In radio technology, Differential Phasor refers to differential decoding based on phase change. It uses the phase difference between two symbols to determine the output symbol1. This technique can be used in various applications such as demodulating multilevel differential phase-shift keyed (DxPSK) signals.

out[i] = in[i] * conj(in[i-1])

## Parameters
None

## Example Flowgraph
Media:Example_diff_phasor.grc
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/lib/diff_phasor_cc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/lib/diff_phasor_cc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/include/gnuradio/digital/diff_phasor_cc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/grc/digital_diff_phasor_cc.block.yml]
