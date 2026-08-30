// Real-valued recordings (SigMF's r* datatypes) in the recording viewer.
//
// Everything past the reader works on interleaved I/Q, so real support is two
// facts: a real sample is half the bytes of the complex one of the same width,
// and it is widened to I/Q with Q = 0 on the way in. That widening is what makes
// the spectrogram and frequency plot right for free -- the FFT of a signal with
// no imaginary part is Hermitian-symmetric, so the negative half mirrors the
// positive one, which is what a real recording should look like.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The viewer's sources address each other as '@/...' (see vite.config.ts), so
// the bundle needs the same alias.
const out = join(tmpdir(), `real-recordings-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('./_recording-entry.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  alias: { '@': resolve(new URL('../src/recording', import.meta.url).pathname) },
});
const {
  calcFfts,
  convertToFloat32,
  dataTypeIsComplex,
  dataTypeToBytesPerIQSample,
  float32IqBytes,
  sampleSelection,
  SigMFMetadata,
  trimmedSigmfMetadata,
  windowCoefficient,
} =
  await import(pathToFileURL(out));

// --- datatype shape -------------------------------------------------------

for (const [dataType, complex] of [
  ['cf32_le', true], ['ci16_le', true], ['ci8', true], ['cu8', true], ['cf64', true],
  ['rf32_le', false], ['ri16_le', false], ['ri8', false], ['ru8', false], ['rf64_le', false],
  // Loose spellings the reader has always accepted, still treated as complex.
  ['i8', true], ['u8', true],
]) {
  assert.equal(dataTypeIsComplex(dataType), complex, `${dataType} complex-ness`);
}

for (const [dataType, bytes] of [
  ['cf32_le', 8], ['rf32_le', 4],
  ['cf64_le', 16], ['rf64_le', 8],
  ['ci32_le', 8], ['ri32_le', 4],
  ['ci16_le', 4], ['ri16_le', 2],
  ['cu16_le', 4], ['ru16_le', 2],
  ['ci8', 2], ['ri8', 1],
  ['cu8', 2], ['ru8', 1],
]) {
  assert.equal(dataTypeToBytesPerIQSample(dataType), bytes,
    `${dataType} must be ${bytes} bytes per sample`);
}

// --- reading real samples -------------------------------------------------

const int16Buffer = (values) => Int16Array.from(values).buffer;

assert.deepEqual(
  Array.from(convertToFloat32(int16Buffer([32767, -32767, 0]), 'ri16_le')),
  [1, 0, -1, 0, 0, 0],
  'a real recording must be widened to interleaved I/Q with Q = 0');
assert.deepEqual(
  Array.from(convertToFloat32(int16Buffer([32767, -32767]), 'ci16_le')),
  [1, -1],
  'a complex recording must keep its interleaved layout unchanged');

assert.deepEqual(
  Array.from(convertToFloat32(Int8Array.from([127, -127]).buffer, 'ri8')),
  [1, 0, -1, 0],
  'ri8 must normalize against full scale and zero-fill Q');
assert.deepEqual(
  Array.from(convertToFloat32(Uint8Array.from([254, 127, 0]).buffer, 'ru8')),
  [1, 0, 0, 0, -1, 0],
  'ru8 must be re-centered on its midpoint and zero-fill Q');
assert.deepEqual(
  Array.from(convertToFloat32(Float32Array.from([0.5, -0.25]).buffer, 'rf32_le')),
  [0.5, 0, -0.25, 0],
  'rf32 samples must pass through unscaled, one per I/Q pair');
assert.deepEqual(
  Array.from(convertToFloat32(Float32Array.from([0.5, -0.25]).buffer, 'cf32_le')),
  [0.5, -0.25],
  'cf32 must remain the zero-copy fast path it has always been');

const bigEndianInt16 = new ArrayBuffer(4);
const bigEndianInt16View = new DataView(bigEndianInt16);
bigEndianInt16View.setInt16(0, 32767, false);
bigEndianInt16View.setInt16(2, -32767, false);
assert.deepEqual(
  Array.from(convertToFloat32(bigEndianInt16, 'ci16_be')),
  [1, -1],
  'big-endian integer components must not be read in host byte order');
const bigEndianFloat32 = new ArrayBuffer(8);
const bigEndianFloat32View = new DataView(bigEndianFloat32);
bigEndianFloat32View.setFloat32(0, 0.5, false);
bigEndianFloat32View.setFloat32(4, -0.25, false);
assert.deepEqual(
  Array.from(convertToFloat32(bigEndianFloat32, 'cf32_be')),
  [0.5, -0.25],
  'big-endian float components must be decoded explicitly');

// A real read is half as many bytes for the same sample count, and produces the
// same number of floats as the complex recording of the same width would.
const realSamples = convertToFloat32(int16Buffer([1, 2, 3, 4]), 'ri16_le');
assert.equal(realSamples.length / 2, 4, 'four ri16 samples must be four I/Q pairs');

// --- exact, self-describing selected-sample exports -----------------------

assert.deepEqual(sampleSelection(3.25, 5.1, 20), { start: 3, end: 6, count: 3 });
assert.deepEqual(sampleSelection(-5, 50, 20), { start: 0, end: 20, count: 20 });
const exportedBytes = float32IqBytes(Float32Array.from([0.5, -0.25]));
assert.equal(exportedBytes.byteLength, 8);
assert.equal(new DataView(exportedBytes.buffer).getFloat32(0, true), 0.5);
assert.equal(new DataView(exportedBytes.buffer).getFloat32(4, true), -0.25);

const exportMeta = Object.assign(new SigMFMetadata(), {
  global: {
    'core:datatype': 'ci16_le',
    'core:version': '1.2.0',
    'core:sample_rate': 1e6,
    'core:sha512': 'stale',
    'traceability:sample_length': 100,
    'traceability:origin': { type: 'url', account: '', container: '', file_path: 'old' },
  },
  captures: [
    { 'core:sample_start': 0, 'core:frequency': 100e6 },
    { 'core:sample_start': 40, 'core:frequency': 101e6 },
    { 'core:sample_start': 80, 'core:frequency': 102e6 },
  ],
  annotations: [
    { 'core:sample_start': 25, 'core:sample_count': 20, 'core:label': 'overlap start' },
    { 'core:sample_start': 50, 'core:label': 'point' },
    { 'core:sample_start': 65, 'core:sample_count': 20, 'core:label': 'overlap end' },
  ],
});
const trimmed = trimmedSigmfMetadata(exportMeta, sampleSelection(30, 70, 100));
assert.equal(trimmed.global['core:datatype'], 'cf32_le');
assert.equal(trimmed.global['traceability:sample_length'], 40);
assert.equal(trimmed.global['core:sha512'], undefined);
assert.equal(trimmed.global['traceability:origin'], undefined);
assert.deepEqual(trimmed.captures.map(capture => capture['core:sample_start']), [0, 10]);
assert.deepEqual(trimmed.annotations.map(annotation => [
  annotation['core:sample_start'], annotation['core:sample_count'], annotation['core:label'],
]), [
  [0, 15, 'overlap start'],
  [20, undefined, 'point'],
  [35, 5, 'overlap end'],
]);

const noCaptures = Object.assign(new SigMFMetadata(), {
  global: { 'core:datatype': 'cf32_le', 'core:version': '1.2.0' },
  captures: [],
  annotations: [],
});
assert.equal(noCaptures.getCapture(10), undefined,
  'an empty captures array is valid and must not be dereferenced');
assert.equal(noCaptures.getCenterFrequency(), 0);

// --- the mirrored spectrum ------------------------------------------------

const FFT_SIZE = 64;
// A non-integer bin so leakage puts energy in every bin: no exactly-zero
// magnitude, which calcFfts would otherwise report as 0 dB rather than -inf.
const TONE_BIN = 8.5;
const MIRROR = 8;

// calcFfts fftshifts each row, so DC lands at FFT_SIZE / 2 and bin +m at
// FFT_SIZE / 2 + m.
const bin = (row, m) => row[FFT_SIZE / 2 + m];

const real = new Int16Array(FFT_SIZE);
const complex = new Int16Array(FFT_SIZE * 2);
for (let i = 0; i < FFT_SIZE; i++) {
  const phase = (2 * Math.PI * TONE_BIN * i) / FFT_SIZE;
  real[i] = Math.round(Math.cos(phase) * 32767);
  complex[i * 2] = Math.round(Math.cos(phase) * 32767);
  complex[i * 2 + 1] = Math.round(Math.sin(phase) * 32767);
}

const realRow = calcFfts(convertToFloat32(real.buffer, 'ri16_le'), FFT_SIZE, 'rectangle', 1);
const complexRow = calcFfts(convertToFloat32(complex.buffer, 'ci16_le'), FFT_SIZE, 'rectangle', 1);
assert.equal(realRow.length, FFT_SIZE, 'a real recording must still produce one full FFT row');

for (let m = 1; m < FFT_SIZE / 2; m++) {
  assert.ok(Math.abs(bin(realRow, m) - bin(realRow, -m)) < 1e-3,
    `real spectrum must mirror about DC (bin ${m}: ${bin(realRow, m)} vs ${bin(realRow, -m)})`);
}

// The same tone recorded complex is one-sided, which is what makes the mirror
// above a property of the signal rather than of the FFT code. calcFfts reports
// 10*log10 of a magnitude, so this 12 is ~24 dB in power terms; the rest of the
// gap is rectangular-window leakage from the half-bin offset.
assert.ok(bin(complexRow, MIRROR) - bin(complexRow, -MIRROR) > 12,
  'a complex tone must stay on one side of DC');
assert.ok(Math.max(...Array.from(complexRow.slice(0, FFT_SIZE / 2))) < bin(complexRow, MIRROR) - 12,
  'a complex tone must leave the whole negative half well below its peak');

// --- windowing ------------------------------------------------------------

// The settings pane's dropdown values are the strings windowCoefficient()
// switches on, and a name that misses simply falls through to a flat window --
// silently, since nothing else in the chain can tell "no window" from "a window
// that happens to be 1". This asserts the two lists still agree.
const settingsPane = await readFile(
  new URL('../src/recording/pages/recording-view/components/settings-pane.tsx', import.meta.url), 'utf8');
const offered = /const windowFunctions = \[([^\]]*)\]/.exec(settingsPane)?.[1]
  ?.split(',').map(name => name.trim().replace(/^'|'$/g, '')).filter(Boolean);
assert.ok(offered?.length, 'settings pane must declare its window functions as a literal list');
assert.ok(offered.includes('rectangle'), 'rectangle must stay on offer as the no-window choice');
for (const name of offered) {
  const taper = Array.from({ length: 32 }, (_, n) => windowCoefficient(name, n, 32));
  if (name === 'rectangle') {
    assert.ok(taper.every(w => w === 1), 'rectangle must be a flat window');
  } else {
    assert.ok(taper.some(w => Math.abs(w - 1) > 1e-6),
      `"${name}" is offered in the settings pane but no window by that name is applied`);
    assert.ok(taper.every(w => w >= -1e-9 && w <= 1 + 1e-9),
      `"${name}" must be a taper in [0, 1] (got ${Math.min(...taper)}..${Math.max(...taper)})`);
  }
}
assert.ok(Math.abs(windowCoefficient('bartlett', 16, 33) - 1) < 1e-9,
  'bartlett must peak at 1 in the middle of the frame');

// A window scales a complex *sample*, not an array position: I and Q share one
// coefficient and the taper spans the whole frame. Indexing the interleaved
// array directly tapers the first half of the samples only, and splits each of
// those across two neighbouring coefficients -- which leaves the frame with the
// hard edge a window exists to remove. The half-bin tone above is the test for
// it: windowing has to buy real sidelobe suppression over no window at all,
// and the mis-indexed version buys almost none (~11 dB against rectangular's
// 10 dB, where a correctly applied window is ~20 dB and up).
const farSidelobe = (row) => {
  let worst = -Infinity;
  for (let m = -FFT_SIZE / 2; m < FFT_SIZE / 2; m++) {
    if (Math.abs(m - MIRROR) >= 6) worst = Math.max(worst, bin(row, m));
  }
  return worst;
};
const iq = convertToFloat32(complex.buffer, 'ci16_le');
const flat = calcFfts(iq, FFT_SIZE, 'rectangle', 1);
const flatMargin = bin(flat, MIRROR) - farSidelobe(flat);
for (const name of offered.filter(name => name !== 'rectangle')) {
  const row = calcFfts(iq, FFT_SIZE, name, 1);
  const margin = bin(row, MIRROR) - farSidelobe(row);
  assert.ok(margin > 16,
    `"${name}" must suppress far sidelobes (${margin.toFixed(1)} dB vs ${flatMargin.toFixed(1)} unwindowed)`);
}

console.log('checked real-valued recording datatypes, sample widening, the mirrored spectrum and windowing');
