<!-- block: dtv_dvbs2_modulator_bc -->
<!-- title: DVB-S2X Modulator -->
<!-- source: https://wiki.gnuradio.org/index.php/DVB-S2X_Modulator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Modulates DVB-S2 frames.

Input: Bit interleaved baseband frames.

Output: QPSK, 8PSK, 16APSK or 32APSK modulated complex IQ values (XFECFRAME).

## Parameters
- FECFRAME Size
  FEC frame size (normal or short).

- Code Rate
  FEC code rate.

- Constellation
  DVB-S2 constellation.

- 2X Interpolation
  2X zero stuffing interpolation (on/off).

## Example Flowgraph
This is the example ATSC transmitter which can be found here.  You can transmit this signal by removing the Throttle block and adding an SDR sink to the output of the FFT filter.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
