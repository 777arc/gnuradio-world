<!-- block: ival_decimator -->
<!-- title: Interleaved Stream Decimator -->
<!-- source: https://wiki.gnuradio.org/index.php/Interleaved_Stream_Decimator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block will directly decimate an incoming stream made up of the specified complex samples.
One example would be if you have a source streaming 8-bit complex at high speeds and you want to
decimate directly from a high-speed source, or before writing to a file or network sink

## Parameters
(R): Run-time adjustable

- Input Type
  datasize: [gr.sizeof_char, gr.sizeof_short]
- Decimation
  default: '1'

## Example Flowgraph
## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  filter_ival_decimator.block.yml
