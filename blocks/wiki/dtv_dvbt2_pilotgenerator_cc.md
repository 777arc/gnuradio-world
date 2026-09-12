<!-- block: dtv_dvbt2_pilotgenerator_cc -->
<!-- title: Pilot Generator and IFFT -->
<!-- source: https://wiki.gnuradio.org/index.php/Pilot_Generator_and_IFFT -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Adds pilots to T2 frames.

- Input: Frequency interleaved T2 frame.
- Output: T2 frame with pilots (in time domain).

## Parameters
- Extended Carrier Mode
  Number of carriers

- FFT size
  OFDM IFFT size

- Pilot pattern
  DVB-T2 pilot pattern

- Guard interval
  OFDM ISI guard interval

- Number of data symbols
  Number of OFDM symbols in a T2 frame

- PAPR mode
  PAPR reduction mode

- Specification version
  DVB-T2 specification version

- Preamble
  P1 symbol preamble format

- MISO Group (if Preamble to MISO)
  MISO transmitter ID

- Sin(x)/x equalization
  sin(x)/x DAC equalization

- Bandwidth (if above to on)
  sin(x)/x equalization bandwidth

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-dtv/examples/germany-g1.grc]

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
