<!-- block: blocks_nlog10_ff -->
<!-- title: Log10 -->
<!-- source: https://wiki.gnuradio.org/index.php/Log10 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

output = n*log10(input) + k

Only handles Float input and output.

This block handles null and negative samples by using, for each sample, the max between the sample and the minimum positive value for a float32 number.

## Parameters
- n
  Scalar multiplicative constant
- vlen
  Input vector length
- k
  Scalar additive constant

## Example Flowgraph
This flowgraph shows how the Log10 basic usage. The negative value handling can be seen.

## Source Files
- C++ files
  Float input

- Header files
  Float input

- Public header files
  Float input

- Block definition
  GRC yaml
