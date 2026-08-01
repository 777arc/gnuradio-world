// A polyphase near-perfect-reconstruction (NPR) channelizer, offered alongside
// the plain FFT as the way the spectrogram turns IQ into rows of magnitudes.
//
// The FFT path (calcFfts in ./selector) slices the recording into
// non-overlapping blocks of `fftSize` samples and transforms each one. That is a
// rectangular window, so its channel shapes are Dirichlet kernels: -13 dB first
// sidelobes, and a tone landing between two bins loses up to 3.92 dB off the
// peak (scalloping). Picking a different window trades one for the other -- it
// buys sidelobes back with a wider main lobe and a coarser picture.
//
// A channelizer does not have to make that trade, because it is not limited to
// one sample per channel of filter. Here each of the M channels is a decimating
// FIR of M*P taps, all M of them evaluated at once by folding the windowed input
// down to M points and taking one M-point DFT -- the standard polyphase DFT
// filter bank. With P taps per channel there is enough freedom left to shape the
// channel response properly, and the prototype is designed so the bank is
// *power complementary*:
//
//     sum over channels k of |H(f - k/M)|^2  ==  1, for every f
//
// which is the defining condition of a near-perfect-reconstruction filter bank.
// Its consequences are what a reader actually sees in the spectrogram: a tone
// is confined to the one or two channels it actually falls in rather than
// smeared across the row, and it reads the same total power wherever it sits
// between them, so a drifting carrier does not scallop in and out.
//
// The prototype is designed by frequency sampling. |H| is a root-raised-cosine
// with its symbol rate set to the channel spacing 1/M, so |H|^2 is a raised
// cosine, and the raised cosine's Nyquist property is exactly the power
// complementarity above. Sampling it on the L = M*P point grid and inverse
// transforming gives a length-L filter whose response passes through the design
// values *exactly* at those L frequencies and ripples slightly between them --
// which is the "near" in near-perfect. `editor/test/channelizer.test.mjs`
// measures that ripple and the properties above.

import { FFT } from '@/utils/fft';

// Taps per channel: the prototype is this many times longer than the DFT, and
// each output row overlaps this many of its neighbours. 8 puts the residual
// complementarity ripple far below anything a colormap can show while keeping
// the per-row cost around one FFT's worth of multiply-accumulates.
export const CHANNELIZER_TAPS_PER_CHANNEL = 8;

// Excess bandwidth of the root-raised-cosine prototype, as a fraction of the
// channel spacing. 1.0 spreads the transition over a full channel on each side,
// which is the widest -- and so the most sharply decaying in time, i.e. the best
// behaved under truncation -- prototype that still overlaps only its immediate
// neighbours.
export const CHANNELIZER_ROLLOFF = 1.0;

// Rows emitted per numChannels input samples -- the bank's oversampling factor,
// M/D. 1 is critically sampled, which is what a plain FFT spectrogram also is:
// consecutive rows share no input samples.
export const CHANNELIZER_OVERSAMPLING = 1;

// What the settings pane offers for each. Taps per branch is even-only because
// the useful range is short and the even lengths keep the prototype centred on a
// whole sample; oversampling has to divide the channel count, so powers of two.
export const CHANNELIZER_TAPS_CHOICES = [4, 6, 8, 10, 12];
export const CHANNELIZER_OVERSAMPLING_CHOICES = [1, 2, 4];

export interface ChannelizerPrototype {
  numChannels: number;
  tapsPerChannel: number;
  rolloff: number;
  // Length numChannels * tapsPerChannel, scaled to unit DC gain (sum == 1) so a
  // tone at the centre of a channel comes out of the bank at its own amplitude,
  // matching what calcFfts reports after its divide by fftSize.
  taps: Float64Array;
}

// Raised cosine of unit peak, as a function of frequency measured in channel
// spacings. Flat out to (1-rolloff)/2, cosine taper to (1+rolloff)/2, zero
// beyond. Its Nyquist property -- shifted copies one channel apart summing to 1
// -- is what makes the square root of it power complementary.
function raisedCosine(channels: number, rolloff: number): number {
  const f = Math.abs(channels);
  const flat = (1 - rolloff) / 2;
  const edge = (1 + rolloff) / 2;
  if (f <= flat) return 1;
  if (f >= edge) return 0;
  return 0.5 * (1 + Math.cos((Math.PI / rolloff) * (f - flat)));
}

export function designNprPrototype(
  numChannels: number,
  tapsPerChannel: number = CHANNELIZER_TAPS_PER_CHANNEL,
  rolloff: number = CHANNELIZER_ROLLOFF
): ChannelizerPrototype {
  const numChan = numChannels | 0;
  const perChan = tapsPerChannel | 0;
  // The channel count is the size of the DFT the fold feeds, which is radix-4.
  // Taps per channel only sets how long the filter is, so it is free.
  if (numChan < 2 || (numChan & (numChan - 1)) !== 0)
    throw new Error('channelizer numChannels must be a power of two and at least 2');
  if (perChan < 2 || perChan !== tapsPerChannel)
    throw new Error('channelizer tapsPerChannel must be a whole number of at least 2');
  if (!(rolloff > 0) || rolloff > 1) throw new Error('channelizer rolloff must be in (0, 1]');

  const length = numChan * perChan;

  // The design is a frequency sampling: |H| is placed on the length-point grid,
  // where bin k sits at k/length cycles per sample -- k/perChan channel
  // spacings -- and the taps are its inverse transform. Rather than transform a
  // mostly-empty spectrum, the sum runs over the bins that are actually nonzero:
  // the root-raised-cosine dies at (1+rolloff)/2 channel spacings, so there are
  // only about perChan*(1+rolloff) of them however long the filter is. That also
  // leaves the filter length free of the power-of-two the FFT would have wanted.
  const support = Math.floor((perChan * (1 + rolloff)) / 2);

  // cos(2*pi*j/length) at every grid point, so the sum below walks it with an
  // integer stride instead of calling trig length*support times.
  const cosine = new Float64Array(length);
  for (let j = 0; j < length; j++) cosine[j] = Math.cos((2 * Math.PI * j) / length);

  const taps = new Float64Array(length);
  taps.fill(1); // the k = 0 bin, where the root-raised-cosine is 1

  for (let k = 1; k <= support; k++) {
    const magnitude = Math.sqrt(raisedCosine(k / perChan, rolloff));
    if (magnitude === 0) continue;
    // Bins k and -k are equal and fold together, except for a bin sitting exactly
    // at Nyquist, which is its own pair. The (-1)^k is a delay of half the filter
    // length, which moves the impulse response off the wrap-around and into the
    // middle of the buffer; being real, it leaves the taps real.
    const pairs = 2 * k === length ? 1 : 2;
    const weight = pairs * (k % 2 === 0 ? magnitude : -magnitude);
    let index = 0;
    for (let n = 0; n < length; n++) {
      taps[n] += weight * cosine[index];
      index += k;
      if (index >= length) index -= length;
    }
  }

  // The transform of a real even spectrum is real and even about zero, so after
  // the half-length delay the taps are symmetric as h[n] == h[L-n] for
  // 1 <= n < L, with h[0] -- the one tap with no partner -- holding the far tail.
  let dcGain = 0;
  for (let n = 0; n < length; n++) {
    taps[n] /= length;
    dcGain += taps[n];
  }
  for (let n = 0; n < length; n++) taps[n] /= dcGain;

  return { numChannels: numChan, tapsPerChannel: perChan, rolloff, taps };
}

const prototypeCache = new Map<string, ChannelizerPrototype>();

export function getNprPrototype(
  numChannels: number,
  tapsPerChannel: number = CHANNELIZER_TAPS_PER_CHANNEL,
  rolloff: number = CHANNELIZER_ROLLOFF
): ChannelizerPrototype {
  const key = `${numChannels}:${tapsPerChannel}:${rolloff}`;
  let prototype = prototypeCache.get(key);
  if (!prototype) {
    prototype = designNprPrototype(numChannels, tapsPerChannel, rolloff);
    prototypeCache.set(key, prototype);
  }
  return prototype;
}

// Discrete-time Fourier transform of the prototype at one frequency, in cycles
// per sample. Channel k of the bank is this response shifted to k/numChannels,
// so this is the function the power-complementarity condition is stated over.
export function prototypeResponse(prototype: ChannelizerPrototype, freq: number): { re: number; im: number } {
  const { taps } = prototype;
  let re = 0;
  let im = 0;
  for (let n = 0; n < taps.length; n++) {
    const phase = -2 * Math.PI * freq * n;
    re += taps[n] * Math.cos(phase);
    im += taps[n] * Math.sin(phase);
  }
  return { re, im };
}

// The DFT and its buffers are per channel count, not per frame, and a
// spectrogram calls channelizeFrame once per row -- so they are built once and
// reused. Everything here runs synchronously on one thread, so a single set is
// enough.
interface ChannelizerWorkspace {
  fft: FFT;
  folded: Float64Array;
  spectrum: Float64Array;
}
const workspaceCache = new Map<number, ChannelizerWorkspace>();

function workspaceFor(numChannels: number): ChannelizerWorkspace {
  let workspace = workspaceCache.get(numChannels);
  if (!workspace) {
    workspace = {
      fft: new FFT(numChannels),
      folded: new Float64Array(numChannels * 2),
      spectrum: new Float64Array(numChannels * 2),
    };
    workspaceCache.set(numChannels, workspace);
  }
  return workspace;
}

// One row of the bank: the M*P samples starting at `startSample` (in IQ samples,
// so twice that into `samples`) run through the polyphase filter and an M-point
// DFT. Samples outside the buffer, and the -Infinity the loader writes for a row
// it has not fetched yet, count as zero.
//
// Folding first is what makes this one DFT rather than M filters:
//     channel k = sum over m of x[m] h[m] exp(-j2*pi*k*m/M)
// and splitting m into n + p*M makes the exponential depend on n alone, so the
// P taps that share an n can be summed before the DFT ever runs.
export function channelizeFrame(
  prototype: ChannelizerPrototype,
  samples: Float32Array,
  startSample: number,
  out?: Float32Array
): Float32Array {
  const { numChannels, tapsPerChannel, taps } = prototype;
  const magnitudes = out && out.length === numChannels ? out : new Float32Array(numChannels);
  const { fft, folded, spectrum } = workspaceFor(numChannels);

  folded.fill(0);
  let liveGain = 0;
  for (let p = 0; p < tapsPerChannel; p++) {
    const tapBase = p * numChannels;
    const sampleBase = startSample + tapBase;
    for (let n = 0; n < numChannels; n++) {
      const index = (sampleBase + n) * 2;
      if (index < 0 || index + 1 >= samples.length) continue;
      const re = samples[index];
      const im = samples[index + 1];
      if (!Number.isFinite(re) || !Number.isFinite(im)) continue;
      const tap = taps[tapBase + n];
      liveGain += tap;
      folded[n * 2] += re * tap;
      folded[n * 2 + 1] += im * tap;
    }
  }

  // The rows within half a prototype of either end of the buffer see zeros over
  // part of their window, and the spectrogram shows the top and bottom of the
  // visible span, so that would be a dark band on every screen. Rescaling by the
  // DC gain the taps that did see data actually carry puts those rows back at
  // the right level; the taps are unit gain everywhere else, so this is exactly
  // 1 for every interior row and changes nothing. Their channel shaping is still
  // the truncated one -- there is no data to shape it with.
  fft.transform(spectrum, folded);
  const scale = liveGain > 1e-6 ? 1 / liveGain : 0;

  // DC to the middle, so the row reads left-to-right as -fs/2 .. +fs/2 like the
  // FFT path's fftshift leaves it.
  const half = numChannels >> 1;
  for (let k = 0; k < numChannels; k++) {
    const re = spectrum[k * 2];
    const im = spectrum[k * 2 + 1];
    magnitudes[(k + half) % numChannels] = Math.sqrt(re * re + im * im) * scale;
  }
  return magnitudes;
}

export interface ChannelizerOptions {
  tapsPerChannel?: number;
  rolloff?: number;
  // How many frames the bank takes per numChannels input samples: the ratio M/D
  // of the channel count to the decimation, the channelizer's oversampling
  // factor. 1 is critically sampled -- each frame advances a full numChannels
  // samples, so consecutive frames share no input. 2 advances half that, the
  // 50%-overlap bank; 4 advances a quarter. Only the hop changes, never the
  // prototype: channel spacing and shaping are set by numChannels and
  // tapsPerChannel alone, and the display's row rate is not affected either --
  // see calcChannelizerFfts for what the extra frames are used for.
  oversampling?: number;
}

// How far apart consecutive rows are, in input samples.
export function channelizerHop(numChannels: number, oversampling: number = CHANNELIZER_OVERSAMPLING): number {
  if (!Number.isInteger(oversampling) || oversampling < 1)
    throw new Error('channelizer oversampling must be a whole number of at least 1');
  if (numChannels % oversampling !== 0)
    throw new Error('channelizer oversampling must divide the channel count');
  return numChannels / oversampling;
}

// Drop-in alternative to calcFfts: same input layout (interleaved IQ, one row
// per `numChannels` samples), same output (rows of `numChannels` magnitudes in
// dB, DC centred, concatenated). That holds at every oversampling factor -- the
// spectrogram's row grid is the display's, not the bank's.
//
// The one difference from the FFT path is that a row is not computed from its
// own samples alone: it is centred on them but reaches tapsPerChannel/2 rows
// either side, which is where the channel shaping comes from. Rows off the ends
// of the buffer see zeros there, exactly as if the recording were padded.
//
// Above an oversampling of 1 the bank runs faster than the display: `oversampling`
// frames are taken per row, spaced hop samples apart and placed symmetrically
// about the row's own block, and the row is their RMS. So the time axis never
// moves -- what the extra frames buy is that a transient falling between two
// critically sampled frames still lands in a row, and that a noise floor
// averages down by roughly sqrt(oversampling) instead of speckling.
export function calcChannelizerFfts(
  samples: Float32Array,
  numChannels: number,
  numberOfRows: number,
  options: ChannelizerOptions = {}
): Float32Array {
  const {
    tapsPerChannel = CHANNELIZER_TAPS_PER_CHANNEL,
    rolloff = CHANNELIZER_ROLLOFF,
    oversampling = CHANNELIZER_OVERSAMPLING,
  } = options;
  const prototype = getNprPrototype(numChannels, tapsPerChannel, rolloff);
  const hop = channelizerHop(numChannels, oversampling);
  const rows = new Float32Array(numberOfRows * numChannels);
  const magnitudes = new Float32Array(numChannels);
  const power = new Float64Array(numChannels);

  const halfWindow = (prototype.tapsPerChannel * numChannels) / 2;

  for (let row = 0; row < numberOfRows; row++) {
    const centre = row * numChannels + numChannels / 2;
    // The loader fills a row it has not fetched with -Infinity, and calcFfts
    // turns that into a row of zeros, which fftToRGB paints grey. Match it
    // rather than letting the neighbouring rows leak into the gap.
    if (!Number.isFinite(samples[centre * 2])) continue;

    power.fill(0);
    for (let frame = 0; frame < oversampling; frame++) {
      // Symmetric about the centre of the block the row stands for, so averaging
      // the frames cannot drag the row off its own samples. At an oversampling
      // of 1 this is that centre exactly, which is the same numChannels samples
      // the FFT path would have transformed -- so both methods put the same
      // event on the same row.
      const frameCentre = centre + Math.round((frame - (oversampling - 1) / 2) * hop);
      channelizeFrame(prototype, samples, frameCentre - halfWindow, magnitudes);
      for (let k = 0; k < numChannels; k++) power[k] += magnitudes[k] * magnitudes[k];
    }

    for (let k = 0; k < numChannels; k++) {
      // The RMS of the frames, reported as 10*log10 of a magnitude rather than
      // of a power -- the scale calcFfts uses, which is what the magnitude
      // min/max sliders are calibrated against. Averaging power is what makes
      // the noise floor settle; averaging the dB would be a geometric mean, and
      // would drag every row down towards its deepest null.
      const db = 5 * Math.log10(power[k] / oversampling);
      rows[row * numChannels + k] = Number.isFinite(db) ? db : 0;
    }
  }
  return rows;
}
