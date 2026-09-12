<!-- block: fec_depuncture_bb -->
<!-- title: Depuncture -->
<!-- source: https://wiki.gnuradio.org/index.php/Depuncture -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Depuncture a given block of input samples of . The items produced is based on the pattern. Basically, if:

 k = 0
 if _puncpat[i] == 1:
    out[i] = input[k++]
 else:
    out[i] = symbol # default sym=127

This block is designed for unpacked bits - that is, every input sample is a bit, either a 1 or 0. It's possible to use packed bits as symbols, but the depuncturing will be done on the symbol level, not the bit level.

puncpat is specified as a 32-bit integer that we can convert into the vector _puncpat used in the algorithm above:

 _puncpat = [0,...]
 for i in puncsize:
     _puncpat[i] = puncpat >> (puncsize-1-i)

Example:
 puncsize = 8
 puncpat = 0xEF  -->  [1,1,1,0,1,1,1,1]
 input = [a, b, c, d, e, f, g, h]
 output = [a, b, c, 127, e, f, g, h]

The gr.fec Python module provides a read_bitlist function that can turn a string of a puncture pattern into the correct integer form. The pattern of 0xEF could be specified as fec.readbitlist("11101111"). Also, this allows us to use puncsize=len("11101111") to make sure that our sizes are set up correctly for the pattern we want.

The fec.extended_decoder takes in the puncture pattern directly as a string and uses the readbitlist inside to do the conversion.

The  parameter delays the application of the puncture pattern. This is equivalent to circularly rotating the  by . Note that because of the circular shift, the delay should be between 0 and , but this is not enforced; the effective delay will simply be  mod . A negative value here is ignored.

## Parameters
- Puncture Size
  Size of block of bits to puncture

- Puncture Pattern
  The puncturing pattern

- Delay
  Delayed the puncturing pattern by shifting it

- Symbol
  The symbol to reinsert into the stream (def=127)

## Example Flowgraph
This flowgraph can be downloaded from Media:Depuncture.grc.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
