<!-- block: dtv_dvbt_energy_descramble -->
<!-- title: Energy Descramble -->
<!-- source: https://wiki.gnuradio.org/index.php/Energy_Descramble -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Energy descramble

ETSI EN 300 744 - Clause 4.3.1.

- Input : Randomized MPEG-2 transport packets.
- Output : MPEG-2 transport packets (including sync - 0x47).

We assume the first byte is a NSYNC.
First sync in a row of 8 packets is reversed - 0xB8.
Block size is 188 bytes.

## Parameters
- Blocks : number of blocks.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_rx_8k.grc].

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
