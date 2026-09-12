<!-- block: analog_fm_demod_cf -->
<!-- title: FM Demod -->
<!-- source: https://wiki.gnuradio.org/index.php/FM_Demod -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Generalized FM demodulation block with deemphasis and audio filtering.  This block demodulates a band-limited, complex down-converted FM channel into the the original baseband signal, optionally applying deemphasis. Low pass filtering is done on the resultant signal. It produces an output float stream in the range of [-1.0, +1.0].

## Parameters
- Channel Rate
  Incoming sample rate of the FM baseband (integer)

- Audio Decimation
  Input to output decimation rate (integer)

- Deviation
  Maximum FM deviation (default = 75000) (float)

- Audio Pass
  Audio low pass filter passband frequency (float)

- Audio Stop
  Audio low pass filter stop frequency (float)

- Gain
  Gain applied to audio output (default = 1.0) (float)

- Tau
  Deemphasis time constant (default = 75e-6), specify tau=0.0 to prevent deemphasis (float)

## Example Flowgraph
Implementing an FM broadcast band receiver is really easy.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
