// The SDRplay worker's register arithmetic and frame unpacking, on plain Node.
//
// The MSi2500/MSi001 protocol in runner/src/sdrplay_worker.js is a port of
// libmirisdr-5 (see docs/sdrplay.md). Each row of REFERENCE is the exact
// sequence of register writes libmirisdr-5's own C code emits for that
// configuration -- captured by compiling its hard.c/soft.c/gain.c natively with
// a printing stub for the USB write, across 2340 combinations, of which these
// are the representative subset (every band edge, every packing format, every
// gain regime, a bias-tee word and three IF bandwidths). If a change here
// moves one of these words, the device would tune differently from the driver
// people actually run on these radios.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'sdrplay_worker.js'), 'utf8');

// Everything above the first worker-only global is pure arithmetic.
const cut = source.indexOf('\nconst encoder = new TextEncoder();');
assert.ok(cut > 0, 'sdrplay_worker.js no longer has the expected pure prefix');
const api = new Function(`${source.slice(0, cut)}; return {
  rateRegisters, tuningRegisters, gainRegisters, automaticBandwidth, planFor,
  formatForRate, unpackFrame, unpackTransfer, packPair, frameCounter,
  BANDWIDTHS, FORMATS, FLAG_BIAS_TEE, FLAG_FM_NOTCH, FLAG_DAB_NOTCH, SDRPLAY_DEVICES,
  FRAME_BYTES, FRAME_HEADER, MODE_AM,
};`)();

// words: reg7, reg4, reg3 (sample rate); reg8 (GPIO), then the six reg9
// tuner words; then the reg9 gain word and the reg9 DC-calibration word.
const REFERENCE = [
  { rate: 2000000, freq: 100100000, gain: 40, bw: 7, bias: 0, words: [0x000094, 0x000000, 0x011513, 0x00f180, 0x00000e, 0x000003, 0x05f420, 0x2801e5, 0x2100b2, 0x00000d, 0x00a261, 0x2001f6] },
  { rate: 1300000, freq: 10000, gain: 0, bw: 7, bias: 0, words: [0x000094, 0x019999, 0x01149b, 0x00f580, 0x00000e, 0x000003, 0x05fe10, 0x282585, 0x140012, 0x00000d, 0x009fb1, 0x2001f6] },
  { rate: 2048000, freq: 1000000, gain: 102, bw: 7, bias: 0, words: [0x000094, 0x03d70a, 0x011513, 0x00f580, 0x00000e, 0x000003, 0x05fe10, 0x280065, 0x140012, 0x00000d, 0x008001, 0x2001f6] },
  { rate: 6048000, freq: 7100000, gain: 43, bw: 7, bias: 0, words: [0x000094, 0x018937, 0x011607, 0x00f580, 0x00000e, 0x000003, 0x05fe10, 0x2803c5, 0x1500b2, 0x00000d, 0x0083b1, 0x2001f6] },
  { rate: 6049000, freq: 27000000, gain: 19, bw: 7, bias: 0, words: [0x000085, 0x019168, 0x015607, 0x00f580, 0x00000e, 0x000003, 0x05fe10, 0x280025, 0x180012, 0x00000d, 0x008fb1, 0x2001f6] },
  { rate: 8064000, freq: 50000000, gain: 60, bw: 7, bias: 0, words: [0x000085, 0x020c49, 0x015807, 0x00f180, 0x00000e, 0x000003, 0x05f420, 0x280035, 0x100022, 0x00000d, 0x0082a1, 0x2001f6] },
  { rate: 9216000, freq: 162400000, gain: 30, bw: 7, bias: 0, words: [0x0000a5, 0x06e978, 0x019907, 0x00f580, 0x00000e, 0x000003, 0x05f440, 0x2800f5, 0x1b0012, 0x00000d, 0x00a301, 0x2001f6] },
  { rate: 10000000, freq: 255000000, gain: 18, bw: 7, bias: 0, words: [0x000c94, 0x000000, 0x01da07, 0x00f480, 0x00000e, 0x000003, 0x05f440, 0x280025, 0x2a0012, 0x00000d, 0x00b291, 0x2001f6] },
  { rate: 12096000, freq: 315000000, gain: 42, bw: 7, bias: 0, words: [0x000c94, 0x03126e, 0x01dc07, 0x00f480, 0x00000e, 0x000003, 0x05f460, 0x280045, 0x1a0012, 0x00000d, 0x00a241, 0x2001f6] },
  { rate: 2000000, freq: 433920000, gain: 30, bw: 7, bias: 1, words: [0x000094, 0x000000, 0x011513, 0x00fd80, 0x00000e, 0x000003, 0x05f480, 0x280195, 0x120022, 0x00000d, 0x00a301, 0x2001f6] },
  { rate: 2000000, freq: 915000000, gain: 10, bw: 7, bias: 0, words: [0x000094, 0x000000, 0x011513, 0x00f580, 0x00000e, 0x000003, 0x05f480, 0x280085, 0x260012, 0x00000d, 0x00b311, 0x2001f6] },
  { rate: 2000000, freq: 1090000000, gain: 60, bw: 3, bias: 0, words: [0x000094, 0x000000, 0x011513, 0x00f580, 0x00000e, 0x000003, 0x04f500, 0x280185, 0x160112, 0x00000d, 0x0082a1, 0x2001f6] },
  { rate: 2000000, freq: 1575420000, gain: 102, bw: 0, bias: 0, words: [0x000094, 0x000000, 0x011513, 0x00f580, 0x00000e, 0x000003, 0x043500, 0x283205, 0x202912, 0x00000d, 0x008001, 0x2001f6] },
  { rate: 2000000, freq: 2000000000, gain: 0, bw: 7, bias: 0, words: [0x000094, 0x000000, 0x011513, 0x00f580, 0x00000e, 0x000003, 0x05f500, 0x280035, 0x290022, 0x00000d, 0x00b3b1, 0x2001f6] },
  { rate: 3000000, freq: 111999999, gain: 43, bw: 4, bias: 0, words: [0x000094, 0x000000, 0x01148b, 0x00f180, 0x00000e, 0x00aa53, 0x053420, 0x28ff25, 0x255502, 0x00000d, 0x0083b1, 0x2001f6] },
  { rate: 3000000, freq: 403999999, gain: 43, bw: 5, bias: 0, words: [0x000094, 0x000000, 0x01148b, 0x00f480, 0x00000e, 0x005553, 0x057460, 0x28ffe5, 0x21aa92, 0x00000d, 0x0083b1, 0x2001f6] },
  { rate: 3000000, freq: 999999999, gain: 43, bw: 6, bias: 0, words: [0x000094, 0x000000, 0x01148b, 0x00f580, 0x00000e, 0x005553, 0x05b480, 0x28ffe5, 0x29aa92, 0x00000d, 0x0083b1, 0x2001f6] },
];

for (const row of REFERENCE) {
  const r = api.rateRegisters(row.rate);
  const t = api.tuningRegisters(row.freq, api.BANDWIDTHS[row.bw],
    row.bias ? api.FLAG_BIAS_TEE : 0);
  const g = api.gainRegisters(row.gain, t.amBand);
  const words = [r.format.reg7, r.reg4, r.reg3, t.reg8, 0x0e, t.reg3, t.reg0, t.reg5,
    t.reg2, t.regd, g.reg1, g.reg6];
  assert.deepEqual(words.map(w => w.toString(16)), row.words.map(w => w.toString(16)),
    `register words for ${row.rate} S/s, ${row.freq} Hz, ${row.gain} dB`);
  // The synthesiser lands within one step of the request everywhere.
  assert.ok(Math.abs(t.actualFrequency - row.freq) < 200,
    `synthesiser lands on ${t.actualFrequency} for ${row.freq}`);
}

// The notch bits go into the GPIO byte without disturbing the band word.
{
  const base = api.tuningRegisters(433920000, 8000000, 0).reg8;
  assert.equal(base, 0xf580);
  assert.equal(api.tuningRegisters(433920000, 8000000, api.FLAG_FM_NOTCH).reg8, 0xf580 | 0x400);
  assert.equal(api.tuningRegisters(433920000, 8000000, api.FLAG_DAB_NOTCH).reg8, 0xf580 | 0x100);
}

// Format thresholds follow libmirisdr's automatic choice.
assert.equal(api.formatForRate(6048000).pairs, 252);
assert.equal(api.formatForRate(6048001).pairs, 336);
assert.equal(api.formatForRate(8064000).pairs, 336);
assert.equal(api.formatForRate(9216000).pairs, 384);
assert.equal(api.formatForRate(9216001).pairs, 504);
assert.equal(api.automaticBandwidth(2000000), 1536000);
assert.equal(api.automaticBandwidth(6000000), 6000000);
assert.equal(api.automaticBandwidth(12096000), 8000000);
assert.equal(api.planFor(49999999).mode, api.MODE_AM);
assert.notEqual(api.planFor(50000000).mode, api.MODE_AM);

// Every packing format round-trips through packPair/unpackFrame, including
// the sign, and the unpacked value is left-aligned to int16 full scale.
for (const format of api.FORMATS) {
  const frame = new Uint8Array(api.FRAME_BYTES);
  const full = 1 << (format.bits - 1);
  const values = [];
  for (let pair = 0; pair < format.pairs; ++pair) {
    const i = ((pair * 37) % (2 * full)) - full;
    const q = full - 1 - ((pair * 53) % (2 * full));
    values.push(i, q);
    api.packPair(format, frame, api.FRAME_HEADER, pair, i, q);
  }
  const out = new Int16Array(format.pairs * 2);
  const produced = api.unpackFrame(format, frame, out, 0);
  assert.equal(produced, format.pairs * 2, `${format.name} sample count`);
  const shift = 16 - format.bits;
  for (let k = 0; k < values.length; ++k)
    assert.equal(out[k], values[k] << shift, `${format.name} sample ${k}`);
}

// Counter bookkeeping: a gap of whole frames is loss, a gap that is not a
// whole number of frames is a slipped frame boundary.
{
  const format = api.formatForRate(2000000);
  const frames = 4;
  const bytes = new Uint8Array(frames * api.FRAME_BYTES);
  const setCounter = (index, counter) => {
    const o = index * api.FRAME_BYTES;
    bytes[o] = counter & 0xff; bytes[o + 1] = (counter >>> 8) & 0xff;
    bytes[o + 2] = (counter >>> 16) & 0xff; bytes[o + 3] = (counter >>> 24) & 0xff;
  };
  setCounter(0, 1000);
  setCounter(1, 1252);
  setCounter(2, 1252 + 252 * 3);   // two frames missing
  setCounter(3, 1252 + 252 * 4);
  const out = new Int16Array(frames * 504 * 2);
  const state = { expected: null };
  const result = api.unpackTransfer(format, bytes, state, out);
  assert.equal(result.frames, 4);
  assert.equal(result.produced, 4 * 252 * 2);
  assert.equal(result.lost, 504);
  assert.equal(result.misaligned, 0);
  assert.equal(state.expected, 1252 + 252 * 5);

  setCounter(0, 1252 + 252 * 5);
  setCounter(1, 0x12345678);        // garbage: mid-payload bytes read as a counter
  setCounter(2, 0x12345678 + 252);
  setCounter(3, 0x12345678 + 504);
  const slipped = api.unpackTransfer(format, bytes, state, out);
  assert.equal(slipped.misaligned, 1);
  assert.equal(slipped.lost, 0);
}

// The device table has no serial numbers to match on, so it must at least
// name every PID it accepts.
assert.deepEqual(api.SDRPLAY_DEVICES.map(d => d.productId), [0x3000, 0x3050, 0x2500]);
assert.ok(api.SDRPLAY_DEVICES.every(d => d.vendorId === 0x1df7 && d.name.startsWith('SDRplay')));

console.log('sdrplay_worker.test.mjs: ok');
