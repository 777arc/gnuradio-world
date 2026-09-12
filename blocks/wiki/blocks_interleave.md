<!-- block: blocks_interleave -->
<!-- title: Interleave -->
<!-- source: https://wiki.gnuradio.org/index.php/Interleave -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Interleave N inputs into a single output

This block interleaves blocks of samples. For each input connection, the samples are interleaved successively to the output connection.

This block can also be viewed as a special case of the Patterned Interleaver in which the pattern is defined by a block size and always goes in sequential order. For example, a Patterned Interleaver block with a pattern 0, 0, 1, 1, 2, 2 would be the equivalent of this block with BlockSize=2, Num Streams=3.

## Parameters
- Num Streams : Total number of input ports

- Block size : Number of items from one input to output before switching to the next input

- Vector length : Number of samples in a vector item

## Example Flowgraph
Below is a simple flowgraph example interleaving two vector sources:

The block properties are set for block size 2 so it passes two outputs from a given vector source before switching.

For this example that means the output begins with: 0, 1, 10, 11, 2, 3, 12, 13, 0, 1, .... The output is graphed below using a QT GUI Time Sink Block with a positive slope trigger. This is why the output displayed begins at 1 instead of zero.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/interleave_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/interleave_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/interleave.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_interleave.block.yml]
