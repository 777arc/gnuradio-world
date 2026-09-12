<!-- block: channels_channel_model -->
<!-- title: Channel Model -->
<!-- source: https://wiki.gnuradio.org/index.php/Channel_Model -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A basic channel model simulator that can be used to help evaluate, design, and test various signals, waveforms, and algorithms.  This model allows the user to set the voltage of an AWGN noise source (), a (normalized) frequency offset (), a sample timing offset (), and a seed () to randomize or make reproducible the AWGN noise source. Multipath can be approximated in this model by using a FIR filter representation of a multipath delay profile with the parameter. To simulate a channel with time-variant channel, use Channel Model 2.

## Parameters
(R): Run-time adjustable

- Noise Voltage (R)
  The AWGN noise level as a voltage (to be calculated externally to meet, say, a desired SNR).

- Frequency Offset (R)
  The normalized frequency offset. 0 is no offset; 0.25 would be, for example, one quarter of a sample time.

- Epsilon (R)
  The sample timing offset to emulate the different rates between the sample clocks of the transmitter and receiver. 1.0 is no difference.

- Taps (R)
  Taps of a FIR filter to emulate a multipath delay profile.  Default is 1+0j meaning a single tap, and thus no multipath.

- Seed
  A random number generator seed for the noise source.

- Block Tag Propagation
  If true, tags will not be able to propagate through this block.

## Example Flowgraph
This flowgraph is taken from the QPSK_Mod_and_Demod tutorial.

## Source Files
- C++ files
  /gr-channels/lib/channel_model_impl.cc

- Header files
  /gr-channels/lib/channel_model_impl.h

- Public header files
  /gr-channels/include/gnuradio/channels/channel_model.h

- Block definition
  /gr-channels/grc/channels_channel_model.block.yml
