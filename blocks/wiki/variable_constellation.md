<!-- block: variable_constellation -->
<!-- title: Constellation Object -->
<!-- source: https://wiki.gnuradio.org/index.php/Constellation_Object -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

## Overview
To understand constellation mapping, see the  Constellation Mapping Tutorial.

This block can be used in conjunction with the  Constellation Decoder,  Constellation Soft Decoder,  Constellation Encoder, and  Constellation Modulator blocks. This object block combines:

- constellation point mapping
- symbol mapping
- amplitude normalization
- rotational symmetry
- dimensionality

The general order for setting up the constellation is symbol mapping -> differential encoding -> constellation mapping. Symbol mapping is used along with differential encoding to ensure that the data is Gray coded. NOTE: If desiring to use differential encoding, the user must select the Variable Constellation option and define their own sequential constellation.

For variable constellations, we define a set of constellation points in complex space and an optional symbol mapping to those points. For a constellation that has 4 symbols, it then has log2(4) = 2 bits/symbol. For example, QPSK could have:

  constel_points = [-1 -1j, -1 + 1j, 1 + 1j, 1 - 1j]

Without symbol mapping, the complex point for an input m is:

  point = constel_points[m]

This leads to the following constellation mapping:

For the example above, the points start at the third quadrant and end at the fourth quadrant. Because the order is clockwise sequential, it can be used with  differential encoding.

Symbol mapping refers to re-arranging the input data values to a different data set. The primary reason for this is to allow for Gray coding when using differential encoding. With the symbol map, both Gray coding and differential coding are possible. For example, this symbol map can be used to provide Gray coding for the QPSK constellation above:

  symbol_map = [0, 1, 3, 2]

With symbol mapping, the complex point for an input m is:

  point = constel_points[symbol_map[m]]

With the symbol mapping of [0,1,3,2], which is applied before the differential encoding (then stripped off in the receiver), and the sequential constellation shown above, the equivalent constellation mapping would be as follows:

This equivalent constellation is  Gray coded, meaning that if a constellation point is mistaken for a neighboring point, the result will only be a single bit error. This symbol mapping is also referred to as the 'pre_diff_code' since this is the mapping before the application of differential encoding, if used.

Differential encoding adds more complexity because the system is no longer memoryless. The complex point now depends on both current and previous inputs. If both symbol mapping and differential encoding are used, then the complex QPSK point for input m at sequence position n is calculated as follows:

  diff_code[n] = (diff_code[n-1] + symbol_map[m]) % 4
  point[n] = constel_points[diff_code[n]]

The Constellation Object does not perform these operations. Instead, the Map,  Differential Encoder, and  Constellation Encoder blocks must be used. For convenience, the  Constellation Modulator automatically performs these tasks.

See for more info.

## Parameters
- Constellation Type
  Either Variable Constellation or a set of predefined constellations based on modulation scheme. Choose Variable Constellation for manual control. The mapping of the predefined constellations are shown here:

  Predefined constellations available in the Constellation Object. Note that only BPSK and DQPSK can be used with differential encoding.

- Symbol Map
  (Available when using Variable Constellation) Manually specify the symbol map in list form.

- Constellation Points
  (Available when using Variable Constellation) Manually specify the constellation points, using a list of complex numbers.

- Rotational Symmetry
  (Available when using Variable Constellation) The number of rotations per 360 degrees that the constellation is symmetric, which is 4 for the common constellations. This doesn't affect the encoding / decoding, but allows unit tests and potentially other blocks to know if decodes will work for rotated constellations.

- Dimensionality
  (Available when using Variable Constellation) The number of complex dimensions, typically set to 1. Dimensionality is the number of input samples per symbol, all of which should be close to the constellation point. I.e. if greater than 1 these should **not** be samples for a smooth transition between constellation points, but will de facto be treated as an averaged for symbol selection.

- Normalization Type
  Optionally normalize the constellation based on average amplitude or power.

- Soft Decisions Precision
  Specifies how accurate the look up table (LUT) is to a given number of bits.

- Soft Decisions LUT
  List of floating point tuples that acts as the look up table (LUT) for soft decisions. Can be set to 'None' for no table. Without a table, soft decision calculations are much slower.

## Example Flowgraph
This flowgraph generates random symbols using QPSK, and then simulates a receiver by synchronizing to the signal and performing soft decoding.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/lib/constellation.cc see middle of this page

- Public header files
  constellation.h

- Block definition
  digital_constellation.block.yml
