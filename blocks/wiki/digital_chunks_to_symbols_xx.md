<!-- block: digital_chunks_to_symbols_xx -->
<!-- title: Chunks to Symbols -->
<!-- source: https://wiki.gnuradio.org/index.php/Chunks_to_Symbols -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Map a stream of unpacked symbol indexes to stream of float or complex constellation points in D dimensions

out[n D + k] = symbol_table[in[n] D + k], k=0,1,...,D-1

The combination of Packed to Unpacked followed by this block handles the general case of mapping from a stream of bytes or shorts into arbitrary float or complex symbols.

## Parameters
(R): Run-time adjustable

- Symbol table (R): list that maps chunks to symbols. That list should have a length of  x

- Dimension : Dimension of the table.

- Num ports : Number of input and output stream to process. Each stream is processed isolated from each other.

## Example Flowgraph
## Source Files
- C++ files
  chunks_to_symbols_impl.cc

- Header files
  chunks_to_symbols_impl.h

- Public header files
  chunks_to_symbols.h

- Block definition
  digital_chunks_to_symbols.block.yml
