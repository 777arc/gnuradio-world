<!-- block: fft_vxx -->
<!-- title: FFT -->
<!-- source: https://wiki.gnuradio.org/index.php/FFT -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block takes in a vector of floats or complex values and calculates the FFT.  If all you do is want to see the frequency domain of a signal, the QT GUI Frequency Sink is more user friendly.

Note that even if the input signal is real, the output will be complex, so you must use a Complex to Mag or similar block if you want to see magnitude.

The FFT operation is defined for a vector x with N uniformly
sampled points by

X(a) = \sum_{k=0}^{N-1} x(a) \cdot e^{-j 2\pi k a / N}

X = FFT\{x\} is the the FFT transform of x(a), j is
the imaginary unit j^2=-1, k and a range from 0 to N-1.

The IFFT operation is defined for a vector y with N uniformly sampled points by

Y(b) = \sum_{k=0}^{N-1} y(b) \cdot e^{j 2\pi k b / N}

Y = IFFT\{y\} is the the inverse FFT transform of y(b),
j is the imaginary unit, k and b range from 0 to
N-1.

Note, that due to the underlying FFTW library, the output of a FFT followed by an IFFT (or the other way around) will be scaled i.e.
FFT\{ \, IFFT\{x\} \,\} =  N \cdot x \neq x.

See http://www.fftw.org/faq/section3.html#whyscaled

## Parameters
- FFT Size
  Number of samples used in each FFT calculation, which also determines how many points are in the output.

- Forward/Reverse
  Whether to do an FFT or IFFT.

- Window
  Type of window to apply to each set of samples before the FFT is taken, default is a blackmanharris window. The argument of the window.blackmanharris() function is simply how many points in the window, which must match the FFT size. If an empty window "[]" is supplied then no windowing math is performed.
- Shift
  Whether or not to do an "fft shift" which puts DC (0 Hz) in the center.  If you are not sure what this means, leave it set to Yes. Only active when input type is complex.

- Num Threads
  Number of threads to assign to perform the FFTs.

## Example Flowgraph
This flowgraph shows how the FFT block can be used to reproduce the behavior of the QT GUI Frequency Sink block.  Both outputs match, but using the FFT block directly requires converting from a stream to vector, and performing the magnitude and log manually.

The 'fast multiply const' block multiplies by 1/vector_length. The Log10 block multiplies also by 10 (n=10).

Injecting a constant value waveform (amplitude of 1) and applying a rectangular window gives us an impulse (Dirac delta). The peak value has its maximum value at 0 dBfs, telling us that the reference is a vector containing ones.

## Source Files
- C++ files
  Complex input
  Real input
  Core algorithms

- Header files
  Complex input
  Real input

- Public header files
  Complex input
  Real input

- Block definition
  GRC yaml
