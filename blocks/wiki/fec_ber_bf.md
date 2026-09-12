<!-- block: fec_ber_bf -->
<!-- title: BER -->
<!-- source: https://wiki.gnuradio.org/index.php/BER -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block measures the bit error rate between two streams of packed data. It compares the bits of each streams and counts the number of incorrect bits between them. It outputs the log of the bit error rate, so a value of -X is 10^{-X} bit errors.

When Test Mode is set to false (default), it is in streaming mode. This means that the output is constantly producing the current value of the BER. In this mode, there is a single output BER calculation per chunk of bytes passed to it, so there is no exact timing between calculations of BER. In this mode, the other two parameters to the constructor are ignored.

Test Mode equals true is used in the ber_curve_gen example and for other offline analysis of BER curves. Here, the block waits until at least
 BER Min Errors are observed and then produces a BER calculation. The parameter BER Limit helps make sure that the simulation is controlled. If the BER calculation drops below the BER Limit setting, the block will exit and simply return the set limit; the real BER is therefore some amount lower than this.

Note that this block takes in data as packed bytes with 8-bits per byte used. It outputs a stream of floats as the log-scale BER.

## Parameters
- Test Mode
  False for normal streaming mode (default); true for test mode.

- BER Min Errors
  The block needs to observe this many errors before outputting a result. Only valid when test_mode=true.

- BER Limit
  If the BER calculation falls below this limit, produce this value and exit. Only valid when test_mode=true.

## Example Flowgraph
This flowgraph shows the measurement of BER in an OFDM loopback simulation. Click here to download the flowgraph.

## Example Output
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/ber_bf_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/ber_bf_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/include/gnuradio/fec/ber_bf.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/fec_ber_bf.block.yml]
