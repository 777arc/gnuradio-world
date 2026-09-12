<!-- block: blocks_file_descriptor_source -->
<!-- title: File Descriptor Source -->
<!-- source: https://wiki.gnuradio.org/index.php/File_Descriptor_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Read stream from file descriptor.

## Parameters
- File descriptor
  File descriptor (as an integer) as per your specific OS (e.g. 0 for stdin on ubuntu)

- Repeat
  Repeat the data stream continuously.

## Example Flowgraph
Media:example_fds_source.grc

This flow graph needs to be run from the terminal.

Example, source /dev/urandom and pipe into the stdin of the flowgraph.

 cat /dev/urandom | tr -dc "0-9" | python example_fds_source.py

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/file_descriptor_source_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/file_descriptor_source_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/include/gnuradio/blocks/file_descriptor_source.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_file_descriptor_source.block.yml]
