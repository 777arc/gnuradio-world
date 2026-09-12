<!-- block: analog_frequency_modulator_fc -->
<!-- title: Frequency Mod -->
<!-- source: https://wiki.gnuradio.org/index.php/Frequency_Mod -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block is an input amplitude controlled complex sine.  It outputs a signal, which has a momentary phase increase that is proportional to sensitivity and input amplitude.

More specifically, takes a real, baseband signal (x_m[n]) and output a frequency modulated signal (y[n]) according to:

Where x[n] is the input sample at time n and  f_{\Delta}  is the frequency deviation. Common values for f_{\Delta} are 5 kHz for narrowband FM channels such as for voice systems and 75 kHz for wideband FM, like audio broadcast FM stations.  In this block, the input argument is sensitivity, not the frequency deviation. The sensitivity specifies how much the phase changes based on the new input sample. Given a maximum deviation f_{\Delta}, and sample rate f_s, the sensitivity is defined as:

## Parameters
(R): Run-time adjustable

- Sensitivity (R)
  Sensitivity = (2 * math.pi * deviation) / sample_rate
  where 'deviation' is the change of the frequency when the input is at the values of -1 or +1. If the input is outside [-1, +1], it can deviate more.

## Example Flowgraph
## Source Files
- C++ files
  frequency_modulator_fc_impl.cc

- Header files
  frequency_modulator_fc_impl.h

- Public header files
  frequency_modulator_fc.h

- Block definition
  analog_frequency_modulator_fc.block.yml
