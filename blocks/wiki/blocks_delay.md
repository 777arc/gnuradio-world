<!-- block: blocks_delay -->
<!-- title: Delay -->
<!-- source: https://wiki.gnuradio.org/index.php/Delay -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Delay the input by a certain number of samples.  Positive delays insert zero items at the beginning of the stream. Negative delays discard items from the stream.  You cannot initialize this block with a negative delay, however. That leads to a causality issue with the buffers when they are initialized. If you need to negatively delay one path, then put the positive delay on the other path instead.

Note that users have had issues when delaying by very large numbers.

## Parameters
(R): Run-time adjustable

- Delay (R)
  Number of samples/items to delay by

## Example Flowgraph
This flowgraph is taken from the QPSK_Mod_and_Demod tutorial. The Delay is used to match the transmit data to the receive data.

## Source Files
- C++ files
  delay_impl.cc

- Header files
  delay_impl.h

- Public header files
  delay.h

- Block definition
  blocks_delay.block.yml
