<!-- block: blocks_burst_tagger -->
<!-- title: Burst Tagger -->
<!-- source: https://wiki.gnuradio.org/index.php/Burst_Tagger -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Sets a burst on/off tag based on the value of the trigger input.  This block takes two inputs, a signal stream on the input stream 0 and a trigger stream of shorts on input stream 1. If the trigger stream goes above 0, a tag with the key "burst" will be transmitted as a pmt::PMT_T. When the trigger signal falls to (or below) 0, the "burst" tag will be transmitted as pmt::PMT_F.  The signal on stream 0 is retransmitted to output stream 0.

## Parameters
(R): Run-time adjustable

- True KeyID (R)
  Change the key from "burst" to a custom string, for the True tag.

- True Value (R)
  Whether the tag's value should be True or False

- False KeyID (R)
  Change the key from "burst" to a custom string, for the False tag.

- False Value (R)
  Whether the tag's value should be True or False

## Example Flowgraph
## Example Output
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/burst_tagger_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/burst_tagger.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/burst_tagger.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_burst_tagger.block.yml]
