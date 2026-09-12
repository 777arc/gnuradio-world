<!-- block: analog_random_source_x -->
<!-- title: Random Source -->
<!-- source: https://wiki.gnuradio.org/index.php/Random_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

If in doubt, use Random Uniform Source instead of this block.

Generates a number of samples of random numbers of [min, max) meaning the max value won't be included. Repeat samples if specified.  Useful for creating bytes of information for testing a modulator.

Ex: With min=0 and max=2, the sequence 01110101... of length num_samps will be generated.

Supports an output of type int, short, and byte.

This block differs from Random Uniform Source:

This block uses Numpy to generate a fixed random vector of values. The output of this block repeats every num_samps, and hence has high autocorrelation with that period.

The algorithms used to generate the random numbers differ, as well: Numpy, and hence Random Source, use MT19937¹, whereas the Random Uniform Source uses XOROSHIRO128+, which has a period of 2128-1 and is hence to be preferred if autocorrelation over a window of length num_samps is relevant.

This block does not support C++ output, so it cannot be used when the output language of a flowgraph in GRC is C++.

## Parameters
(R): Run-time adjustable

- Output type
  Available options are int, short or byte

- Minimum
  The lower limit of the range of generated values (included in the output)

- Maximum
  The upper limit of the range of generated values (not included in the output)

- Num Samples
  Total number of samples that are generated in the output

- Repeat
  Yes/No

## Example Flowgraph
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  analog_random_source_x.block.yml

## Computational Performance
 done on a Intel(R) Core(TM) i7-4790 CPU @ 3.60GHz, 8GB RAM VOLK 2.5.0, GNU Radio 3.10.0.0-rc1, Linux 5.15.11

Block
Number of Samples / Period after which samples repeat
Throughput (in 106 samples per second)
Note
Random Source
1000
838
default setting
Random Source
220=1,048,576
824
Random Source
224
812
Random Source
228
813
Initialization of the random vector needs nearly 30s, eats 4GB of RAM
Random Uniform Source
2128-1
282

----

¹ The slightly superior randomness properties of MT19937 over XOROSHIRO128+ don't matter within the maximum size of a vector of values on a PC, and are generally unnoticable in an SDR contex
