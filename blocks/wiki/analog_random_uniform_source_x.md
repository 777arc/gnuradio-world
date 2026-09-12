<!-- block: analog_random_uniform_source_x -->
<!-- title: Random Uniform Source -->
<!-- source: https://wiki.gnuradio.org/index.php/Random_Uniform_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Uniform Random Number Generator

Generates a number of samples of random numbers of [min, max) meaning the max value won't be included. Repeat samples if specified.  Great for creating bytes of information for a modulator.

Ex: With min=0 and max=2, the sequence 01110101... will be generated.

Supports an output of type int, short, and byte.

This block differs from Random Source in the pseudorandom number generator used. This block implements the XOROSHIRO128+ algorithm in C++, which has been shown to be require much less processing time than the MT19937¹ algorithm used by Numpy in Random Source, but that only fills a vector which is then repeated at runtime, whereas XOROSHORO128+ only repeats after 2128-1 bits.

Since the Random Source just repeats a relatively short vector of precomputed random numbers, if in doubt, prefer Random Uniform Source (this block).

## Parameters
- minimum
  defines minimal integer value output.

- maximum
  output values are below this value

- seed
  for Pseudo Random Number Generator. Defaults to 0. In this case current time is used.

## Example Flowgraph
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO

## Computational Performance
See Random_Source#Computational_Performance

----
¹  The disadvantage of the xoroshiro128+ algorithm is it fails the Hamming-weight dependencies test after 5TB of generated values and thus is unsuitable for generating many random values if "optimal pseudo-randomness" is required. For that to be theoretically relevant, you would need to use more than 5 TB of RAM with pre-generated random numbers in Random Number Source, and even then, the effects are not noticable unless you're looking for cryptographic weaknesses or similar.
