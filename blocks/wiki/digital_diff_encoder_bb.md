<!-- block: digital_diff_encoder_bb -->
<!-- title: Differential Encoder -->
<!-- source: https://wiki.gnuradio.org/index.php/Differential_Encoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Differential encoder: y[0] = (x[0] + y[-1]) % M.  Uses current and previous symbols and the alphabet modulus to perform differential encoding.

## Parameters
- Modulus
  Modulus of code's alphabet

## Example Flowgraph
You can find this example here Differential_coding_example.grc

## Source Files
- C++ files
  diff_encoder_bb_impl.cc

- Header files
  diff_encoder_bb_impl.h

- Public header files
  diff_encoder_bb.h

- Block definition
  digital_diff_encoder_bb.block.yml
