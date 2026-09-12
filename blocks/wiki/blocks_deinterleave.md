<!-- block: blocks_deinterleave -->
<!-- title: Deinterleave -->
<!-- source: https://wiki.gnuradio.org/index.php/Deinterleave -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Deinterleave an input block of samples into N outputs.

This block deinterleaves blocks of samples. For each output connection, the input stream will be deinterleaved successively to the output connections.
By default, the block deinterleaves a single input to each output.

   blocksize = 1
   connections = 2
   input = [a, b, c, d, e, f, g, h]
   output[0] = [a, c, e, g]
   output[1] = [b, d, f, h]

   blocksize = 2
   connections = 2
   input = [a, b, c, d, e, f, g, h]
   output[0] = [a, b, e, f]
   output[1] = [c, d, g, h]

See also Interleave.

## Parameters
- Num Streams : Total number of output ports

- Block size: Number of items to output before switching to the next output

- Vector length : Number of samples in a vector item

## Example Flowgraph
This flowgraph can be downloaded from Media:Block_deinterleave.grc.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/deinterleave_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/deinterleave_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/deinterleave.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_deinterleave.block.yml]
