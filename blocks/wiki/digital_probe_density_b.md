<!-- block: digital_probe_density_b -->
<!-- title: Probe Density -->
<!-- source: https://wiki.gnuradio.org/index.php/Probe_Density -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block maintains a running average of the input stream and makes it available as an accessor function.

If you send this block a stream of unpacked bytes, it will tell you what the bit density is.

## Parameters
(R): Run-time adjustable

- Alpha (R)
  Average filter constant

- Probe rate
  Doesn't seem to be connected to anything.

## Example Flowgraph
Media:example_probes.grc

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/probe_density_b_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/probe_density_b_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/include/gnuradio/digital/probe_density_b.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_probe_density_b.block.yml]
