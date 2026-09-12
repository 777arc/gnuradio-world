<!-- block: dtv_dvbt_bit_inner_interleaver -->
<!-- title: Bit Inner Interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Bit_Inner_Interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Bit Inner interleaver. See ETSI EN 300 744 Clause 4.3.4.1

Data Input format:
- 000000X0X1 - QPSK.
- 0000X0X1X2X3 - 16QAM.
- 00X0X1X2X3X4X5 - 64QAM.

Data Output format:
- 000000B0B1 - QPSK.
- 0000B0B1B2B3 - 16QAM.
- 00B0B1B2B3B4B5 - 64QAM.

bit interleaver block size is 126.

## Parameters
- Constellation Type
  options: [QPSK, 16QAM, 64QAM]

- Hierarchy Type
  options: [Non Hierarchical, Alpha 1, Alpha 2, Alpha 4]

- Transmission Mode
  options: [2K, 8K]

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
