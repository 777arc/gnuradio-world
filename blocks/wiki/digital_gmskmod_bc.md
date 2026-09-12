<!-- block: digital_gmskmod_bc -->
<!-- title: GMSK Modulator -->
<!-- source: https://wiki.gnuradio.org/index.php/GMSK_Modulator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

GMSK modulator block.

## Parameters
- Samples/Symbol
  Samples per symbol.

- 3 dB Time-Bandwith Product
  For LSRC, this is the rolloff factor. For Gaussian pulses, this is the 3 dB time-bandwidth product.

- Pulse Duration (Symbols)
  The length of the phase duration in symbols. For L=1, this yields full- response CPM symbols, for L > 1, partial-response.

## Example Flowgraph
This flowgraph can be downloaded from Media:GMSK_Modulator.grc.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/cpmmod_bc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/cpmmod_bc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/include/gnuradio/digital/cpmmod_bc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_gmskmod_bc.block.yml]
