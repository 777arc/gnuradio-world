<!-- block: digital_diff_decoder_bb -->
<!-- title: Differential Decoder -->
<!-- source: https://wiki.gnuradio.org/index.php/Differential_Decoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Differential decoder: y[0] = (x[0] - x[-1]) % M.  Uses current and previous symbols and the alphabet modulus to perform differential decoding.

## Parameters
- Modulus
  Modulus of code's alphabet

## Example Flowgraph
You can find this example here Differential_coding_example.grc

## Source Files
- C++ files
  diff_decoder_bb_impl.cc

- Header files
  diff_decoder_bb_impl.h

- Public header files
  diff_decoder_bb.h

- Block definition
  digital_diff_decoder_bb.block.yml
