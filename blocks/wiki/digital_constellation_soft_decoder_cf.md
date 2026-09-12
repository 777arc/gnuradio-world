<!-- block: digital_constellation_soft_decoder_cf -->
<!-- title: Constellation Soft Decoder -->
<!-- source: https://wiki.gnuradio.org/index.php/Constellation_Soft_Decoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Decode a constellation's points from a complex space to soft bits based on the map and soft decision LUT of the  object.

See GNU Radio Manual and C++ API Reference for more info.

## Parameters
- Constellation
  A constellation object, see Constellation Object

## Example Flowgraph
This flowgraph generates QPSK symbols based on a random bitstream, and then simulates a receiver by synchronizing to the signal and performing soft decoding.
