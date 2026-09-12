<!-- block: blocks_transcendental -->
<!-- title: Transcendental -->
<!-- source: https://wiki.gnuradio.org/index.php/Transcendental -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A block that performs various transcendental math operations.
Possible function names can be found in the cmath library.

  output[i] = trans_fcn(input[i])

## Parameters
- Function name
  The function to use

Available functions for real and complex input:

- cos
- sin
- tan
- cosh
- sinh
- tanh
- exp
- log
- log10
- sqrt

Available functions for real input only:

- acos
- asin
- atan

## Use cases
Few. Usually, better alternatives (in the sense of: accelerated functions with their own block) are available and should be preferred.

## Example Flowgraph
Media:example_transcendental.grc

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/transcendental_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/transcendental_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/transcendental.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_transcendental.block.yml]

## Trivia
A transcendental function is one that cannot be constructed from a finite-order polynomial or the value of a zero of such a polynomial, i.e. a function that cannot be written as finite sum, product, difference, power or root of its variable, or a (finite) chaining of these operations.

As such, sqrt, a very stereotypical analytic function (being the solution of x²-const=0), is and feels very much out of place in the list above. But we don't mind. You do you, sqrt, you do you.
