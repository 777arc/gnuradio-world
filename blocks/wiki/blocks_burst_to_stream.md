<!-- block: blocks_burst_to_stream -->
<!-- title: Burst to Stream -->
<!-- source: https://wiki.gnuradio.org/index.php/Burst_to_Stream -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Transforms a bursty tagged stream into a continuous stream by inserting zeros in the output between input packets whenever no packets are available at the input.

Added in 3.10.11.0

## Parameters
(R): Run-time adjustable

- Item Type
  options: [complex, float, int, short, byte]

- Length Tag Key
  default: '"packet_len"'

- Propagate tags
  default: 'No'
  options: ['Yes', 'No']

## Example Flowgraph
An example flowgraph can be found here.

## Example Output
## Source Files
- C++ files
  burst_to_stream_impl.cc

- Header files
  burst_to_stream_impl.h

- Public header files
  burst_to_stream.h

- Block definition
  blocks_burst_to_stream.block.yml
