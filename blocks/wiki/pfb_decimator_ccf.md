<!-- block: pfb_decimator_ccf -->
<!-- title: Polyphase Decimator -->
<!-- source: https://wiki.gnuradio.org/index.php/Polyphase_Decimator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Polyphase filterbank bandpass decimator.  This block takes in a signal stream and performs interger down-sampling (decimation) with a polyphase filterbank. The first input is the integer specifying how much to decimate by. The second input is a vector (Python list) of floating-point taps of the prototype filter. The third input specifies the channel to extract. By default, the zeroth channel is used, which is the baseband channel (first Nyquist zone).

The parameter specifies which channel to use since this class is capable of bandpass decimation. Given a complex input stream at a sampling rate of and a decimation rate of , the input frequency domain is split into channels that represent the Nyquist zones. Using the polyphase filterbank, we can select any one of these channels to decimate.

The output signal will be the basebanded and decimated signal from that channel. This concept is very similar to the PFB channelizer (see gr::filter::pfb_channelizer_ccf) where only a single channel is extracted at a time.

The filter’s taps should be based on the sampling rate before decimation.

For example, using the GNU Radio’s firdes utility to building filters, we build a low-pass filter with a sampling rate of , a 3-dB bandwidth of and a transition bandwidth of . We can also specify the out-of-band attenuation to use, , and the filter window function (a Blackman-harris window in this case). The first input is the gain of the filter, which we specify here as unity.

The PFB decimator code takes the taps generated above and builds a set of filters. The set contains number of filters and each filter contains ceil(taps.size()/decim) number of taps. Each tap from the filter prototype is sequentially inserted into the next filter. When all of the input taps are used, the remaining filters in the filterbank are filled out with 0’s to make sure each filter has the same number of taps.

See for a guide on these polyphase filterbank blocks.

## Parameters
- Decimation
  Specifies the decimation rate to use

- Taps
  The prototype filter to populate the filterbank.

- Output Channel
  Selects the channel to return [default=0.

- Stop-Band Attenutation
  The stop band attenuation

- Use FFT Rotator
  - Use FFT Filters
  - Sample Delay
