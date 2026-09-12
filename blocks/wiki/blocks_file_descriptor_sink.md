<!-- block: blocks_file_descriptor_sink -->
<!-- title: File Descriptor Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/File_Descriptor_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Write stream to file descriptor.

## Parameters
- File descriptor
  File descriptor (as an integer). [https://en.wikipedia.org/wiki/File_descriptor]

## Example Flowgraph
The following flowgraph takes an input from a file and outputs the stream to the stdout and stderr file descriptors.
NB. Run this flowgraph from the command line.

Media:example_file_descriptors.grc

Run from terminal

 $ echo 1,2,3,4,5,6,7,8,9,0 > /tmp/test.txt
 $ grcc example_file_descriptors.grc
 $ python example_file_descriptors.py > /tmp/stream1.txt 2> /tmp/stream2.txt
 $ Ctrl-C
 $ cat /tmp/stream1.txt
 $ cat /tmp/stream2.txt

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/file_descriptor_sink_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/file_descriptor_sink_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/include/gnuradio/blocks/file_descriptor_sink.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_file_descriptor_sink.block.yml]
