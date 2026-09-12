<!-- block: variable_repetition_encoder_def -->
<!-- title: Repetition Encoder Definition -->
<!-- source: https://wiki.gnuradio.org/index.php/Repetition_Encoder_Definition -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A repetition encoder class that repeats each input bit rep times. To  decode, take  a majority vote  over the  number of repetitions.

## Parameters
- Parallelism
  - Dimension 1
  For parallelism

- Dimension 2
  For parallelism

- Frame Bits
  Number of bits per frame. If using in the tagged stream style, this is the maximum allowable number of bits per frame

- Repetitions
  Repetition rate; encoder rate is rep bits out for each input bit.

## Example Flowgraph
This flowgraph can be downloaded from Media:Fec_coder_test.grc.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/repetition_encoder_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/repetition_encoder_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/include/gnuradio/fec/repetition_encoder.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/variable_repetition_encoder_def_list.block.yml]
