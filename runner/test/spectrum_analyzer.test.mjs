import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const observationSource = await readFile(
  new URL('../src/gui_observation.js', import.meta.url), 'utf8');
const source = await readFile(
  new URL('../src/spectrum_analyzer.js', import.meta.url), 'utf8');
const sandbox = { console };
vm.runInNewContext(source, sandbox, { filename: 'spectrum_analyzer.js' });
const { engineering, totalPowerLevel, signalAnnotationLines, signalHue, placeSignalAnnotation,
  accumulateDisplayedPeak, percentile, estimateNoiseFloor, smoothPower, peakOf,
  autoScaleBounds, occupiedBandwidthRange, detectSignals } =
  sandbox.__grSpectrumAnalyzerInternals;

{
  const values = Array.from({ length: 10_000 }, (_, index) => index);
  assert.ok(Math.abs(percentile(values, 4) - 399.96) < 1e-9,
    'percentiles use interpolation rather than snapping to a sample');
}

{
  // Deterministic quantiles of exponential power with a -70 dB mean. The
  // corrected lower-tail estimator should recover that mean noise power even
  // though its input quantile is roughly 6.5 dB lower.
  const meanPower = 1e-7;
  const levels = Array.from({ length: 10_000 }, (_, index) => {
    const probability = (index + 0.5) / 10_000;
    return 10 * Math.log10(-Math.log1p(-probability) * meanPower);
  });
  assert.ok(Math.abs(estimateNoiseFloor(levels) + 70) < 0.01,
    'the corrected lower-tail estimator recovers mean FFT-bin noise power');
}

{
  const peak = peakOf([1, 4, 16, 4, 1], index => 1000 + index * 25, -10);
  assert.equal(peak.index, 2);
  assert.equal(peak.frequency, 1050);
  assert.ok(Math.abs(peak.level - (10 * Math.log10(16) - 10)) < 1e-9);
}

{
  // Five equal-power bins span 500 Hz. Removing 0.5% of the power from each
  // edge leaves the fixed 99% occupied bandwidth at 495 Hz.
  const power = [0, 0, 1, 1, 1, 1, 1, 0, 0];
  const frequency = power.map((_, index) => index * 100);
  const bandwidth = occupiedBandwidthRange(power, frequency, 2, 6);
  assert.ok(bandwidth);
  assert.ok(Math.abs(bandwidth.low - 152.5) < 1e-9);
  assert.ok(Math.abs(bandwidth.high - 647.5) < 1e-9);
  assert.ok(Math.abs(bandwidth.width - 495) < 1e-9);
}

assert.match(engineering(2_450_000, 'Hz'), /2\.45 MHz/);

assert.ok(Math.abs(totalPowerLevel(4, 2, -10) - (10 * Math.log10(2) - 10)) < 1e-9,
  'total signal power divides integrated FFT-bin power by window ENBW before calibration');

assert.deepEqual(Array.from(signalAnnotationLines({
  id: 2, center: 2_450_000, width: 12_500,
  totalPower: -14.375, peakLevel: -18.125,
}, 'dBm')), [
  'S2', 'Center 2.45 MHz', '99% BW 12.5 kHz',
  'Power -14.38 dBm', 'Max -18.13 dBm',
], 'signal annotations put the centered id on its own line and honor calibrated units');

assert.ok(Array.from({ length: 1000 }, (_, index) => signalHue(index + 1))
  .every(hue => hue < 110 || hue >= 190),
'signal colors always exclude the green hue band used by the spectrum trace');

{
  const peak = { x: 280, y: 58 };
  const label = { width: 170, height: 83 };
  const placed = placeSignalAnnotation(
    { left: 62, right: 520, top: 16, bottom: 330 },
    label.width, label.height, 42, peak.x, peak.y);
  const coversPeak = peak.x >= placed.x && peak.x <= placed.x + label.width &&
    peak.y >= placed.y && peak.y <= placed.y + label.height;
  assert.equal(coversPeak, false,
    'a tone annotation is placed beside its peak instead of covering the tip');
}

{
  let state = accumulateDisplayedPeak(1000, -30, null, 0);
  state = accumulateDisplayedPeak(1100, -20, state, 250);
  state = accumulateDisplayedPeak(1200, -10, state, 750);
  assert.equal(state.displayPeakLevel, -30,
    'the displayed peak stays fixed during its one-second accumulation window');
  state = accumulateDisplayedPeak(1300, -15, state, 1000);
  assert.equal(state.displayPeakLevel, -10);
  assert.equal(state.displayPeakFrequency, 1200,
    'the completed window publishes its strongest peak and matching frequency');
}

{
  const levels = [-83, -81, -79, -77, -30, -24.25];
  const annotationMaximum = -22.125;
  const scale = autoScaleBounds(levels, annotationMaximum);
  assert.ok(scale.referenceLevel - annotationMaximum >= scale.dbPerDivision,
    'autoscale reserves at least one full division above the annotation maximum');
  assert.ok(scale.referenceLevel - 10 * scale.dbPerDivision <= scale.floor,
    'autoscale keeps the estimated floor inside the displayed range');
}

{
  const power = Array(32).fill(1e-10);
  for (let index = 4; index <= 8; index++) power[index] = 1e-5;
  for (let index = 20; index <= 24; index++) power[index] = 1e-4;
  power[6] = 1e-3;
  power[22] = 1e-2;
  const frequencies = power.map((_, index) => 1000 + index * 100);
  const signals = detectSignals(power, frequencies, -60);
  assert.equal(signals.length, 2, 'each above-threshold island is detected');
  assert.equal(signals[0].peakFrequency, frequencies[6]);
  assert.equal(signals[1].peakFrequency, frequencies[22]);
  assert.ok(signals.every(signal => signal.width > 0 && signal.low < signal.center &&
    signal.center < signal.high), 'every detected signal has a 99% bandwidth and center');
  assert.ok(signals[1].peakLevel > signals[0].peakLevel,
    'each signal carries its own peak y-axis value');
}

{
  // A modulated signal's raw periodogram has deep random notches. Detection on
  // a short power envelope should keep it whole and reject isolated background
  // excursions, while measurements still use the original bins.
  const power = Array(96).fill(1e-10);
  for (let index = 24; index <= 70; index++)
    power[index] = index % 3 === 0 ? 1e-10 : 1e-4;
  power[8] = 1e-5;
  const frequencies = power.map((_, index) => index * 100);
  const envelope = smoothPower(power, 8);
  const signals = detectSignals(power, frequencies, -60, 0, 24, envelope);
  assert.equal(signals.length, 1,
    'spectral-envelope detection joins modulation notches and rejects an isolated bin');
  assert.ok(signals[0].low < frequencies[25] && signals[0].high > frequencies[70]);
  assert.equal(signals[0].peakLevel,
    peakOf(power, index => frequencies[index]).level,
    'envelope smoothing does not alter the interpolated peak measurement');
}

{
  // Two boxcar passes form a triangular kernel: a one-bin excursion is spread
  // more gently than after one pass and cannot create a tiny boundary island.
  const impulse = Array(41).fill(0);
  impulse[20] = 1;
  const once = smoothPower(impulse, 4, 1);
  const twice = smoothPower(impulse, 4, 2);
  assert.ok(twice[12] > once[12] && twice[16] < once[16] &&
    Math.abs(twice[20] - once[20]) < 1e-12,
    'two-pass smoothing produces the intended triangular detection envelope');
  assert.ok(Math.abs(Array.from(twice).reduce((sum, value) => sum + value, 0) - 1) < 1e-9,
    'frequency-domain smoothing preserves integrated power away from display edges');
}

{
  // Browser renderers replace their otherwise-empty Qt placement placeholder
  // by instance name, without the aggregator knowing either block id.
  const observationSandbox = { console, document: { querySelector: () => null } };
  vm.runInNewContext(observationSource, observationSandbox,
    { filename: 'gui_observation.js' });
  const { GuiObservationService } = observationSandbox.__grGuiObservationInternals;
  const service = new GuiObservationService();
  service.register('legacy', {
    widgets: () => [{ name: 'display', id: 'legacy', rect: { x: 0, y: 0, width: 10, height: 10 } }],
    readPlotData: () => ({ widgets: [{ name: 'display', id: 'legacy', kind: 'labels' }] }),
  }, 0);
  service.register('native', {
    widgets: () => [{ name: 'display', id: 'native', rect: { x: 1, y: 2, width: 8, height: 7 } }],
    readPlotData: () => ({ widgets: [{ name: 'display', id: 'native', kind: 'curves' }] }),
    captureLayers: () => [{ source: { width: 80, height: 70 },
      rect: { x: 1, y: 2, width: 8, height: 7 }, widget: 'display', z: 10 }],
  }, 10);
  assert.equal(service.readPlotData('', 32).widgets[0].id, 'native');
  assert.equal(service.widgets()[0].id, 'native');
  assert.equal(service.capturePlan('display').layers[0].provider, 'native');
}

console.log('spectrum analyzer numerical tests passed');
