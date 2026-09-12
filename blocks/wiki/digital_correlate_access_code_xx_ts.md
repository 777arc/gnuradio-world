<!-- block: digital_correlate_access_code_xx_ts -->
<!-- title: Correlate Access Code - Tag Stream -->
<!-- source: https://wiki.gnuradio.org/index.php/Correlate_Access_Code_-_Tag_Stream -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Examine input for specified access code, one bit at a time.

input: stream of floats (generally, soft decisions)

output: a tagged stream set of bits from the payload following the access code and header

This block searches for the given access code by slicing the soft decision symbol inputs. Once found, it expects the following 32 samples to contain a header that includes the frame length (16 bits for the length, repeated). It decodes the header to get the frame length in order to set up the tagged stream key information.

The output of this block is appropriate for use with tagged stream blocks.

## Parameters
- Access Code
  is represented with 1 byte per bit, e.g., 010101010111000100

  It is important to choose an access code that is not "cyclical".  A cyclical code contains a repetition of itself within the length of the code.  This can cause false access code detections, and will cause byte boundaries (and hence valid packet length and payload recovery) to be recovered in error, with bizarre results!

  For example, an access code of 11111111 is a poor choice because it is cyclical. Let's look at why this is.

  The first eight 1 bits in a row from the block's input stream will correctly detect the first access code.  The first packet (in standard form    ) will be recovered nominally.

  However, when the correlate access code block's state machine goes back into scanning/detection mode after the first packet, the first bit of the NEXT access code (which forms the 11111111 preamble of the next packet) will cause an immediate access code detection.  This is because the access code detection routine within the block always shifts the last detected access code one bit to the left, and ORs in the current input bit.

  In our example, the valid bits 11111111 from the first access code detected will get shifted left one bit (to give 11111110), and then the next input bit (the first bit after the end of the first packet) will be ORed into the value (11111110 OR 1, giving 11111111) resulting in an erroneous detection of the next access code, because 11111111 will of course match the access code that the block is searching for.

  This will falsely detect the start of the next packet (alignment off by 7 bits) and your flowgraph will explode with subsequent bad headers and invalid data.  Not a pretty site.

  So, when choosing an access code, select one that is not cyclical!

  A possible (and historically interesting) non-cyclical 32-bit access code might be 0xe15ae893:

  11100001010110101110100010010011

  which was the "unique word" used on several early communications satellites.

- Threshold
  maximum number of bits that may be wrong

- Tag Name
  key of the tag inserted into the tag stream

## Example Flowgraph
This flowgraph is taken from the Packet_Communications tutorial.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/correlate_access_code_bb_ts_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/correlate_access_code_bb_ts_impl.cc]

- Public header files
  TODO

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_correlate_access_code_xx_ts.block.yml]
