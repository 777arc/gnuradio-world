<!-- block: dtv_dvbt_bit_inner_deinterleaver -->
<!-- title: Bit Inner Deinterleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Bit_Inner_Deinterleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Bit Inner deinterleaver.  See ETSI EN 300 744 Clause 4.3.4.1.

Data Input format:
- 000000B0B1 - QPSK.
- 0000B0B1B2B3 - 16QAM.
- 00B0B1B2B3B4B5 - 64QAM.

Data Output format:
- 000000X0X1 - QPSK.
- 0000X0X1X2X3 - 16QAM.
- 00X0X1X2X3X4X5 - 64QAM.

bit deinterleaver block size is 126.

## Parameters
- Constellation Type
  TODO

- Hierarchy Type
  TODO

- Transmission Mode
  TODO

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
