<!-- block: channels_fading_model -->
<!-- title: Fading Model -->
<!-- source: https://wiki.gnuradio.org/index.php/Fading_Model -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block implements a basic fading model simulator that can be used to help evaluate, design, and test various signals, waveforms, and algorithms.

This algorithm implements the method described in
       Compact Rayleigh and Rician fading simulator based on random walk processes
       A. Alimohammad S.F. Fard B.F. Cockburn C. Schlegel
       26th November 2008

## Parameters
(R): Run-time adjustable

- Num Sinusoids (SoS model)
  The number of sinusoids to use in simulating the channel; 8 is a good value

- Normalized Max Doppler (fD*Ts) (R)
  Normalized maximum Doppler frequency, fD * Ts

- LOS Model
  Include Line-of-Site path? selects between Rayleigh (NLOS) and Rician (LOS) models

- Rician factor (K) (R)
  Rician factor (ratio of the specular power to the scattered power)

- Seed
  Number to seed the noise generators

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-channels/examples/channel_tone_response.grc]

## Example Output
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/lib/fading_model_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/lib/fading_model_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/include/gnuradio/channels/fading_model.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/grc/channels_fading_model.block.yml]
