<!-- block: digital_glfsr_source_x -->
<!-- title: GLFSR Source -->
<!-- source: https://wiki.gnuradio.org/index.php/GLFSR_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Galois LFSR (linear feedback shift register) pseudo-random source generating either byte outputs (0 or 1) or float outputs (-1.0 or 1.0).

## Overview
There are two, general types of shift registers. These are the Galois shift register and the Fibonacci shift register. The Galois uses "internal feedback", while the Fibonacci shift register uses "external feedback". With the same polynomial, either will generate the same sequence. The only difference will be a time shift between the two sequences. Relative to the output of the Galois shift register, the sequence of the Fibonacci shift register will be shifted in time. The amount of time depends on the number of feedback taps and their values.

With the correct set of feedback taps ("mask"), or with a mask of 0, this block will generate a maximal length sequence of length 2^degree-1.

## Parameters
- Degree
  Degree of shift register must be in [1, 32] for Gnu Radio Companion versions 3.9 or earlier, or [1,64] for versions 3.10 or later. If mask is 0, the degree determines a default mask (see digital_impl_glfsr.cc for the mapping). This default mask will be a maximal length sequence.

- Repeat
  Set to repeat sequence.

- Mask
  The mask determines the feedback taps for the shift register. It allows a user-defined bit mask for indexes of the shift register to feed back. For example the two fifth-order primitive polynomials, p(x) = x^5 + x^4 + x^3 + x^2 + 1 and p(x) = x^5 + x^2 + 1, will create m-sequences of length 2^n-1 where n is the degree. The mask is in byte format specifying the taps. The "one" in the polynomial does not correspond to a tap – it corresponds to the input to the first bit and is excluded from the mask. So the polynomials would be entered into the mask as 0x1E and 0x12 respectively. Note that these are integers, so after they are entered in the GNURadio block, they will show as decimal 30 and 18, respectively. These can also be entered in binary format (0b11110 and 0b10010, respectively) or decimal format (30 and 18, respectively). Such entries will provide the same result.

- Seed
  Initial setting for values in shift register.

## Example Flowgraph
Example of the two polynomials, p(x) = x^5 + x^4 + x^3 + x^2 + 1 and p(x) = x^5 + x^2 + 1, to create a Gold Code Sequence.

## Source Files
- C++ files

  glfsr_source_b_impl.cc
  glfsr.cc

- Header files
  glfsr_source_b_impl.h

- Public header files
  glfsr.h

- Block definition
  digital_glfsr_source_x.block.yml
