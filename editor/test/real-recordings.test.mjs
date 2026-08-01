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
const { calcFfts, convertToFloat32, dataTypeIsComplex, dataTypeToBytesPerIQSample } = await import(
  pathToFileURL(out)
);

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

// A real read is half as many bytes for the same sample count, and produces the
// same number of floats as the complex recording of the same width would.
const realSamples = convertToFloat32(int16Buffer([1, 2, 3, 4]), 'ri16_le');
assert.equal(realSamples.length / 2, 4, 'four ri16 samples must be four I/Q pairs');

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

console.log('checked real-valued recording datatypes, sample widening and the mirrored spectrum');
