<!-- block: blocks_file_source -->
<!-- title: File Source -->
<!-- source: https://wiki.gnuradio.org/index.php/File_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Reads raw data values in binary format from the specified file. This file can be a file that was captured using a File Sink block, generated with a computer program or saved from an audio editor such as Audacity (using suitable RAW format options).

## Parameters
(R): Run-time adjustable

- File (R)
  Filename of binary file. Note: The file MUST be on the local computer.
The file size must not be less than 8 bytes, otherwise it gives the following error: "RuntimeError: file is too small"

- Output Type
  Because a binary file does not store information about what type of data is in it, we have to tell GNU Radio the format.

- Repeat (R)
  Whether or not to repeat the signal, once the end of the file is reached

- Add Begin Tag (R)
  Key of a tag to add to the first sample of the stream, and if Repeat is true, the first sample of each repeated copy.  The provided expression must create a PMT.  For example, pmt.intern("example_key") will create a key that represents the string "example_key".  See Polymorphic_Types_(PMTs) and Stream_Tags for more information.

- Offset
  Start offset samples/items after the beginning of the file

- Length
  Read only this number of items beginning from offset(offset+len). 0 will read until the end of the file.

## Example Flowgraph
This flowgraph can be found at https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_rx_8k.grc.

## Source Files
- C++ files
  https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/file_source_impl.cc

- Header files
  https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/file_source_impl.h

- Public header files
  https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/file_source.h

- Block definition
  https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_file_source.block.yml
