<!-- block: pfb_interpolator_ccf -->
<!-- title: Polyphase Interpolator -->
<!-- source: https://wiki.gnuradio.org/index.php/Polyphase_Interpolator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block takes in a signal stream and performs interger up-sampling (interpolation) with a polyphase filterbank. The first input is the integer specifying how much to interpolate by. The second input is a vector (Python list) of floating-point taps of the prototype filter.

The filter's taps should be based on the interpolation rate specified. That is, the bandwidth specified is relative to the bandwidth after interpolation.

For example, using the GNU Radio’s firdes utility to building filters, we build a low-pass filter with a sampling rate of , a 3-dB bandwidth of and a transition bandwidth of . We can also specify the out-of-band attenuation to use, ATT, and the filter window function (a Blackman-harris window in this case). The first input is the gain, which is also specified as the interpolation rate so that the output levels are the same as the input (this creates an overall increase in power).

The PFB interpolator code takes the taps generated above and builds a set of filters. The set contains number of filters and each filter contains ceil(taps.size()/interp) number of taps. Each tap from the filter prototype is sequentially inserted into the next filter. When all of the input taps are used, the remaining filters in the filterbank are filled out with 0’s to make sure each filter has the same number of taps.

See [http://www.trondeau.com/examples/2014/1/23/pfb-channelizers-and-synthesizers.html] for a guide on these polyphase filterbank blocks.

## Parameters
- Interpolation
  Specifies the interpolation rate to use

- Taps
  The prototype filter to populate the filterbank. The taps should be generated at the interpolated sampling rate.

- Attenuation
  Stop band attenuation

- Sample Delay
  Underlying filter's sample delay
