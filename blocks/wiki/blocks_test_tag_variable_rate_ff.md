<!-- block: blocks_test_tag_variable_rate_ff -->
<!-- title: Test Tag Variable Rate -->
<!-- source: https://wiki.gnuradio.org/index.php/Test_Tag_Variable_Rate -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Used for testing tag propagation.

This block resamples the stream by a factor that starts at 0.5 but varies around by some random walk. The relative rate of the block is initialized to 0.5 and the random number generator is seeded based on the time. For each input, if the random number is >= 0.5, the relative rate is increased by update_step;
otherwise, it is decreased by update_step.

The rate of the change of the resampling factor is set by the flag update_once. If this is set to true, then the rate is only updated once per work function. If it is set to false (default), then the rate is changed with every input sample.

The block's actor sets the propagation policy to TPP_DONT to stop tags from automatically propagating. Instead, we handle the tag propagation ourselves from within the work function. Because the relative_rate changes so fast, the tag placement cannot be based on a single factor after the call to work and must be handled when the samples are and based on the current resampling rate.

## Parameters
- Update Once
  Update the resampling rate once per call to work

- Update Step
  How much to adjust the resampling rate by when the update occurs

## Example Flowgraph
Media:example_test_tag.grc

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/test_tag_variable_rate_ff_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/test_tag_variable_rate_ff_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/test_tag_variable_rate_ff.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_test_tag_variable_rate_ff.block.yml]
