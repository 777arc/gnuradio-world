<!-- block: dtv_dvbt_energy_dispersal -->
<!-- title: Energy Dispersal -->
<!-- source: https://wiki.gnuradio.org/index.php/Energy_Dispersal -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Energy dispersal.

ETSI EN 300 744 - Clause 4.3.1

- Input : MPEG-2 transport packets (including sync - 0x47).
- Output : Randomized MPEG-2 transport packets.

If first byte is not a SYNC then look for it.
First sync in a row of 8 packets is reversed - 0xB8.
Block size is 188 bytes.

## Parameters
- Blocks : number of blocks.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_tx_8k.grc].

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
