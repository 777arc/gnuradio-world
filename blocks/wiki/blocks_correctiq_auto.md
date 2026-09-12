<!-- block: blocks_correctiq_auto -->
<!-- title: Remove DC Spike AutoSync -->
<!-- source: https://wiki.gnuradio.org/index.php/Remove_DC_Spike_AutoSync -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block removes the center frequency IQ DC spike with a slight variation from the Remove_DC_Spike. It automatically calculates the offset and then switches to straight DC offset mode to prevent any possible IIR filtering after it's been tuned. However, if frequency or upstream gain is changed, it must retune, so frequency and upstream gain are all taken as parameters and monitored for changes. Added in 3.9

Notes:

- Any message received on the rsync port will trigger a resync process. So it could be a frequency or gain change, or any other desired condition.

- The optional sync_start output message will be sent whenever a resync is triggered. This can be used downstream to know the filter is calculating and adapting. Note that there is no initial syncing message (this is assumed on block start so downstream blocks that are interested should make the same assumption).

- When a sync is finished, the real and imag offsets will be sent in the optional offsets message. Note that the work loop calculates out[].real(in[].real() - real_offset) and same for imag. So offsets are subtractive from the input values.

## Parameters
(R): Run-time adjustable

- Sample Rate
  The sample rate for the block (default: samp_rate).

- Sync Learning Period (sec)
  How long to synchronize (default: '2')

- Frequency
  - Upstream Gain
  ## Messages
### Inputs
- rsync
  Any message received on the rsync port will trigger a resync process.

### Outputs
- sync_start
  value: True

- offsets
  I and Q offset values

## Example Flowgraph
## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_correctiq_auto.block.yml]
