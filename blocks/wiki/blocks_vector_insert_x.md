<!-- block: blocks_vector_insert_x -->
<!-- title: Vector Insert -->
<!-- source: https://wiki.gnuradio.org/index.php/Vector_Insert -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Insert a vector periodically into a stream of data.

Note that parameters are used so that there is one instance of the inserted vector every Periodicity output samples

And not so that every Periodicity input items, a vector is inserted.

Also note that the Offset parameter specifies where in the cycle period the block starts at, and not what is the offset of the inserted vector.

For instance, if one wants to insert a 100 samples long vector every 800 input samples, and have 300 samples before the first vector is inserted,
One should set Periodicity to 900, and Offset to 600.

## Parameters
- Vector
  Vector of data to insert

- Periodicity
  The length of the periodicity at which the vector should be inserted at the output (i.e. one vector for every N output items). Must be higher than Vector length

- Offset
  Offset specifies where in the cycle period we should begin at. Must be positive and lower than Periodicity

## Example Flowgraph
Media:example_vector_insert.grc

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/vector_insert_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/vector_insert_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/include/gnuradio/blocks/vector_insert.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_vector_insert_x.block.yml]
