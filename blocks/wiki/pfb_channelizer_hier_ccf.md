<!-- block: pfb_channelizer_hier_ccf -->
<!-- title: Hierarchical Polyphase Channelizer -->
<!-- source: https://wiki.gnuradio.org/index.php/Hierarchical_Polyphase_Channelizer -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

WARNING: Be aware of this bug if you are using this block https://github.com/gnuradio/gnuradio/pull/5567 it will be fixed soon but might not be in your version of GR

A helpful wrapper to the Polyphase Channelizer block, making it easier to use.  It is written as a Python Hier block, see https://github.com/gnuradio/gnuradio/blob/master/gr-filter/python/filter/pfb.py

See Polyphase Filterbanks for more info on Polyphase Filters within GNU Radio.

## Parameters
- Number of Channels
  The number of channels to split into.

- Number of Filterbanks
  The number of filterbank blocks to use (default=2).

- Taps
  The taps to use.  If this is None then taps are generated using optfir.low_pass.

- Output Channels
  Which channels to output streams for (a list of integers) (default is all channels).

- Attenuation
  Stop band attenuation.

- Fraction of Channel to Keep
  The fraction of the channel you want to keep.

- Transition Band
  Transition band with as fraction of channel width.

- Passband Ripple
  Pass band ripple in dB

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-filter/examples/polyphase_channelizer_demo.grc]

## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
