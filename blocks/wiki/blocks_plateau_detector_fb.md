<!-- block: blocks_plateau_detector_fb -->
<!-- title: Plateau Detector -->
<!-- source: https://wiki.gnuradio.org/index.php/Plateau_Detector -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Detects a plateau and marks the middle.

Detect a plateau of a-priori known height. Input is a stream of floats, the output is a stream of bytes. Whenever a plateau is detected, the middle of that plateau is marked with a '1' on the output stream (all other samples are left at zero).

You can use this in a Schmidl & Cox synchronisation algorithm to interpret the output of the normalized correlator. Just pass the length of the cyclic prefix (in samples) as the max_len parameter).

Unlike the peak detectors, you must the now the absolute height of the plateau. Whenever the amplitude exceeds the given threshold, it starts assuming the presence of a plateau.

An implicit hysteresis is provided by the fact that after detecting one plateau, it waits at least max_len samples before the next plateau can be detected.

## Parameters
(R): Run-time adjustable

- Max plateau length
  Maximum length of the plateau

- Threshold (R)
  Anything above this value is considered a plateau

## Example Flowgraph
Media:example_plateau_detector.grc
## Source Files
- C++ files
  https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/plateau_detector_fb_impl.cc

- Header files
  https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/plateau_detector_fb_impl.h

- Public header files
  https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/include/gnuradio/blocks/plateau_detector_fb.h

- Block definition
  https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_plateau_detector_fb.block.yml
