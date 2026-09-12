<!-- block: vocoder_cvsd_decode_bs -->
<!-- title: CVSD Audio Decoder (Raw Bit-Level) -->
<!-- source: https://wiki.gnuradio.org/index.php/CVSD_Audio_Decoder_(Raw_Bit-Level) -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block performs CVSD audio decoding.
Its design and implementation is modeled after the CVSD encoder/decoder specifications defined in the Bluetooth standard.

CVSD is a method for encoding speech that seeks to reduce the bandwidth required for digital voice transmission.
CVSD takes advantage of strong correlation between samples, quantizing the difference in amplitude between two consecutive samples.
This difference requires fewer quantization levels as compared to other methods that quantize the actual amplitude level, reducing the bandwidth.
CVSD employs a two level quantizer (one bit) and an adaptive algorithm that allows for continuous step size adjustment.

The coder can represent low amplitude signals with accuracy without sacrificing performance on large amplitude signals, a trade off that occurs in some non-adaptive modulations.

The CVSD decoder effectively provides 1-to-8 decompression. More specifically, for each incoming input bit, the decoder outputs one audio sample.  If the input is a "1" bit, the internal reference is increased appropriately and then outputted as the next estimated audio sample.  If the input is a "0" bit, the internal reference is decreased appropriately and then likewise outputted as the next estimated audio sample. Grouping 8 input bits together, the encoder essentially produces 8 output audio samples for everyone one input byte.

This decoder requires that output audio samples are 2-byte short signed integers.
The result bandwidth conversion, therefore, is 1 byte of encoded audio data to 16 output bytes of raw audio data.

The CVSD decoder module must be post-fixed by a down-converter to under-sample the audio data after decoding.
The Bluetooth standard specifically calls for a 8-to-1 decimating down-converter.  This is required so that so that output sampling rate equals the original input sampling rate present before the encoder.  In all cases, the output down-converter rate must be the inverse of the input up-converter rate before the CVSD encoder.

 References:
 1. Continuously Variable Slope Delta Modulation (CVSD) A Tutorial, available here
 2.  Specification of The Bluetooth System, available: here
 3.  McGarrity, S., Bluetooth Full Duplex Voice and Data Transmission. 2002. Bluetooth Voice Simulink Model, available: here

## Parameters
None. The default parameters are modeled after the Bluetooth standard and should not be changed, except by an advanced user.

## Example Flowgraph
Small GRC flowgraph to experiment with the use of the blocks.
Specifically to understand: Oversampling requirement, Float to short conversion and impact on audio quality across frequency.

Media:cvsd.grc

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-vocoder/lib/cvsd_decode_bs_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-vocoder/lib/cvsd_decode_bs_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-vocoder/include/gnuradio/vocoder/cvsd_decode_bs.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-vocoder/grc/vocoder_cvsd_decode_bs.block.yml]
