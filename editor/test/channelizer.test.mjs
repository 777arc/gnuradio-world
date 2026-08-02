// The recording viewer's polyphase channelizer (src/recording/utils/channelizer.ts),
// the alternative to one FFT per row that the spectrogram's Polyphase
// Channelizer toggle selects.
//
// The claim being tested is that the filter bank is *near-perfect
// reconstruction*, which is the pair of properties:
//
//   1. Power complementarity. Summing the squared magnitude responses of all M
//      channels gives 1 at every frequency, so no frequency is favoured over any
//      other and a tone reads the same total power wherever it lands. This is
//      the defining NPR condition, and it is where "near" comes from: the
//      prototype is designed by sampling a root-raised-cosine on the M*P point
//      frequency grid, which makes the sum exactly 1 at those M*P frequencies
//      and leaves a small ripple in between.
//
//   2. Channel localization. Each channel's response dies off within a channel
//      spacing, so a tone reaches only the one or two channels it actually falls
//      in rather than the whole row.
//
// Both matter, because either one alone is easy. The plain FFT this replaces is
// a filter bank too -- a rectangular prototype one tap per channel long -- and
// it satisfies (1) *exactly*, by Parseval; what it cannot do is (2), and its
// -13 dB Dirichlet sidelobes are why a strong carrier streaks across an FFT
// spectrogram row. Conversely an ordinary windowed-sinc prototype gets (2) and
// badly misses (1). The suite checks the channelizer against both of those as
// controls, so a passing (1) is evidence about the prototype design rather than
// about the arithmetic being trivially right.
//
// No browser and no WASM build: this is the DSP only.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// The viewer's sources address each other as '@/...' (see vite.config.ts), so
// the bundle needs the same alias.
const out = join(tmpdir(), `channelizer-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('./_recording-entry.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  alias: { '@': resolve(new URL('../src/recording', import.meta.url).pathname) },
});
const {
  CHANNELIZER_OVERSAMPLING_CHOICES,
  CHANNELIZER_ROLLOFF,
  CHANNELIZER_TAPS_CHOICES,
  CHANNELIZER_TAPS_PER_CHANNEL,
  calcChannelizerFfts,
  calcFfts,
  channelizeFrame,
  channelizerHop,
  designNprPrototype,
  getNprPrototype,
  prototypeResponse,
} = await import(pathToFileURL(out));

// Small enough to keep the suite instant, large enough that a channel spacing is
// a real fraction of the band. The properties under test are all stated per
// channel spacing and hold at any size; one larger case at the end checks that.
const M = 64;
const P = CHANNELIZER_TAPS_PER_CHANNEL;
const prototype = designNprPrototype(M, P);

// --- helpers --------------------------------------------------------------

// A complex tone of unit amplitude at `freq` cycles per sample, in the
// interleaved layout the viewer feeds the spectrogram.
function tone(numSamples, freq) {
  const samples = new Float32Array(numSamples * 2);
  for (let n = 0; n < numSamples; n++) {
    samples[n * 2] = Math.cos(2 * Math.PI * freq * n);
    samples[n * 2 + 1] = Math.sin(2 * Math.PI * freq * n);
  }
  return samples;
}

const rowOf = (rows, numChannels, row) => Array.from(rows.slice(row * numChannels, (row + 1) * numChannels));

// The rows are 10*log10 of a magnitude (the scale the magnitude sliders are
// calibrated in, inherited from the FFT path), so power relative to the peak of
// the row is twice the difference.
const dBcFromPeak = (row, peak) => row.map((db) => 2 * (db - peak));

// Worst |sum of |H(f - k/M)|^2 over all M channels, minus 1| over a sweep of one
// channel spacing -- everything repeats after that. Evaluating the response on
// one dense grid across the whole band and indexing into it keeps this cheap:
// f - k/M is another point of the same grid, wrapped, because the response is
// periodic in frequency with period 1.
function worstComplementarityError(proto, numChannels, stepsPerChannel = 128) {
  const gridSize = numChannels * stepsPerChannel;
  const power = new Float64Array(gridSize);
  for (let g = 0; g < gridSize; g++) {
    const { re, im } = prototypeResponse(proto, g / gridSize);
    power[g] = re * re + im * im;
  }
  let worst = 0;
  let at = 0;
  for (let i = 0; i < stepsPerChannel; i++) {
    let sum = 0;
    for (let k = 0; k < numChannels; k++) {
      sum += power[(i - k * stepsPerChannel + gridSize) % gridSize];
    }
    if (Math.abs(sum - 1) > worst) {
      worst = Math.abs(sum - 1);
      at = i / stepsPerChannel;
    }
  }
  return { worst, at, rippleDb: 10 * Math.log10(1 + worst) };
}

// Sweep a tone across one channel spacing and report, for each method, how it
// behaves: the worst loss at the peak channel (scalloping), how flat the row's
// total power stays, how far down the channels more than one away from the peak
// are, and how many channels the tone is visible in at all.
// `row` has to be far enough down that the prototype's whole window is inside
// the buffer, which depends on the hop: at an oversampling of 4 the rows are a
// quarter of a block apart, so row 12 is only three blocks in and the window
// hangs off the front.
function sweepTone(rowsOfMethod, numChannels, row = 12, steps = 200) {
  const NUM_ROWS = 24;
  const ROW = row;
  let worstPeakLossDb = 0;
  let worstTotalPowerDb = 0;
  let worstOutsideDbc = -Infinity;
  let mostChannelsWithin40Dbc = 0;

  for (let s = 0; s < steps; s++) {
    const freq = (numChannels / 4 + s / steps) / numChannels;
    const row = rowOf(rowsOfMethod(tone(NUM_ROWS * numChannels, freq), NUM_ROWS), numChannels, ROW);

    const peak = Math.max(...row);
    worstPeakLossDb = Math.max(worstPeakLossDb, -2 * peak); // unit tone, so 0 dB is no loss
    const totalPower = row.reduce((sum, db) => sum + Math.pow(10, db / 5), 0);
    worstTotalPowerDb = Math.max(worstTotalPowerDb, Math.abs(10 * Math.log10(totalPower)));

    const relative = dBcFromPeak(row, peak);
    const peakChannel = row.indexOf(peak);
    mostChannelsWithin40Dbc = Math.max(mostChannelsWithin40Dbc, relative.filter((dbc) => dbc > -40).length);
    for (let k = 0; k < numChannels; k++) {
      const distance = Math.min(Math.abs(k - peakChannel), numChannels - Math.abs(k - peakChannel));
      if (distance <= 1) continue;
      worstOutsideDbc = Math.max(worstOutsideDbc, relative[k]);
    }
  }
  return { worstPeakLossDb, worstTotalPowerDb, worstOutsideDbc, mostChannelsWithin40Dbc };
}

// === the prototype filter =================================================

assert.equal(prototype.taps.length, M * P, 'the prototype is one filter of M*P taps, folded into M branches');
assert.equal(prototype.numChannels, M);
assert.equal(prototype.tapsPerChannel, P);
assert.equal(prototype.rolloff, CHANNELIZER_ROLLOFF);

// Unit DC gain, so a tone at a channel centre comes out of the bank at its own
// amplitude -- the same absolute scale calcFfts produces after its divide by
// fftSize, which is what lets the magnitude sliders mean the same thing under
// either method. The end-to-end check of that is further down.
const dcGain = prototype.taps.reduce((sum, tap) => sum + tap, 0);
assert.ok(Math.abs(dcGain - 1) < 1e-12, `prototype DC gain must be 1, got ${dcGain}`);

// Linear phase. The frequency-sampled design is delayed by exactly half its
// length, so it is symmetric as h[n] == h[L-n]; h[0] is the one tap with no
// partner and holds the far tail of the response.
{
  const L = prototype.taps.length;
  let worst = 0;
  for (let n = 1; n < L; n++) worst = Math.max(worst, Math.abs(prototype.taps[n] - prototype.taps[L - n]));
  assert.ok(worst < 1e-12, `prototype must be symmetric about its midpoint, worst asymmetry ${worst}`);
  assert.equal(
    prototype.taps.indexOf(Math.max(...prototype.taps)),
    L / 2,
    'the impulse response must peak at the midpoint, not at the wrap-around'
  );
  assert.ok(
    Math.abs(prototype.taps[0]) < Math.max(...prototype.taps) / 50,
    'the unpaired tap is the far tail of the response and must be small'
  );
}

// The channel count is the size of the DFT the fold feeds, which is radix-4, so
// it has to be a power of two. Taps per channel only sets the filter length --
// the design sums over the nonzero frequency bins rather than transforming, so
// nothing constrains it beyond being a whole number.
assert.throws(() => designNprPrototype(48, 8), /power of two/, 'non-power-of-two channel count');
assert.throws(() => designNprPrototype(1, 8), /power of two/, 'one channel is not a filter bank');
assert.throws(() => designNprPrototype(64, 1), /at least 2/, 'one tap per channel is just an FFT');
assert.throws(() => designNprPrototype(64, 7.5), /whole number/, 'fractional taps per channel');
assert.throws(() => designNprPrototype(64, 8, 0), /rolloff/, 'zero rolloff');
assert.throws(() => designNprPrototype(64, 8, 1.5), /rolloff/, 'rolloff wider than a channel');

// Every length the settings pane offers has to design, and the properties have
// to hold across all of them -- 6 and 10 are not powers of two, which the
// frequency-sampled design has no opinion about.
for (const taps of CHANNELIZER_TAPS_CHOICES) {
  const candidate = designNprPrototype(M, taps);
  const gain = candidate.taps.reduce((sum, tap) => sum + tap, 0);
  assert.equal(candidate.taps.length, M * taps, `${taps} taps per channel gives an M*P filter`);
  assert.ok(Math.abs(gain - 1) < 1e-12, `${taps} taps per channel must still be unit gain, got ${gain}`);
  let asymmetry = 0;
  for (let n = 1; n < candidate.taps.length; n++) {
    asymmetry = Math.max(asymmetry, Math.abs(candidate.taps[n] - candidate.taps[candidate.taps.length - n]));
  }
  assert.ok(asymmetry < 1e-12, `${taps} taps per channel must stay symmetric, got ${asymmetry}`);
  assert.ok(
    worstComplementarityError(candidate, M).rippleDb < 0.06,
    `${taps} taps per channel must still be near-perfect`
  );
}

// Designing costs an M*P point transform, and the spectrogram redraws on every
// scroll, so the same settings must hand back the same filter.
assert.equal(getNprPrototype(M, P), getNprPrototype(M, P), 'prototypes must be cached per size');
assert.notEqual(getNprPrototype(M, P), getNprPrototype(M * 2, P), 'a different size is a different prototype');

// === NPR property 1: power complementarity ================================

// Exact at the M*P design frequencies -- that is what frequency sampling buys,
// and it is the reason the residual ripple is as small as it is.
{
  let worst = 0;
  for (let g = 0; g < P; g++) {
    const freq = g / (M * P);
    let sum = 0;
    for (let k = 0; k < M; k++) {
      const { re, im } = prototypeResponse(prototype, freq - k / M);
      sum += re * re + im * im;
    }
    worst = Math.max(worst, Math.abs(sum - 1));
  }
  assert.ok(worst < 1e-9, `complementarity must be exact on the design grid, worst error ${worst}`);
}

// Everywhere else, near-perfect: a ripple far below anything a colormap can
// render. At P = 8 it measures 0.0147 dB.
const nprComplementarity = worstComplementarityError(prototype, M);
assert.ok(
  nprComplementarity.rippleDb < 0.02,
  `NPR complementarity ripple must stay under 0.02 dB, got ${nprComplementarity.rippleDb.toFixed(5)} dB`
);

// More taps per channel is a finer design grid, so the ripple has to shrink.
{
  const coarse = worstComplementarityError(designNprPrototype(M, 4), M);
  const fine = worstComplementarityError(designNprPrototype(M, 16), M);
  assert.ok(
    fine.rippleDb < nprComplementarity.rippleDb && nprComplementarity.rippleDb < coarse.rippleDb,
    `ripple must fall as taps per channel rises, got ${coarse.rippleDb} / ${nprComplementarity.rippleDb} / ${fine.rippleDb}`
  );
}

// Control: an ordinary Hann-windowed sinc cut off at half a channel spacing --
// the obvious way to build a channel filter, and a perfectly good lowpass -- is
// not power complementary, because nothing constrains its skirts to fill in for
// each other. Two of its channels overlapping at their -6 dB crossover leave a
// hole, and the sweep finds it.
{
  const L = M * P;
  const taps = new Float64Array(L);
  let gain = 0;
  for (let n = 0; n < L; n++) {
    const t = (n - L / 2) / M;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    taps[n] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / L));
    gain += taps[n];
  }
  for (let n = 0; n < L; n++) taps[n] /= gain;
  const control = worstComplementarityError({ taps }, M);
  assert.ok(
    control.rippleDb > 1,
    `the windowed-sinc control must fail complementarity, got only ${control.rippleDb.toFixed(4)} dB of ripple`
  );
  assert.ok(
    Math.abs(control.at - 0.5) < 0.02,
    `the control's worst point must be the channel crossover, got ${control.at}`
  );
}

// Control the other way: the FFT is the one-tap-per-channel rectangular bank,
// and it satisfies complementarity exactly (Parseval). So passing the test above
// is a statement about the prototype's skirts lining up, not about the
// channelizer being better at everything -- the difference is localization,
// which is the next section.
{
  const rectangular = { taps: new Float64Array(M).fill(1 / M) };
  const fftBank = worstComplementarityError(rectangular, M);
  assert.ok(
    fftBank.rippleDb < 1e-9,
    `the FFT's own bank is exactly complementary too, got ${fftBank.rippleDb} dB of ripple`
  );
}

// === NPR property 2: channel localization =================================

// Beyond one channel spacing the prototype is into its stopband. That is what
// confines a tone to its own channel and one neighbour, and the FFT's -13 dB
// first sidelobe is what it is being measured against.
{
  const stopbandPeak = (proto, fromChannels) => {
    let peak = 0;
    for (let i = 0; i <= 4000; i++) {
      const freq = (fromChannels + (i / 4000) * (M / 2 - fromChannels)) / M;
      const { re, im } = prototypeResponse(proto, freq);
      peak = Math.max(peak, Math.sqrt(re * re + im * im));
    }
    return 20 * Math.log10(peak);
  };
  const npr = stopbandPeak(prototype, 1);
  const rectangular = stopbandPeak({ taps: new Float64Array(M).fill(1 / M) }, 1);
  assert.ok(npr < -30, `the prototype must be down at least 30 dB past one channel, got ${npr.toFixed(2)} dB`);
  assert.ok(rectangular > -15, `the FFT's rectangular bank should not be, got ${rectangular.toFixed(2)} dB`);
  assert.ok(
    stopbandPeak(prototype, 2) < -50,
    `two channels out the prototype must be down 50 dB, got ${stopbandPeak(prototype, 2).toFixed(2)} dB`
  );
}

// === both properties, end to end ==========================================

const nprSweep = sweepTone((samples, rows) => calcChannelizerFfts(samples, M, rows), M);
const fftSweep = sweepTone((samples, rows) => calcFfts(samples, M, 'rectangle', rows), M);

// Complementarity, observed rather than derived: whatever the tone's frequency,
// the row accounts for all of its power. Same figure as the ripple above.
assert.ok(
  nprSweep.worstTotalPowerDb < 0.02,
  `a tone must read the same total power at any frequency, worst deviation ${nprSweep.worstTotalPowerDb} dB`
);

// Scalloping: a tone between two channels splits between them, and because the
// two are power complementary it splits at exactly -3.01 dB rather than falling
// into a hole. The FFT's rectangular window costs 3.92 dB at the same point.
assert.ok(
  nprSweep.worstPeakLossDb > 3.0 && nprSweep.worstPeakLossDb < 3.05,
  `worst-case peak loss must be the complementary 3.01 dB, got ${nprSweep.worstPeakLossDb.toFixed(3)} dB`
);
assert.ok(
  fftSweep.worstPeakLossDb > 3.5,
  `the FFT is expected to scallop harder than that, got ${fftSweep.worstPeakLossDb.toFixed(3)} dB`
);

// Localization, observed: the tone stays in its own channel and its neighbour.
assert.ok(
  nprSweep.worstOutsideDbc < -40,
  `nothing more than one channel from the tone may be above -40 dBc, got ${nprSweep.worstOutsideDbc.toFixed(2)}`
);
assert.ok(
  fftSweep.worstOutsideDbc > -15,
  `the FFT is expected to leak far worse than that, got ${fftSweep.worstOutsideDbc.toFixed(2)} dBc`
);
assert.ok(
  nprSweep.mostChannelsWithin40Dbc <= 4,
  `a tone must be visible in a handful of channels, not the row, got ${nprSweep.mostChannelsWithin40Dbc}`
);
assert.ok(
  fftSweep.mostChannelsWithin40Dbc > M / 2,
  `the FFT is expected to smear across the row, got ${fftSweep.mostChannelsWithin40Dbc}`
);

// The properties are stated per channel spacing, so they must not depend on the
// channel count.
{
  const large = worstComplementarityError(designNprPrototype(256, P), 256);
  assert.ok(
    Math.abs(large.rippleDb - nprComplementarity.rippleDb) < 1e-3,
    `ripple depends on taps per channel, not channel count: ${large.rippleDb} vs ${nprComplementarity.rippleDb}`
  );
}

// === the polyphase implementation =========================================

// Folding the windowed input to M points and taking one M-point DFT has to give
// the same answer as running all M channel filters separately, which is the
// whole reason the structure is worth having. Brute force says channel k is
// sum over m of x[m] h[m] exp(-j*2*pi*k*m/M).
{
  const length = M * P;
  const samples = new Float32Array((length + 200) * 2);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 1.7) * 0.5 + Math.cos(i * 0.31);
  const start = 37;
  const got = channelizeFrame(prototype, samples, start);

  let worst = 0;
  for (let k = 0; k < M; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < length; n++) {
      const sampleRe = samples[(start + n) * 2];
      const sampleIm = samples[(start + n) * 2 + 1];
      const phase = (-2 * Math.PI * k * n) / M;
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      re += prototype.taps[n] * (sampleRe * cos - sampleIm * sin);
      im += prototype.taps[n] * (sampleRe * sin + sampleIm * cos);
    }
    // The row is DC-centred, so channel k is stored half a row over.
    worst = Math.max(worst, Math.abs(Math.sqrt(re * re + im * im) - got[(k + M / 2) % M]));
  }
  assert.ok(worst < 1e-6, `the polyphase fold must match the direct filter bank, worst error ${worst}`);
}

// === drop-in behaviour alongside calcFfts =================================

const NUM_ROWS = 24;

// Same output shape, and the same absolute level: a tone sitting on a channel
// centre reads its own amplitude under either method, so switching the toggle
// does not move the magnitude sliders.
{
  const samples = tone(NUM_ROWS * M, 10 / M);
  const channelized = calcChannelizerFfts(samples, M, NUM_ROWS);
  const transformed = calcFfts(samples, M, 'rectangle', NUM_ROWS);
  assert.equal(channelized.length, NUM_ROWS * M, 'one row of M magnitudes per spectrogram line');
  assert.equal(channelized.length, transformed.length);

  const channelizedPeak = Math.max(...rowOf(channelized, M, 12));
  const transformedPeak = Math.max(...rowOf(transformed, M, 12));
  assert.ok(
    Math.abs(channelizedPeak - transformedPeak) < 1e-3,
    `an on-centre tone must read the same level either way, got ${channelizedPeak} vs ${transformedPeak}`
  );
  // Both put DC in the middle of the row.
  assert.equal(rowOf(channelized, M, 12).indexOf(channelizedPeak), M / 2 + 10, 'bin +10 sits right of centre');
}

// A row reaches into its neighbours -- that is where the channel shaping comes
// from -- but it is still centred on the samples the FFT path would have used,
// so an event lands on the same row under either method.
{
  // A quiet floor everywhere, so a row with nothing in it has a magnitude to
  // report (-90 dB) instead of the 0 the log guard leaves for an all-zero row.
  const samples = tone(NUM_ROWS * M, 10 / M);
  for (let i = 0; i < samples.length; i++) samples[i] *= 1e-9;
  samples.set(tone(M, 10 / M), 10 * M * 2);

  const rowPeak = (rows) => Array.from({ length: NUM_ROWS }, (_, r) => Math.max(...rowOf(rows, M, r)));
  const channelized = rowPeak(calcChannelizerFfts(samples, M, NUM_ROWS));
  const transformed = rowPeak(calcFfts(samples, M, 'rectangle', NUM_ROWS));

  assert.equal(transformed.indexOf(Math.max(...transformed)), 10, 'the FFT puts the burst on its own row');
  assert.equal(channelized.indexOf(Math.max(...channelized)), 10, 'so must the channelizer');
  // It spreads over the prototype's length, symmetrically, and no further.
  for (const row of [10 - P / 2 - 1, 10 + P / 2 + 1]) {
    assert.ok(channelized[row] < -60, `row ${row} is outside the prototype and must be dark`);
  }
  assert.ok(
    Math.abs(channelized[10 - 2] - channelized[10 + 2]) < 0.5,
    'the spread must be symmetric about the burst, not lagging it'
  );
}

// === oversampling =========================================================

// The oversampling factor is M/D, the channel count over the decimation, and it
// sets the hop and nothing else: 1 advances a whole channel count per frame,
// which is critical sampling and shares no input between consecutive frames, 2
// advances half of it (the 50%-overlap bank), 4 a quarter.
assert.equal(channelizerHop(M, 1), M, 'critically sampled is a full channel count per frame');
assert.equal(channelizerHop(M, 2), M / 2, '2x oversampled is 50% overlap');
assert.equal(channelizerHop(M, 4), M / 4, '4x oversampled is 75% overlap');
assert.equal(channelizerHop(M), M, 'the default is critical sampling');
assert.throws(() => channelizerHop(M, 3), /divide/, 'a hop has to be a whole number of samples');
assert.throws(() => channelizerHop(M, 0), /at least 1/, 'no oversampling below critical');
assert.throws(() => channelizerHop(M, 1.5), /whole number/, 'fractional oversampling');
for (const oversampling of CHANNELIZER_OVERSAMPLING_CHOICES) {
  assert.equal(M % oversampling, 0, `${oversampling}x must divide every offered channel count`);
}

// The display's row grid is not the bank's: a row is still one block of M
// samples whatever the oversampling, so the output stays the same size and the
// time axis, cursors and annotations never have to know. The extra frames are
// averaged into the row they belong to.
{
  const samples = tone(NUM_ROWS * M, 10 / M);
  for (const oversampling of CHANNELIZER_OVERSAMPLING_CHOICES) {
    const rows = calcChannelizerFfts(samples, M, NUM_ROWS, { oversampling });
    assert.equal(rows.length, NUM_ROWS * M, `${oversampling}x must still be one row per block`);
  }
}

// So an event stays on its own row, at every factor -- the frames are placed
// symmetrically about the block, not run on from it.
{
  const samples = tone(NUM_ROWS * M, 10 / M);
  for (let i = 0; i < samples.length; i++) samples[i] *= 1e-9;
  samples.set(tone(M, 10 / M), 10 * M * 2);

  for (const oversampling of CHANNELIZER_OVERSAMPLING_CHOICES) {
    const rows = calcChannelizerFfts(samples, M, NUM_ROWS, { oversampling });
    const peaks = Array.from({ length: NUM_ROWS }, (_, r) => Math.max(...rowOf(rows, M, r)));
    assert.equal(
      peaks.indexOf(Math.max(...peaks)),
      10,
      `at ${oversampling}x the burst in block 10 must stay on row 10`
    );
    // And symmetrically, rather than leaning towards the later frames.
    assert.ok(
      Math.abs(peaks[8] - peaks[12]) < 0.5,
      `at ${oversampling}x the spread must stay centred, got ${peaks[8]} vs ${peaks[12]}`
    );
  }
}

// A steady tone reads the same level however many frames are averaged: they are
// all the same, so the RMS of them is that.
{
  const samples = tone(NUM_ROWS * M, 10 / M);
  const levels = CHANNELIZER_OVERSAMPLING_CHOICES.map((oversampling) =>
    Math.max(...rowOf(calcChannelizerFfts(samples, M, NUM_ROWS, { oversampling }), M, 12))
  );
  for (const level of levels) {
    assert.ok(Math.abs(level - levels[0]) < 1e-3, `oversampling must not shift the level, got ${levels}`);
  }
}

// Oversampling must not touch the prototype either, so every NPR figure is
// unchanged -- what it buys is frames in between, not a different filter.
for (const oversampling of CHANNELIZER_OVERSAMPLING_CHOICES) {
  // The window has to clear the front of the buffer, and the extra frames reach
  // half a hop further back than the row itself does.
  const interiorRow = P + 1;
  const sweep = sweepTone(
    (samples, rows) => calcChannelizerFfts(samples, M, rows, { oversampling }),
    M,
    interiorRow
  );
  assert.ok(sweep.worstTotalPowerDb < 0.02, `${oversampling}x must stay power complementary`);
  assert.ok(
    sweep.worstPeakLossDb > 3.0 && sweep.worstPeakLossDb < 3.05,
    `${oversampling}x must keep the 3.01 dB crossover, got ${sweep.worstPeakLossDb.toFixed(3)} dB`
  );
  assert.ok(sweep.worstOutsideDbc < -40, `${oversampling}x must keep its channels isolated`);
  assert.ok(sweep.mostChannelsWithin40Dbc <= 4, `${oversampling}x must keep a tone confined`);
}

// What the averaging is actually for: the frames are near enough independent
// looks at a noise floor, so averaging their power settles it. Welch says the
// spread of the estimate falls as 1/sqrt(oversampling); this asks for most of
// that, since consecutive frames do overlap and are not fully independent.
{
  let seed = 12345;
  const random = () => {
    // xorshift, so the noise is the same on every run
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296 - 0.5;
  };
  const noise = new Float32Array(NUM_ROWS * M * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = random();

  const spread = (oversampling) => {
    const rows = calcChannelizerFfts(noise, M, NUM_ROWS, { oversampling });
    // Interior rows only, so the ends of the buffer do not count as variance.
    const values = [];
    for (let row = P; row < NUM_ROWS - P; row++) values.push(...rowOf(rows, M, row));
    const mean = values.reduce((sum, db) => sum + db, 0) / values.length;
    return Math.sqrt(values.reduce((sum, db) => sum + (db - mean) ** 2, 0) / values.length);
  };

  const critical = spread(1);
  for (const oversampling of CHANNELIZER_OVERSAMPLING_CHOICES.filter((x) => x > 1)) {
    const settled = spread(oversampling);
    assert.ok(
      settled < critical * (1 / Math.sqrt(oversampling)) ** 0.5,
      `${oversampling}x must settle the noise floor, got ${settled.toFixed(3)} dB against ${critical.toFixed(3)} dB`
    );
  }
}

// The loader marks a row it has not fetched yet with -Infinity and calcFfts
// turns that into a row of zeros, which fftToRGB paints grey. The channelizer
// has to do the same rather than filling the gap in from the rows around it --
// and must not let the -Infinity escape into them either.
{
  const samples = tone(NUM_ROWS * M, 10 / M);
  samples.fill(-Infinity, 5 * M * 2, 6 * M * 2);
  const channelized = calcChannelizerFfts(samples, M, NUM_ROWS);

  assert.ok(channelized.every(Number.isFinite), 'no non-finite value may reach the image');
  assert.ok(
    rowOf(channelized, M, 5).every((db) => db === 0),
    'an unfetched row must come out as zeros, the same as calcFfts leaves it'
  );
  // Its neighbours lost part of their window to the gap; the level correction is
  // what keeps them from showing up as a dark band around it.
  for (const row of [4, 6]) {
    assert.ok(
      Math.abs(Math.max(...rowOf(channelized, M, row)) - 0) < 0.05,
      `row ${row} borders the gap and must still read full scale, got ${Math.max(...rowOf(channelized, M, row))}`
    );
  }
}

// Same correction at the ends of the buffer, where half the window is off the
// edge. Without it the top and bottom of every screenful would be dark.
{
  const samples = tone(NUM_ROWS * M, 10 / M);
  const channelized = calcChannelizerFfts(samples, M, NUM_ROWS);
  for (const row of [0, 1, NUM_ROWS - 2, NUM_ROWS - 1]) {
    const peak = Math.max(...rowOf(channelized, M, row));
    assert.ok(Math.abs(peak) < 0.2, `edge row ${row} must not be dimmed, got ${peak} dB`);
  }
}

console.log('channelizer.test.mjs: OK');
console.log(
  `  complementarity ripple ${nprComplementarity.rippleDb.toFixed(5)} dB, ` +
    `scalloping ${nprSweep.worstPeakLossDb.toFixed(2)} dB (FFT ${fftSweep.worstPeakLossDb.toFixed(2)} dB), ` +
    `leakage past one channel ${nprSweep.worstOutsideDbc.toFixed(1)} dBc (FFT ${fftSweep.worstOutsideDbc.toFixed(1)} dBc)`
);
