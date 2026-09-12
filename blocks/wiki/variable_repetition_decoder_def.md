<!-- block: variable_repetition_decoder_def -->
<!-- title: Repetition Decoder Definition -->
<!-- source: https://wiki.gnuradio.org/index.php/Repetition_Decoder_Definition -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A repetition decoder class. This takes a majority vote, biased by the ap_prob rate, and decides if the number of 1 bits > ap_prob, it is a 1; else, it is a 0.

## Parameters
- Parallelism
  - Dimension 1
  For paralelism

- Dimension 2
  For paralelism

- Frame Bits
  Number of bits per frame. If using in the tagged stream style, this is the maximum allowable number of bits per frame

- Repetitions
  Repetition rate; encoder rate is rep bits out for each input bit.

- a prior prob
  The a priori probability that a bit is a 1 (generally, unless otherwise known, assume to be 0.5).

## Example Flowgraph
This flowgraph can be downloaded from Media:Fec_coder_test.grc.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/repetition_decoder_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/repetition_decoder_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/include/gnuradio/fec/repetition_decoder.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/variable_repetition_decoder_def_list.block.yml]
