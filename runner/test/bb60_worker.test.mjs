// The BB60's tuning arithmetic, checked against packets actually captured
// from a BB60C. The protocol is reverse-engineered (see docs/signalhound.md),
// so these rows are the only specification there is: each one is the band
// group, RF-path byte, band constant and LO word that the vendor library put
// on the wire for that centre frequency. Runs on plain Node.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'bb60_worker.js'), 'utf8');

// Everything above the first worker-only global is pure arithmetic, so it can
// be evaluated here without a WebUSB or Worker environment.
const cut = source.indexOf('const encoder = new TextEncoder();');
assert.ok(cut > 0, 'bb60_worker.js no longer has the expected pure prefix');
const { tuning, configCommand } = new Function(
  `${source.slice(0, cut)}; return { tuning, configCommand };`)();

// Captured with reference level -20 dBm, which the vendor library resolves to
// attenuation code 25.
const REF = -20;

const CAPTURED = [
  { hz: 100000, b17: 64, b19: 25, u20: 32, word: 400 },
  { hz: 140000000, b17: 64, b19: 89, u20: 512, word: 6400 },
  { hz: 310000000, b17: 64, b19: 89, u20: 512, word: 6826 },
  { hz: 480000000, b17: 64, b19: 89, u20: 512, word: 7250 },
  { hz: 650000000, b17: 64, b19: 89, u20: 512, word: 7676 },
  { hz: 820000000, b17: 64, b19: 89, u20: 512, word: 8100 },
  { hz: 990000000, b17: 64, b19: 89, u20: 512, word: 8526 },
  { hz: 1160000000, b17: 64, b19: 89, u20: 512, word: 8950 },
  { hz: 1330000000, b17: 64, b19: 89, u20: 512, word: 9376 },
  { hz: 1500000000, b17: 64, b19: 89, u20: 512, word: 9800 },
  { hz: 1670000000, b17: 64, b19: 89, u20: 512, word: 10226 },
  { hz: 1840000000, b17: 64, b19: 89, u20: 512, word: 10650 },
  { hz: 2010000000, b17: 64, b19: 121, u20: 272, word: 8076 },
  { hz: 2180000000, b17: 64, b19: 121, u20: 272, word: 8500 },
  { hz: 2350000000, b17: 64, b19: 121, u20: 272, word: 8926 },
  { hz: 2520000000, b17: 64, b19: 121, u20: 216, word: 9350 },
  { hz: 2690000000, b17: 64, b19: 121, u20: 216, word: 9776 },
  { hz: 2860000000, b17: 64, b19: 121, u20: 216, word: 10200 },
  { hz: 3030000000, b17: 64, b19: 121, u20: 216, word: 10626 },
  { hz: 3200000000, b17: 65, b19: 153, u20: 456, word: 14050 },
  { hz: 3370000000, b17: 65, b19: 153, u20: 456, word: 14476 },
  { hz: 3540000000, b17: 65, b19: 153, u20: 456, word: 14900 },
  { hz: 3710000000, b17: 65, b19: 153, u20: 456, word: 15326 },
  { hz: 3880000000, b17: 65, b19: 153, u20: 456, word: 15750 },
  { hz: 4050000000, b17: 65, b19: 153, u20: 456, word: 16176 },
  { hz: 4220000000, b17: 66, b19: 185, u20: 512, word: 16600 },
  { hz: 4390000000, b17: 66, b19: 185, u20: 512, word: 17026 },
  { hz: 4560000000, b17: 66, b19: 185, u20: 512, word: 17450 },
  { hz: 4730000000, b17: 66, b19: 185, u20: 512, word: 17876 },
  { hz: 4900000000, b17: 66, b19: 185, u20: 512, word: 18300 },
  { hz: 5070000000, b17: 66, b19: 185, u20: 512, word: 18726 },
  { hz: 5240000000, b17: 66, b19: 217, u20: 216, word: 16150 },
  { hz: 5410000000, b17: 66, b19: 217, u20: 216, word: 16576 },
  { hz: 5580000000, b17: 67, b19: 249, u20: 216, word: 17000 },
  { hz: 5750000000, b17: 67, b19: 249, u20: 216, word: 17426 },
  { hz: 5920000000, b17: 67, b19: 249, u20: 216, word: 17850 },
  { hz: 6090000000, b17: 67, b19: 249, u20: 216, word: 18276 },
  { hz: 6260000000, b17: 67, b19: 249, u20: 216, word: 18700 },
  { hz: 95000000, b17: 64, b19: 89, u20: 512, word: 6288 },
  { hz: 95115000, b17: 64, b19: 89, u20: 512, word: 6288 },
  { hz: 95230000, b17: 64, b19: 89, u20: 512, word: 6288 },
  { hz: 95345000, b17: 64, b19: 89, u20: 512, word: 6288 },
  { hz: 95460000, b17: 64, b19: 89, u20: 512, word: 6288 },
  { hz: 95575000, b17: 64, b19: 89, u20: 512, word: 6288 },
  { hz: 95690000, b17: 64, b19: 89, u20: 512, word: 6290 },
  { hz: 95805000, b17: 64, b19: 89, u20: 512, word: 6290 },
  { hz: 95920000, b17: 64, b19: 89, u20: 512, word: 6290 },
  { hz: 96035000, b17: 64, b19: 89, u20: 512, word: 6290 },
  { hz: 96150000, b17: 64, b19: 89, u20: 512, word: 6290 },
  { hz: 96265000, b17: 64, b19: 89, u20: 512, word: 6290 },
  { hz: 96380000, b17: 64, b19: 89, u20: 512, word: 6290 },
  { hz: 96495000, b17: 64, b19: 89, u20: 512, word: 6292 },
  { hz: 96610000, b17: 64, b19: 89, u20: 512, word: 6292 },
  { hz: 96725000, b17: 64, b19: 89, u20: 512, word: 6292 },
  { hz: 96840000, b17: 64, b19: 89, u20: 512, word: 6292 },
  { hz: 96955000, b17: 64, b19: 89, u20: 512, word: 6292 },
];

for (const row of CAPTURED) {
  const tune = tuning(row.hz, REF);
  const where = `${(row.hz / 1e6).toFixed(3)} MHz`;
  assert.equal(tune.band.b17, row.b17, `band group at ${where}`);
  assert.equal(tune.byte19, row.b19, `RF path byte at ${where}`);
  assert.equal(tune.band.u20, row.u20, `band constant at ${where}`);
  assert.equal(tune.word, row.word, `LO word at ${where}`);

  // ... and that those land in the packet where the device expects them.
  const packet = configCommand(tune, false);
  assert.equal(packet.length, 1024, 'commands are a fixed 1024 bytes');
  assert.equal(packet[16], 0, 'byte 16 clear means run');
  assert.equal(packet[17], row.b17);
  assert.equal(packet[19], row.b19);
  assert.equal(packet[20] | (packet[21] << 8), row.u20);
  assert.equal(packet[22] | (packet[23] << 8), row.word);
}

// The LO grid is 0.8 MHz: the word counts in 0.4 MHz units but is always even.
for (const row of CAPTURED)
  assert.equal(row.word % 2, 0, `captured LO words are always even (${row.hz})`);

// Float arithmetic gets this one wrong -- (1690 + 2420.4) / 0.8 is
// 5137.999999999999 in doubles, which floors a whole 0.8 MHz step low.
assert.equal(tuning(1690e6, REF).word, 10276,
  'LO word must be computed in integer hertz, not floating point');

// The LO stops moving at its maximum a little above 6.39 GHz.
assert.equal(tuning(6400e6, REF).word, 19026, 'LO saturates at the top');
assert.equal(tuning(6390e6, REF).word, 19026, 'LO saturates at the top');

// Byte 16 is a STOP flag, not a start flag: 0 runs, 1 halts. Getting this
// backwards makes the device emit what is already in flight and then go quiet
// for good, which is indistinguishable from a throughput problem.
const tune = tuning(100e6, REF);
const run = configCommand(tune, false);
const halt = configCommand(tune, true);
assert.equal(run[16], 0, 'streaming packet must clear byte 16');
assert.equal(halt[16], 1, 'stop packet must set byte 16');
const differing = [...run.keys()].filter(i => run[i] !== halt[i]);
assert.deepEqual(differing, [16], 'run and stop differ only at byte 16');
assert.ok(/startStream/.test(source) && !/async arm\s*\(/.test(source),
  'the start path must not be spelled as an arm; byte 16 = 1 stops the device');

// Reference level, exactly as the vendor library resolves it. These pairs were
// read off its own command stream while sweeping bbConfigureRefLevel, and the
// byte-529 switch above -10 dBm is the part that is easy to get wrong: setting
// it at a low reference level costs about 20 dB of sensitivity.
for (const [dbm, code, b529] of [
  [-70, 1, 56], [-45, 1, 56], [-40, 5, 56], [-35, 10, 56], [-20, 25, 56],
  [-15, 30, 56], [-10, 1, 128], [0, 15, 128], [10, 25, 128],
]) {
  const t = tuning(100e6, dbm);
  assert.equal(t.byte19 & 31, code, `attenuation code at ${dbm} dBm`);
  assert.equal(t.byte529, b529, `byte 529 at ${dbm} dBm`);
  assert.equal(t.byte19 >> 5, 2, 'band survives every reference level');
}

// Where the tuned centre lands in the 70 MS/s stream. Measured against three
// FM stations; the NCO in bb60_source.cpp undoes exactly this.
const fm = tuning(95.5e6, REF);
assert.ok(Math.abs(fm.offsetHz / 1e6 - 14.1) < 0.35,
  `95.5 MHz should land near 14.1 MHz, got ${(fm.offsetHz / 1e6).toFixed(3)}`);


// Every method run() calls on the USB wrapper must actually exist. A previous
// edit deleted configure() and arm() as collateral while rewriting the open
// sequence; nothing caught it until the device was in the loop, because the
// call sites are all behind `await`.
const usbMethods = new Set(
  [...source.matchAll(/^  async (\w+)\s*\(/gm)].map(m => m[1]));
const called = new Set(
  [...source.matchAll(/(?<!navigator\.)\busb\.(\w+)\s*\(/g)].map(m => m[1]));
for (const name of called)
  assert.ok(usbMethods.has(name),
    `run() calls usb.${name}() but Bb60Usb defines no such method`);
assert.ok(called.has('initialise') && called.has('startStream') && called.has('stopStream'),
  'the open/start/stop sequence must still be driven from run()');

console.log('bb60 worker tuning tests passed');
