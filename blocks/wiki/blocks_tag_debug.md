<!-- block: blocks_tag_debug -->
<!-- title: Tag Debug -->
<!-- source: https://wiki.gnuradio.org/index.php/Tag_Debug -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Bit bucket that prints out any tag received.

This block collects all tags sent to it on all input ports and displays them to stdout in a formatted way.

This block otherwise acts as a NULL sink in that items from the input stream are ignored. It is designed to be able to attach to any block and watch all tags streaming out of that block for debugging purposes.

The tags from the last call to this work function are stored and can be retrieved using the function 'current_tags'.

## Parameters
(R): Run-time adjustable

- Name
  The Name parameter is used to identify which debug sink generated the tag, so when connecting a block to this debug sink, an appropriate name is something that identifies the input block.

- Key filter
  Specifying a key will allow this block to filter out all other tags and only display tags that match the given key. This can help clean up the output and allow you to focus in on a particular tag of interest.

- Num Inputs
  Number of input streams

- Display (R)
  Print to stdout or not.

## Example Flowgraph
## Source Files
- C++ files
  tag_debug_impl.cc

- Header files
  tag_debug_impl.h

- Public header files
  tag_debug.h

- Block definition
  blocks_tag_debug.block.yml
