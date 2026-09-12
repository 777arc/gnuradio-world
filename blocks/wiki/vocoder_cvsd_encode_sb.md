<!-- block: vocoder_cvsd_encode_sb -->
<!-- title: CVSD Audio Encoder (Raw Bit-Level) -->
<!-- source: https://wiki.gnuradio.org/index.php/CVSD_Audio_Encoder_(Raw_Bit-Level) -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block performs CVSD audio encoding.
Its design and implementation is modeled after the CVSD encoder/decoder specifications defined in the Bluetooth standard.

CVSD is a method for encoding speech that seeks to reduce the bandwidth required for digital voice transmission. CVSD takes  advantage of strong correlation between samples, quantizing the difference in amplitude between two consecutive samples. This difference requires fewer quantization levels as compared to  other methods that quantize the actual amplitude level, reducing the bandwidth. CVSD employs a two level quantizer (one bit) and an adaptive algorithm that allows for continuous step size adjustment.

The coder can represent low amplitude signals with accuracy without sacrificing performance on large amplitude signals, a trade off that occurs in some non-adaptive modulations.

The CVSD encoder effectively provides 8-to-1 compression. More specifically, each incoming audio sample is compared to an  internal reference value. If the input is greater or equal to  the reference, the encoder outputs a "1" bit. If the input is less than the reference, the encoder outputs a "0" bit. The reference value is then updated accordingly based on the frequency of outputted "1" or "0" bits. By grouping 8 outputs  bits together, the encoder essentially produce one output byte for every 8 input audio samples.

This encoder requires that input audio samples are 2-byte short signed integers. The result bandwidth conversion, therefore, is 16 input bytes of raw audio data to 1 output byte of encoded  audio data.

The CVSD encoder module must be prefixed by an up-converter to over-sample the audio data prior to encoding. The Bluetooth standard specifically calls for a 1-to-8 interpolating  up-converter. While this reduces the overall compression of the codec, this is required so that the encoder can accurately compute the slope between adjacent audio samples and correctly update its internal reference value.

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
  [https://github.com/gnuradio/gnuradio/blob/main/gr-vocoder/lib/cvsd_encode_sb_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-vocoder/lib/cvsd_encode_sb_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-vocoder/include/gnuradio/vocoder/cvsd_encode_sb.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-vocoder/grc/vocoder_cvsd_encode_sb.block.yml]
