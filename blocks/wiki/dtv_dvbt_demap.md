<!-- block: dtv_dvbt_demap -->
<!-- title: DVB-T Demap -->
<!-- source: https://wiki.gnuradio.org/index.php/DVB-T_Demap -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

DVB-T demapper. ETSI EN 300 744 Clause 4.3.5.

Data input format:
 complex(real(float), imag(float)).

Data output format:
 000000Y0Y1 - QPSK.
 0000Y0Y1Y2Y3 - 16QAM.
 00Y0Y1Y2Y3Y4Y5 - 64QAM.

## Parameters
- Constellation Type
  constellation used.

- Hierarchy Type
  hierarchy used

- Transmission Mode
  transmission mode used

- Gain
  gain of complex input stream.

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
