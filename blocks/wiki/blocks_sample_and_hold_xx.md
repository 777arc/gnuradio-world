<!-- block: blocks_sample_and_hold_xx -->
<!-- title: Sample and Hold -->
<!-- source: https://wiki.gnuradio.org/index.php/Sample_and_Hold -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Sample and hold circuit.

Samples the data stream (input stream 0) and holds the value if the control signal is 1 (intput stream 1).

As long as the control signal is different from 0, the data stream is forwarded.
When the control signal is 0, the output samples have the value of the last forwarded data sample.

The check of the control signal is done every sample so the two input are consumed at the same rate.

## Example Flowgraph
This flowgraph shows the periodic sampling and holding of a waveform at a set point. Notice how the sampled signal is HELD after the Control signal returns to 0. The sampling point can be varied by using the slider. This flowgraph samples the incoming signal at a single point. if you wish to pass more than a single point then you can widen the sampling pulse.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/sample_and_hold_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/sample_and_hold_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/sample_and_hold.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_sample_and_hold_xx.block.yml]
