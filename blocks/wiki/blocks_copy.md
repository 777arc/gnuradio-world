<!-- block: blocks_copy -->
<!-- title: Copy -->
<!-- source: https://wiki.gnuradio.org/index.php/Copy -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

When enabled (default), this block copies its input to its output. When disabled, this block drops its input on the floor.

## Parameters
(R): Run-time adjustable
- Type
  * Complex
  * Float
  * Int
  * Short
  * Byte

- Enabled (R)
  Whether or not the input is copied to the output, or just dropped.

- Show Msg Ports
  This block has an "enabled" message port that can be used to turn it on or off.

## Message Ports
- en
  The 'Enabled' parameter of this block can be changed by sending a message at this port. Sending a Message PMT of pmt.from_bool(False) to this port via Message Strobe can disable the block. pmt.from_bool(True) can enable the block.

## Example Flowgraph
The following graph depicts the usage of the copy block.

Initially, copy is enabled, so the data is transferred to the output of the copy block.

But when the block receives the msg of pmt.from_bool(False) after 2.5 seconds, it starts dropping all of the upcoming data.

## Source Files
- C++ files
  lib_copy_impl.cc

- Header files
  copy_impl.h

- Public header files
  copy.h

- Block definition
  blocks_copy.block.yml
