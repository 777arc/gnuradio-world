<!-- block: dtv_dvbt_viterbi_decoder -->
<!-- title: Viterbi Decoder -->
<!-- source: https://wiki.gnuradio.org/index.php/Viterbi_Decoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

DVB-T Viterbi decoder.

ETSI EN 300 744 Clause 4.3.3
Mother convolutional code with rate 1/2.
k=1, n=2, K=6.
Generator polynomial G1=171(OCT), G2=133(OCT).
Punctured to obtain rates of 2/3, 3/4, 5/6, 7/8.

Data Input format:
        000000X0X1 - QPSK.
        0000X0X1X2X3 - 16QAM.
        00X0X1X2X3X4X5 - 64QAM.
Data Output format: Packed bytes (each bit is data).
        MSB - first, LSB last.

## Parameters
- Constellation type
  constellation used.

- Hierarchy type
  hierarchy used.

- Code rate
  Coderate used.

- Block size
  Block size.

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
