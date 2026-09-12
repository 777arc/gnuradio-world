<!-- block: blocks_rotator_cc -->
<!-- title: Rotator -->
<!-- source: https://wiki.gnuradio.org/index.php/Rotator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The Rotator block performs a frequency translation. This operation is called a rotation because if you plot the real and imaginary numbers in a complex sample (I and Q) in a complex unit circle, rotating around this circle produces a wave at a given frequency. Making such a rotation clockwise or counterclockwise produces a positive or negative frequency, which is effectively what this block does mathematically.

## Mathematical Description
The phase increment (in radians) is the amount of additional phase shift added to the signal every sample. So, the block is the equivalent of multiplying by a complex sine.

Remember that a complex sine e^{2\pi j ft} of frequency f is a signal composed of exactly one element in the frequency domain. Looking at its complex argument, i.e., the angle of it at any time t in the complex plane, it's simply \Im\left\{\ln\left(e^{2\pi j ft} \right)\right\}=\Im\left\{2\pi j ft\right\}= 2\pi ft.

We're working with sampled signals, so we only observe it every sample interval T_{\text{s}}=\frac{f}{f_{\text{s}}}. Between two sample instants, the phase grows by \Delta_\varphi = 2\pi \frac {f}{f_{\text{s}}}; thus, to achieve a specific frequency shift f, one has to calculate the phase increment from the desired frequency.

## Parameters
(R): Run-time adjustable

- Phase Increment (R)
  Acts as the rotational velocity.

## Example Flowgraph
### Example 1
In the example below, the Rotator block shifts a stream of samples down 50 kHz. In this example, a Frequency-Shift Keying signal is captured slightly offset because the HackRF One generates a large spike at the exact center frequency. The solution is to simply capture at an offset and then use the Rotator to re-adjust the frequency alignment as desired.

File:Rotator_flowgraph.png|An example flowgraph of this block. The Rotator is fed incoming samples from a file and delivers the results into a waterfall.
File:Rotator_example.png|The Rotator block shifts the frequency down 50 kHz.

### Example 2
In the example below a constant source, set to 0.5, is fed into the rotator, thus producing a sine wave.  The phase increment is set to 0.01 radians and the sample rate is 100kHz, so that equates to 1000 radians every second, or 1000/(2pi) = 159 cycles per second.  This corresponds to a period of about 6ms, as shown in the time sink.

## Source Files
- C++ files
  rotator_cc_impl.cc

- Header files
  rotator_cc_impl.h

- Public header files
  rotator_cc.h

- Block definition
  blocks_rotator_cc.block.yml
