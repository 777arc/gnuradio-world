<!-- block: digital_burst_shaper_xx -->
<!-- title: Burst Shaper -->
<!-- source: https://wiki.gnuradio.org/index.php/Burst_Shaper -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Burst shaper block for applying burst padding and ramping.

This block applies a configurable amount of zero padding before and/or after a burst indicated by tagged stream length tags.

If phasing symbols are used, an alternating pattern of +1/-1 symbols of length ceil(N/2) will be inserted before and after each burst, where N is the length of the taps vector. The ramp- up/ramp-down shape will be applied to these phasing symbols.

If phasing symbols are not used, the taper will be applied directly to the head and tail of each burst.

Length tags will be updated to include the length of any added zero padding or phasing symbols and will be placed at the beginning of the modified tagged stream. Any other tags found at the same offset as a length tag will also be placed at the beginning of the modified tagged stream, since these tags are assumed to be associated with the burst rather than a specific sample. For example, if "tx_time" tags are used to control bursts, their offsets should be consistent with their associated burst's length tags. Tags at other offsets will be placed with the samples on which they were found.

## Parameters
- Window Taps
  Vector of window taper taps; the first ceil(N/2) items are the up flank and the last ceil(N/2) items are the down flank. If taps.size() is odd, the middle tap will be used as the last item of the up flank and first item of the down flank.

- Pre-padding Length
  Number of zero samples to insert before the burst.

- Post-padding Length
  Number of zero samples to append after the burst.

- Insert Phasing Symbols
  If true, insert alternating +1/-1 pattern of length ceil(N/2) before and after the burst and apply ramp up and ramp down taps, respectively, to the inserted patterns instead of the head and tail items of the burst.

- Length Tag Name
  The name of the tagged stream length tag key.

## Example Flowgraph
- Example 1
  This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/packet/packet_tx.grc]

  - Example 2
  Another flowgraph can be found in Media:burst_shaper_demo.grc. It shows how the output of the graph changes with or without the insertion of phasing symbols, and without envelope shaping using a window function (equivalent to window.WIN_RECTANGULAR). The GUI Time Sinks use layout hints.

  : The change in the waveform can be seen as follows:

  ## Source Files
- C++ files
  burst_shaper_impl.cc

- Header files
  burst_shaper_impl.h

- Public header files
  burst_shaper.h

- Block definition
  digital_burst_shaper.block.yml
