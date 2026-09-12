<!-- block: blocks_mute_xx -->
<!-- title: Mute -->
<!-- source: https://wiki.gnuradio.org/index.php/Mute -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

output = input or zero if muted.  Similar to Selector block.

## Parameters
(R): Run-time adjustable

- Mute (R)
  Whether or not to mute the input. To control with a variable, enter the variable name in place of the "False" value as shown here:

## Messages
The 'set_mute' message port accepts only raw PMT messages of the form pmt.to_pmt(False) or pmt.to_pmt(True)

## Example Flowgraph
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
