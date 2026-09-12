<!-- block: blocks_multiply_by_tag_value_cc -->
<!-- title: Multiply by Tag Value -->
<!-- source: https://wiki.gnuradio.org/index.php/Multiply_by_Tag_Value -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

output = input * complex constant

The complex constant used by this block is found from a tag with the specified name. The tag must contain a float/double or complex PMT value that will be converted into a gr_complex value. All input data is multiplied by this value until a new tag with an update value is found. The block starts with a value of '1.0' for the multiplier constant.

## Parameters
- Tag name
  Tag's key that it will use to get the multiplicative constant.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/packet/packet_rx.grc]

## Source Files
- C++ files
  multiply_by_tag_value_cc_impl.cc

- Header files
  multiply_by_tag_value_cc_impl.h

- Public header files
  multiply_by_tag_value_cc.h

- Block definition
  blocks_multiply_by_tag_value_cc.block.yml
