<!-- block: digital_symbol_sync_xx -->
<!-- title: Symbol Sync -->
<!-- source: https://wiki.gnuradio.org/index.php/Symbol_Sync -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The Symbol Sync block performs clock recovery. It synchronizes to the symbols in a digital signal, extracting them and reducing them to their individual representations, such as a bit. This is often a critical final step in the demodulation process, as clock recovery reduces a stream of samples of symbols to raw 1s and 0s. This block is the successor to the Clock Recovery MM and MSK Timing Recovery blocks, which are now deprecated.

The Symbol Sync block performs four main steps:

1. Estimates and tracks symbol rate (i.e. number of samples per symbol), given an initial estimate of samples per symbol and an allowable deviation from that estimate.

2. Performs the timing synchronization needed so that the signal is sampled at exactly the right moment in time, which is when each symbol/pulse is at its maximum value.

3. Decimate the signal so that what comes out of the block is 1 sample per symbol (or multiple if the user would like, but it's usually set to 1 or sometimes 2).

4. Filter the signal appropriately.

In essence, the Symbol Sync block operates a loop, typically a sampling length of a symbol, and then adjusts this loop until it is properly aligned with each symbol in the series.

For more information, see the GNU Radio Conference 2017 presentation (video) and (PDF slides) on this block. Example flowgraphs using this block can be found [https://github.com/gnuradio/gnuradio/tree/main/gr-digital/examples/demod here

## Parameters
(R): Run-time adjustable

- Timing Error Detector (TED)
  The type of timing error detector to use. Each TED has different tactics for clock recovery and each TED may be useful in different scenarios. For example, the Early-Late TED locks onto a demodulated FSK signal very well. Choices are:
  : Mueller and Müller
  : Modified Mueller and Müller
  : Zero Crossing
  : Gardner
  : Early-Late
  : D'Andrea and Mengali Gen MSK
  :  Mengali and D'Andrea GMSK
  : y[n]y'[n] Maximum likelihood
  : sgn(y[n])y'[n] Maximum likelihood

- Samples per Symbol (R)
  User specified nominal clock period in samples per symbol. If this is not predetermined, it can be computed by dividing the sampling rate by the baud rate.

- Expected TED Gain (R)
  Expected gain of the timing error detector, given the TED in use and the anticipated input amplitude, pulse shape, and Es/No. This value is the slope of the TED's S-curve at timing offset tau = 0. This value is normally computed by the user analytically or by simulation in a tool outside of GNU Radio. This value must be correct for the loop filter gains to be computed properly from the desired input loop bandwidth and damping factor. This is the most sensitive analytical parameter. If you are unable to compute this, consider using a slider using the QT GUI Range widget to experiment on a good value. This number should be somewhere above 0 but likely less than 1.

- Loop BW (R)
  Approximate normalized loop bandwidth of the symbol clock tracking loop. It should nominally be close to 0, but greater than 0. If unsure, start with a number around 2*pi*0.04, and experiment to find the value that works best for your situation. This value can also be found experimentally using a QT GUI Range slider widget, likely somewhere in the range between 0 and 1.

- Damping Factor (R)
  Damping factor of the symbol clock tracking loop. Damping  1.0 is an over-damped loop.  Start with critically damped or over-damped.  An under-damped loop is usually not desirable for timing recovery. The default is 1.0, which should work in general.

- Max Deviation
  Maximum absolute deviation of the average clock period estimate from the user specified nominal clock period in units of samples per symbol. Smaller is better for acquiring lock at start of burst.  Too small misses data when symbol clock is far from nominal. The default is 1.5, which should work in most cases.

- Output Samples/Symbol
  The number of output samples per symbol (default=1). Normally set to 1; or to 2 if upstream from an equalizer block.

- TED Slicer Constellation
  A constellation obj shared pointer that will be used by decision directed timing error detectors to make decisions. I.e. the timing error detector will use this constellation as a slicer, if the particular algorithm needs sliced symbols.

- Interpolating Resampler Type
  The enumerated type of interpolating resampler to use. See the interpolating resampler type enum for a list of possible types.

- Num Filters (if using certain resamplers)
  The number of arms in the polyphase filterbank of the interpolating resampler, if using an interpolating resampler that uses a PFB.

- PFB Taps (if used certain resamplers)
  The prototype filter for the polyphase filterbank of the interpolating resampler, if using an interpolating resampler that uses a PFB.

## Example
In this example, the Symbol Sync is fed a demodulated Frequency-Shift Keying (FSK) signal and produces soft data bits. A Binary Slicer block can then be used to turn these into hard zeros or ones.

File:Symbol_Sync_flowgraph.png|The Symbol Sync block is fed a demodulated FSK signal that has been further enhanced by the Root Raised Cosine match filter.
File:Symbol_Sync_example.png|The demodulated FSK signal forms square waves, which are refined into sinusoidal waves by the match filter. The Symbol Sync block locks onto each peak, producing pure bits with an error rate. Note that it takes Symbol Sync a while to fully sync; this is often the purpose of a long preamble.

## Usage Hints and Gotchas
1. Input signal should be at a consistent amplitude (e.g., ±1.0). This can be achieved with the Quadrature Demod, Root Raised Cosine Filter, or an Automatic Gain Control block.  TEDs have specific assumptions about input amplitudes!
1. For decision directed TEDs (M&M, Modified M&M, Zero Crossing), the input signal amplitude should match constellation.  Note that GNU Radio's Constellation Object silently scales your constellation!
1. Input signal should not have a DC offset. In other words, it must alternate between 0.0, not some other number.
1. Input signal should be peaked at symbol centers, except for MSK signals and MSK TEDs.  This requirement will normally be accomplished by the matched filter, such as the Root Raised Cosine Filter, which occurs before the Symbol Sync block, unless you use the PFB, MF resampler which does the matched filtering for you. This is demonstrated in one of the above examples.

## Block Diagram of Block
## Source Files
- C++ files
  symbol_sync_cc_impl.cc symbol_sync_ff_impl.cc

- Header files
  symbol_sync_cc_impl.h symbol_sync_ff_impl.h

- Public header files
  symbol_sync_cc.h symbol_sync_ff.h

- Block definition
  digital_symbol_sync_xx.block.yml
