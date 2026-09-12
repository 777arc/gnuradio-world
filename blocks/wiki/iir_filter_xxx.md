<!-- block: iir_filter_xxx -->
<!-- title: IIR Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/IIR_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Construct an IIR that satisfies the following difference equation:

 y[n] - \sum_{k=1}^{M} a_k y[n-k] = \sum_{k=0}^{N} b_k x[n-k],
where a_k are the feedback taps and b_k are the feedforward taps.
The equation above represents the old style.

The transfer function is as follows:

H(z) = \frac{\sum_{k=0}^{N} b_k z^{-k}}{1 + \sum_{k=1}^{M} a_k z^{-k}}

## Parameters
(R): Run-time adjustable

- Feed-Forward taps (R)
  The taps corresponding to the coefficients b_k for the input

- Feedback taps (R)
  The taps corresponding to the coefficients a_k for the output. Although the first element a_0 must be included, it is ignored and assumed to be 1.

- Old style of taps : The old style of the IIR filter uses feedback taps that are negative of what most definitions use (scipy and Matlab among them). This parameter keeps using the old GNU Radio style and is set to TRUE by default. When taps generated from scipy, Matlab, or gr_filter_design, use the new style by setting this to FALSE.

### Usage
For a single-pole IIR filter:

 y[n] - (1-\alpha) y[n-1] = \alpha x[n] ,

The feed-forward is: [alpha]

The feedback is: [1.0, 1-alpha]

The old style is: True

## Example Flowgraph #1
### FM Broadcast Audio Filter
This will demonstrate how to use the Gnu Radio Filter Design Tool to create an IIR filter.

For this example, we'll create a lowpass filter that will pass the L+R audio signal from a FM broadcast station. We'll use a  RTL-SDR to capture and digitize the signal, then a Gnu Radio flowgraph to filter the signal, demodulate it, filter the audio with the IIR filter, and pass it to an audio sink.

#### Calculating the Filter Tap Coefficients
##### Using Gnu Radio Filter Design Tool
Opening the Filter Design Tool in Gnu Radio (Tools -> Filter Design Tool), we'll select the following:
- IIR
- Low Pass
- Digital (normalize, 0 -1)
- Elliptic

Next, for the audio filter values, "End of Pass Band" and "Start of Stop Band", we'll use the following:
- Sample rate: 240 kHz
- End of pass band: 15 kHz
- Start of stop band: 19 kHz

The calculations require calculating the pass band and stop band edges as a fraction between 0 - 1. Further, the fraction is not the fraction of the sample rate, but the fraction of the Nyquist rate. Given a 240 kHz sample rate, the Nyquist rate is 240 kHz / 2 = 120 kHz. The fractions are calculated as:
- End of pass band: 15 kHz / 120 kHz = 0.125
- Start of stop band: 19 kHz / 120 kHz = 0.1583

We'll leave the pass band loss and minimum attenuation in the stop band at the defaults of 1 and 60 dB, respectively.

Once these are entered, pressing the "Design" button in the bottom, left corner gives us this display:

Filter Design Tool showing the magnitude response for the IIR filter designed with the values above.

Then, selecting the tab in the window entitled "Filter Coefficients", we can see the tap coefficient values that the Design Tool calculated for this filter.

Tap coefficients for IIR audio filter. The coefficients listed as "b" are the "feed-forward" (FIR) taps, and the coefficients listed as "a" are the "feedback" (IIR) taps.

##### Using Gnu Octave
Gnu Octave provides two statements that we can use to calculate the IIR filter coefficients. Again, just as with the Filter Design Tool, we'll calculate the coefficients for an elliptic filter. The two statements are:
- ellipord: This function will calculate the required filter order.
- ellip: This function will calculate the actual taps.

Starting with the "ellipord" statement, we use the same values as with the Filter Design Tool.

- Passband Stop: 0.125
- Stopband Start: 0.1583
- Passband Ripple: 1 dB
- Stopband Attenuation: 60 dB

Entering these values into the statement in Gnu Octave, we get:

>> N=ellipord(0.125,0.1583,1,60)

N = 7

Thus, this is a 7th order filter. Entering this and the other appropriate values into the "ellip" statement, we get:

[b a]=ellip(7,1,60,0.125);

This provides for the feed-forward taps ("b") and feedback taps ("a"). We can store these into a text file for easier retrieval:

dlmwrite('iirFilterTaps.txt',a);

dlmwrite('iirFilterTaps.txt',b,"-append");

The created text file will have two lines. The top line will be the feedback taps ("a) and the bottom line will be the feed-forward taps ("b"):

1,-6.340174409848724,17.52249998727601,-27.33894850582178,25.99064410356948,-15.05003368839574,4.914047575569993,-0.6979371219680993
0.001291352346504791,-0.005001716591051044,0.007737783768411161,-0.003978449333295922,-0.003978449333295922,0.007737783768411161,-0.005001716591051044,0.001291352346504791

You can copy and paste these into the appropriate values in the IIR filter block, as with the Filter Design Tool coefficients.

#### Creating the FM Receiver
Creating the FM receiver flowgraph, we have the following:

Gnu Radio flowgraph to receive and demodulate a FM broadcast signal, then filter the L+R signal from baseband using an IIR filter.

We can copy the coefficients from the Design Tool, first the "b" coefficients into the "Feed-forward Taps" window between parentheses, and the same with the "a" coefficients into the "Feedback Taps" window.

Thus, we should have the following:
- Feed-forward Taps: (0.0012912987959930653,-0.005001494251269359,0.0077374275577011065,-0.003978262546017429,-0.003978262546017442,0.007737427557701125,-0.005001494251269374,0.00129129879599307)
- Feedback Taps: (1.0,-6.340175043116168,17.52250282593767,-27.338953768174193,25.99064916119091,-15.050036246585544,4.914048160415346,-0.69793715055521)
- Old Style of Taps: False

NOTE: Since we used the Filter Design Tool, the "Old Style of Taps" setting should be "False".

The properties for the IIR Filter block should appear as follows:

Properties for IIR Filter block with both feed-forward and feedback taps entered.

#### Running the Flowgraph
Running this flowgraph, we get the following baseband spectral display:

Baseband spectrum from FM broadcast station. The blue spectrum is the full spectrum, showing (from left to right) the L+R signal, pilot tone, L-r stereo signal, RBDS signal and a SCA at 67 kHz. The red spectrum shows the filtered L+R spectrum.

## Example Flowgraph #2
### 8-Band IIR Biquad Equalizer
#### Flow Graph File
Can be found here, alongside with an example of an audio file that can be used (mono, 48 kHz, libsndfile supported coded (Opus), "Fox Tale Waltz Part 1" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License).

#### Description
In this very complex flowgraph, we use coefficients as calculated in Robert Bristow-Johnson Cookbook formulae for audio EQ biquad filter coefficients in a "peakingEQ" configuration.

We choose 8 logarithmically distributed frequencies, and make the (linear!) gain for each of these frequencies adjustable. (The frequencies are also adjustable.)

By disabling the Wav File Source and enabling the Noise source, you can see the frequency response of these filters; you'll want to disable the Audio Sink, to save your speakers from white noise. Enable the Audio Source instead to get a passthrough equalizer.

#### Flowgraph Picture
#### Action Screenshots
This is operating on white noise instead of the audio file.

##### Default (flat) Setting
##### Second Bandpass Amplified
## Source Files
- C++ files
  Main file

- Public header files
  Main file

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/grc/filter_iir_filter_xxx.block.yml]
