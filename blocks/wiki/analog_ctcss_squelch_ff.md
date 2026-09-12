<!-- block: analog_ctcss_squelch_ff -->
<!-- title: CTCSS Squelch -->
<!-- source: https://wiki.gnuradio.org/index.php/CTCSS_Squelch -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Gate, or zero output if CTCSS tone not present

## Parameters
(R): Run-time adjustable

- Sampling Rate
  sample rate (Hz)

- Tone Frequency (R)
  Frequency value to use as the squelch tone (default: 100.0)

- Level (R)
  threshold level for the squelch tone (default: 0.01)

- Length
  length of the frequency filters (default: 0)

- Ramp
  Attack / release time in samples; a sinusodial ramp is used. set to 0 to disable (default: 0)

- Gate
  if true, no output if no squelch tone. if false, output 0's if no squelch tone (default: False)

## Example Flowgraph
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/lib/ctcss_squelch_ff_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/lib/ctcss_squelch_ff_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/include/gnuradio/analog/ctcss_squelch_ff.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/grc/analog_ctcss_squelch_ff.block.yml]
