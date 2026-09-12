<!-- block: channels_selective_fading_model -->
<!-- title: Frequency Selective Fading Model -->
<!-- source: https://wiki.gnuradio.org/index.php/Frequency_Selective_Fading_Model -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block implements a basic fading model simulator that can be used to help evaluate, design, and test various signals, waveforms, and algorithms.

- References
  The flat-fading portion of the algorithm implements the following
       Compact Rayleigh and Rician fading simulator based on random walk processes
       A. Alimohammad S.F. Fard B.F. Cockburn C. Schlegel
       26th November 2008 [https://doi.org/10.1109/VETECS.2008.97]

  The frequency selective extension of the block roughly implements
       A Low-Complexity Hardware Implementation of Discrete-Time
       Frequency-Selective Rayleigh Fading Channels
       F. Ren and Y. Zheng
       24-27 May 2009 [https://doi.org/10.1109/ISCAS.2009.5118116]

## Parameters
(R): Run-time adjustable

- Num Sinusoids (SoS model)
  Number of sinusoids used to simulate gain on each ray

- Normalized Max Doppler (fD*Ts) (R)
  Normalized maximum doppler frequency (f_doppler / f_samprate)

- LOS Model
  LOS path exists? chooses Rician (LOS) vs Rayleigh (NLOS) model.

- Rician factor (K) (R)
  Rician factor (ratio of the specular power to the scattered power)

- Seed
  Noise seed

- PDP Delays (samp)
  Time delay in the fir filter (in samples) for each arriving Wide-Sense Stationary Uncorrelated Scattering (WSSUS) Ray

- PDP Magnitudes
  Magnitude corresponding to each WSSUS Ray (linear)

- Num Taps
  Number of FIR taps to use in selective fading model

## Example Flowgraph
Basic flow graph for experimenting with the two different fading models

Media:example_frequency_selective_fading.grc
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/lib/selective_fading_model_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/lib/selective_fading_model_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/include/gnuradio/channels/selective_fading_model.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/grc/channels_selective_fading_model.block.yml]
