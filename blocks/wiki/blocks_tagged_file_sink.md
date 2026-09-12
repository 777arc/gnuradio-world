<!-- block: blocks_tagged_file_sink -->
<!-- title: Tagged File Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/Tagged_File_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A file sink that uses tags to save files.

The sink uses a tag with the key 'burst' to trigger the saving of the burst data to a new file. If the value of this tag is True, it will open a new file and start writing all incoming data to it. If the tag is False, it will close the file (if already opened). The file names are based on the time when the burst tag was seen. If there is an 'rx_time' tag (standard with UHD sources), that is used as the time. If no 'rx_time' tag is found, the new time is calculated based off the sample rate of the block.

## Parameters
- Sample rate
  The sample rate used to determine the time difference between bursts

## Example Flowgraph
NB! Only run this flow graph for a short time as it will generate a number of files in the source directory!

Media:example_tag_file_sink.grc

## Source Files
- C++ files
  tagged_file_sink_impl.cc

- Header files
  tagged_file_sink_impl.h

- Public header files
  tagged_file_sink.h

- Block definition
  blocks_tagged_file_sink.block.yml
