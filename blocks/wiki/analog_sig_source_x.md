<!-- block: analog_sig_source_x -->
<!-- title: Signal Source -->
<!-- source: https://wiki.gnuradio.org/index.php/Signal_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Signal generator: generates a variety of waveforms.

Supports an output of type complex, float, int, and short

## Parameters
(R): Run-time adjustable

- Sample Rate (R)
  Default value: samp_rate
  Sample rate (fs) is the average number of samples obtained in one second. Its units are samples per second or hertz e.g. 48,000 sample rate is 48 kHz.

- Waveform (R)
  options: [Constant, Sine, Cosine, Square, Triangle, Saw Tooth]
  Description: see "Waveform Types" below

- Frequency (R)
  Frequency of the waveform (default: 1000)

- Amplitude (R)
  Amplitude of the output (default: 1)

- Offset (R)
  Offset from zero (default: 0)

- Initial Phase (Radians) (R)
  Default: 0

## Waveform Types
- Constant
  A constant value as specified by Amplitude + Offset
- Sine
  Real-valued signal types: Amplitude·sin(2π·Frequency/Sample Rate·n) + Offset
  Complex-valued signal types: Amplitude·[cos(2π·Frequency/Sample Rate·n) + 1j·sin(2π·Frequency/Sample Rate·n)] + Offset
- Cos
  Real-valued signal types: Amplitude·cos(2π·Frequency/Sample Rate·n) + Offset
  Complex-valued signal types (identical to Sin): Amplitude·cos(2π·Frequency/Sample Rate·n) + 1j·sin(2π·Frequency/Sample Rate·n) + Offset
- Square (Phase wraps in [–π,+π], increasing by Frequency/Sample Rate every sample)
  Real-valued signal types:
  : phase analog.GR_CONST_WAVE
  Sine: analog.GR_SIN_WAVE
  Cosine: analog.GR_COS_WAVE
  Square: analog.GR_SQR_WAVE
  Triangle: analog.GR_TRI_WAVE
  Sawtooth: analog.GR_SAW_WAVE

## Message Ports
- cmd
  The 'cmd' message port accepts message pairs.
  *'freq' . float value
  *'ampl' . float value
  *'phase' . float value
  *'offset' . float value
  For GNU Radio 3.8, the messages dont work correctly with pairs, but they do work fine with a dictionary. This issue is explained here.
  The amplitude of the signal source can be changed to 0.5 by adding the following PMT to the message strobe block.
  ```
pmt.dict_add(pmt.make_dict(), pmt.intern("ampl"), pmt.from_double(0.5))
```

  The above command creates a dictionary and adds a pmt pair of ("ampl", 0.5) to the dictionary.

- freq
  The value of frequency in the signal source can be changed by connecting a message strobe. The Message PMT parameter can be set to pmt.from_float(new_freq). In this way, the frequency of the signal source will be changed to new_freq value after the specified period in the message strobe.

  The 'freq' message port has been deprecated in 3.9 in favor of the 'cmd' message port.

## Example Flowgraph
This flowgraph is for version 3.9+.

## Example Output
Types of Waveforms:

Cosine (complex):

Constant:

Square:

Triangle:

Sawtooth:

## Source Files
- C++ files
  sig_source_impl.cc

- Header files
  sig_source_impl.h

- Public header files
  Base
  Waveforms

- Block definition
  analog_sig_source_x.block.yml
