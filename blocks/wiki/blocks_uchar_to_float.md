<!-- block: blocks_uchar_to_float -->
<!-- title: UChar To Float -->
<!-- source: https://wiki.gnuradio.org/index.php/UChar_To_Float -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert stream of unsigned chars to a stream of floats. A UChar data type is an unsigned 8-bit integer, meaning it will have integer values between 0 - 255.

## Example Flowgraphs
### Example #1 - Showing Binary Values
This flowgraph shows the outputs of AND, OR, and XOR logic blocks converted to Float to display in a Time Sink.

### Example #2 - Showing the Raw Output Values of a RTL-SDR
Samples collected using the "rtl_sdr" command from a terminal will collect raw samples as provided by a RTL-SDR. These are unsigned 8-bit integer values, meaning they have values from 0 - 255.

The flowgraph used to read the sample file is as follows:

The flowgraph takes the values and uses the UChar to Float block to input the samples from the original file source. The Stream Demux block separates the real and imaginary samples, which are input to the Float To Complex block. The QT GUI Time Sink shows the complex samples with values from 0 - 255, as shown below.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/uchar_to_float_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/uchar_to_float_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/include/gnuradio/blocks/uchar_to_float.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_uchar_to_float.block.yml]
