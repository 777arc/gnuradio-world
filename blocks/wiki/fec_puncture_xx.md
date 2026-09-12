<!-- block: fec_puncture_xx -->
<!-- title: Puncture -->
<!-- source: https://wiki.gnuradio.org/index.php/Puncture -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

For a given block of input samples of puncsize, the items
produced is based on puncpat. Basically, if:

   k = 0
   if _puncpat[i] == 1:
      out[k++] = input[i]

This block is designed for floats, generally 1's and -1's. It's possible to use other float values as symbols, but this is not the expected operation.
puncpat is specified as a 32-bit integer that we can convert into the vector _puncpat used in the algorithm above:
   _puncpat = [0,...]
   for i in puncsize:
       _puncpat[i] = puncpat >> (puncsize-1-i)
Example:
   puncsize = 8
   puncpat = 0xEF  -->  [1,1,1,0,1,1,1,1]
   input = [a, b, c, d, e, f, g, h]
   output = [a, b, c, e, f, g, h]

The gr.fec Python module provides a read_bitlist function that can turn a string of a puncture pattern into the correct integer form. The pattern of 0xEF could be specified as fec.readbitlist("11101111"). Also, this allows us to use puncsize=len("11101111") to make sure that our sizes are set up correctly for the pattern we want.

The fec.extended_encoder takes in the puncture pattern directly as a string and uses the readbitlist inside to do the conversion.

Note that due to the above concept, the default setting in the extended encoder of '11' translates into no puncturing.

The delay parameter delays the application of the puncture pattern. This is equivalent to circularly rotating the puncpat by delay. Note that because of the circular shift, the delay should be between 0 and puncsize, but this is not enforced; the effective delay will simply be delay mod puncsize. A negative value here is ignored.

## Parameters
- Puncture Size
  Size of block of bits to puncture

- Puncture Pattern
  The puncturing pattern

- Delay
  Delayed the puncturing pattern by shifting it

## Example Flowgraph
This flowgraph can be downloaded from Media:Depuncture.grc.
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/puncture_ff_impl.cc]
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/puncture_bb_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/puncture_ff_impl.h]
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/puncture_bb_impl.h]

- Public header files
  Float input
  Byte input

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/fec_puncture_xx.block.yml]
