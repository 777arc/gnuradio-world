<!-- block: blocks_tags_strobe -->
<!-- title: Tags Strobe -->
<!-- source: https://wiki.gnuradio.org/index.php/Tags_Strobe -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Send tags at defined interval.

Sends a tag with key 'strobe' and a user-defined value (as a PMT) every  number of samples. Useful for testing/debugging the tags system.

Because tags are sent with a data stream, this is a source block that acts identical to a Null Source block.

## Parameters
(R): Run-time adjustable

- Value (R)
  The value of the tags to send, as a PMT.

- Key (R)
  The tag key to send

- Num. samples (R)
  The number of samples between each tag.

## Example Flowgraph
The following example shows how a tags strobe block is combined with a vector source to add tags at the end of each vector packet. The vector source is set as (0,0,0,1,1,1,0,1,1). In the Tag Strobe block, value is set as pmt.intern("EOP") and key is set as pmt.intern("key"). Number of samples is set as 9.

The output of the above graph is shown below. The tag of 'key: EOP' can be seen after every 9 samples.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
