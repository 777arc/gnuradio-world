<!-- block: blocks_tag_gate -->
<!-- title: Tag Gate -->
<!-- source: https://wiki.gnuradio.org/index.php/Tag_Gate -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Control tag propagation.

Use this block to stop tags from propagating.

## Parameters
(R): Run-time adjustable

- Item Type
  options: [complex, float, int, short, byte]

- Vector Length
  default: '1'

- Propagate tags
  options: ['Yes', 'No']
  default: 'No'

- Single key (R)
  Key of the tags to stop
  default: '""' stops all tags

## Example Flowgraph
In this flowgraph, the Tag Gate can simulate transmission through a medium which does not pass tags. In this case, it separates the transmitter from the receiver.

## Source Files
- C++ files
  tag_gate_impl.cc

- Header files
  tag_gate_impl.h

- Block definition
  blocks_tag_gate.block.yml
