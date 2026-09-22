import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(
  new URL('../src/spectrum_analyzer_mmo.js', import.meta.url), 'utf8');
const sandbox = { console };
vm.runInNewContext(source, sandbox, { filename: 'spectrum_analyzer_mmo.js' });
const {
  MmoSpectrumPresentation,
  healthFraction,
  classifySignal,
  placeBar,
} = sandbox.__grSpectrumAnalyzerMmoInternals;

const metrics = {
  spanHz: 1000,
  rbwHz: 10,
  minimumLevel: -100,
  maximumLevel: 0,
};
const signal = (id, power, overrides = {}) => ({
  id,
  center: id * 100,
  peakFrequency: id * 100,
  peakLevel: power,
  totalPower: power,
  width: 20,
  low: id * 100 - 10,
  high: id * 100 + 10,
  color: '#79c8ff',
  ...overrides,
});

assert.equal(healthFraction(-100, -100, 0), 0);
assert.equal(healthFraction(-50, -100, 0), 0.5);
assert.equal(healthFraction(20, -100, 0), 1,
  'health bars clamp received power to the displayed level range');
assert.equal(classifySignal(signal(1, -80), metrics), 'Tone Imp');
assert.equal(classifySignal(signal(1, -10), metrics), 'Elite Tone Imp');
assert.equal(classifySignal(signal(1, -50, { width: 100 }), metrics), 'Wideband Brute');

{
  const presentation = new MmoSpectrumPresentation();
  presentation.update([signal(1, -20)], 0, metrics);
  assert.equal(presentation.tracks.get(1).level, 1);
  presentation.update([signal(1, -20)], 4999, metrics);
  assert.equal(presentation.tracks.get(1).level, 1);
  presentation.update([signal(1, -20)], 5000, metrics);
  assert.equal(presentation.tracks.get(1).level, 2);
  presentation.update([signal(1, -20)], 10000, metrics);
  assert.equal(presentation.tracks.get(1).level, 3,
    'a continuously detected signal gains one level every five seconds');

  presentation.update([signal(1, -23)], 10100, metrics);
  assert.equal(presentation.tracks.get(1).damageAmount, undefined,
    'an exact 3 dB fall is not damage');
  assert.equal(presentation.tracks.get(1).maxPower, -20);
  presentation.update([signal(1, -23.1)], 10200, metrics);
  assert.ok(Math.abs(presentation.tracks.get(1).damageAmount - 3.1) < 1e-9);
  assert.equal(presentation.tracks.get(1).maxPower, -23.1,
    'damage resets the running maximum to the new received power');
  const damageUntil = presentation.tracks.get(1).damageUntil;
  presentation.update([signal(1, -23.1)], 10300, metrics);
  assert.equal(presentation.tracks.get(1).damageUntil, damageUntil,
    'the same drop does not deal damage again after the maximum resets');

  presentation.update([signal(1, -10)], 10400, metrics);
  assert.equal(presentation.tracks.get(1).maxPower, -10,
    'recovery establishes a new running maximum');
  presentation.update([signal(1, -20.01)], 10500, metrics);
  assert.equal(presentation.tracks.get(1).damageCritical, true,
    'a drop over 10 dB is a critical hit');
  assert.equal(presentation.tracks.get(1).maxPower, -20.01);

  presentation.update([], 10600, metrics);
  assert.equal(presentation.tracks.has(1), false);
  assert.equal(presentation.retired.length, 1,
    'loss keeps only a short-lived dissolve effect');
  presentation.update([signal(1, -40)], 10700, metrics);
  assert.equal(presentation.tracks.get(1).level, 1);
  assert.equal(presentation.tracks.get(1).maxPower, -40,
    'rediscovery starts with fresh level and power state');
}

{
  const presentation = new MmoSpectrumPresentation();
  presentation.update([signal(1, -20)], 0, metrics);
  presentation.setHeld(true, 1000);
  presentation.setHeld(false, 11000);
  presentation.update([signal(1, -20)], 12000, metrics);
  assert.equal(presentation.tracks.get(1).level, 1,
    'Hold pauses level progression');
  presentation.update([signal(1, -20)], 15000, metrics);
  assert.equal(presentation.tracks.get(1).level, 2);
}

{
  const presentation = new MmoSpectrumPresentation();
  presentation.update([signal(1, -20), signal(2, -21)], 0, metrics);
  assert.equal(presentation.bossId, 1);
  presentation.update([signal(1, -20), signal(2, -19)], 100, metrics);
  assert.equal(presentation.bossId, 1,
    'boss hysteresis rejects a marginally stronger challenger');
  presentation.update([signal(1, -20), signal(2, -18)], 200, metrics);
  assert.equal(presentation.bossId, 2,
    'a clearly stronger signal takes the boss target');

  presentation.update([signal(1, -22, { center: 150 }), signal(2, -18)],
    1500, metrics);
  const state = presentation.tracks.get(1);
  assert.equal(state.statuses.fading, true);
  assert.equal(state.statuses.moving, true,
    'recent power and center histories drive fading and movement statuses');

}

{
  const occupied = [];
  const rect = { left: 0, right: 400, top: 0, bottom: 300 };
  const first = placeBar(rect, 200, 180, 100, 50, occupied);
  const second = placeBar(rect, 200, 180, 100, 50, occupied);
  assert.notEqual(second.top, first.top,
    'overlapping signal health bars are staggered');
  assert.ok(second.left >= rect.left && second.right <= rect.right);
}

console.log('spectrum analyzer MMO state tests passed');
