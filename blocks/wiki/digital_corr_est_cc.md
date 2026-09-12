<!-- block: digital_corr_est_cc -->
<!-- title: Correlation Estimator -->
<!-- source: https://wiki.gnuradio.org/index.php/Correlation_Estimator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The Correlation Estimator block correlates the input signal against the provided vector of samples. This block is designed to search for a sync word by correlation and uses the results of the correlation to get a time and phase offset estimate. These estimates are passed downstream as stream tags for use by follow-on synchronization blocks.

The sync word is provided as a set of symbols after being filtered by a baseband matched filter.

The caller must provide a "time_est" and "phase_est" tag marking delay from the start of the correlated signal segment, in order to mark the proper point in the sync word for downstream synchronization blocks.  Generally this block cannot know where the actual sync word symbols are located relative to "corr_start", given that some modulations have pulses with intentional ISI.  The user should manually examine the primary output and the "corr_start" tag position to determine the required tag delay settings for the particular modulation, sync word, and downstream blocks used.

For a discussion of the properties of complex correlations, with respect to signal processing, see:
Marple, Jr., S. L., "Estimating Group Delay and Phase Delay via Discrete-Time 'Analytic' Cross-Correlation, _IEEE_Transactions_on_Signal_Processing_, Volume 47, No. 9, September 1999

- Tag output:
  'phase_est': Estimate of phase offset. The phase_est tag can be used by downstream blocks to adjust their phase estimator/correction loops, and is currently implemented by the Costas Loop block.
  'time_est': Estimate of symbol timing offset. The time_est tag can be used to adjust the sampling timing estimate of any downstream synchronization blocks such as Symbol Sync.
  'corr_est': Correlation value of the estimates
  'amp_est': 1 over the estimated amplitude. Estimated amplitude being the maximum amplitude of any one sample in the time window processed by the block (that at least includes the entire sync word)
  'corr_start': the start sample of the correlation and its value (same value as 'corr_est')

## Parameters
(R): Run-time adjustable

- Symbols
  Set of symbols to correlate against (e.g., a sync word).

- Samples per Symbol
  Samples per symbol

- Tag Marking Delay (R)
  Tag marking delay in samples after the corr_start tag

- Threshold (R)
  Threshold of correlator:  The meaning of this parameter depends on the threshold method used. For DYNAMIC threshold method, this parameter is actually 1 - Probability of False Alarm (under some inaccurate assumptions). The code performs the check |r[k]|^2 + |r[k+1]|^2 <> -log(1-threshold)*2*E, where r[k] is the correlated incoming signal, and E is the average sample energy of the correlated signal. For ABSOLUTE threshold method, this parameter sets the threshold to a fraction of the maximum squared autocorrelation. The code performs the check |r[k]|^2 <> threshold * R^2, where R is the precomputed max autocorrelation of the given sync word. Default is 0.9. It has been my experience that 0.4 is a pretty decent value for a Barker Code.

- Threshold Method
  Method for computing threshold. Options: [Absolute, Dynamic]. I find Absolute more reliable.

## Example Flowgraph
This flowgraph is extracted from [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/demod/test_corr_est.grc]

## Example Output
## Source Files
- C++ files
  corr_est_cc_impl.cc

- Header files
  corr_est_cc_impl.h

- Public header files
  corr_est_cc.h

- Block definition
  digital_corr_est_cc.block.yml
