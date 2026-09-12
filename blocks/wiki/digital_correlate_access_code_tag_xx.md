<!-- block: digital_correlate_access_code_tag_xx -->
<!-- title: Correlate Access Code - Tag -->
<!-- source: https://wiki.gnuradio.org/index.php/Correlate_Access_Code_-_Tag -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Examine input for specified access code, one bit at a time.

This block replaces the  Correlate Access Code block.

input: stream of bits, 1 bit per input byte (data in LSB) output: unaltered stream of bits (plus tags)

This block annotates the input stream with tags. The tags have key name [tag_name], specified in the constructor. Used for searching an input data stream for preambles, etc.

## Parameters
(R): Run-time adjustable

- Access Code
  is represented with 1 byte per bit, e.g., 010101010111000100

  It is important to choose an access code that is not "cyclical".  A cyclical code contains a repetition of itself within the length of the code.  This can cause false access code detections, and will cause byte boundaries (and hence valid packet length and payload recovery) to be recovered in error, with bizarre results!

  For example, an access code of 11111111 is a poor choice because it is cyclical. Let's look at why this is.

  The first eight 1 bits in a row from the block's input stream will correctly detect the first access code.  The first packet (in standard form    ) will be recovered nominally.

  However, when the correlate access code block's state machine goes back into scanning/detection mode after the first packet, the first bit of the NEXT access code (which forms the 11111111 preamble of the next packet) will cause an immediate access code detection.  This is because the access code detection routine within the block always shifts the last detected access code one bit to the left, and ORs in the current input bit.

  In our example, the valid bits 11111111 from the first access code detected will get shifted left one bit (to give 11111110), and then the next input bit (the first bit after the end of the first packet) will be ORed into the value (11111110 OR 1, giving 11111111) resulting in an erroneous detection of the next access code, because 11111111 will of course match the access code that the block is searching for.

  This will falsely detect the start of the next packet (alignment off by 7 bits) and your flowgraph will explode with subsequent bad headers and invalid data.  Not a pretty sight.

  So, when choosing an access code, select one that is not cyclical!

  A possible (and historically interesting) non-cyclical 32-bit access code might be 0xe15ae893:

  11100001010110101110100010010011

  which was the "unique word" used on several early communications satellites.

- Threshold (R)
  dtype: int
  maximum number of bits that may be wrong when deciding if the access code matches.

- Tag Name (R)
  dtype: string

## Example Flowgraph
This flowgraph can be downloaded from Media:Correlate_access_code.grc.

## Source Files
- C++ files
  correlate_access_code_tag_bb_impl.cc

  correlate_access_code_tag_ff_impl.cc

- Header files
  correlate_access_code_tag_bb_impl.h

  correlate_access_code_tag_ff_impl.h

- Public header files
  correlate_access_code_tag_bb.h

  correlate_access_code_tag_ff.h

- Block definition
  digital_correlate_access_code_tag_xx.block.yml
