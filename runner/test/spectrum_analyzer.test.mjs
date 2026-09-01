import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const observationSource = await readFile(
  new URL('../src/gui_observation.js', import.meta.url), 'utf8');
const source = await readFile(
  new URL('../src/spectrum_analyzer.js', import.meta.url), 'utf8');
const sandbox = { console };
vm.runInNewContext(source, sandbox, { filename: 'spectrum_analyzer.js' });
const { engineering, peakOf, occupiedBandwidth } =
  sandbox.__grSpectrumAnalyzerInternals;

{
  const peak = peakOf([1, 4, 16, 4, 1], index => 1000 + index * 25, -10);
  assert.equal(peak.index, 2);
  assert.equal(peak.frequency, 1050);
  assert.ok(Math.abs(peak.level - (10 * Math.log10(16) - 10)) < 1e-9);
}

{
  // Five equal-power bins from 2 through 6. The 10% and 90% cumulative
  // crossings fall at 2 and 6, so the central 80% occupies exactly four bins.
  const power = [0, 0, 1, 1, 1, 1, 1, 0, 0];
  const frequency = power.map((_, index) => index * 100);
  const bandwidth = occupiedBandwidth(power, frequency, 4, 80, 0);
  assert.ok(bandwidth);
  assert.ok(Math.abs(bandwidth.low - 200) < 1e-9);
  assert.ok(Math.abs(bandwidth.high - 600) < 1e-9);
  assert.ok(Math.abs(bandwidth.width - 400) < 1e-9);
}

{
  // A restricted measurement span must ignore a much larger signal outside
  // the region centered on the active marker.
  const power = [1000, 0, 1, 2, 1, 0, 0];
  const frequency = power.map((_, index) => index * 10);
  const bandwidth = occupiedBandwidth(power, frequency, 3, 99, 30);
  assert.ok(bandwidth);
  assert.ok(bandwidth.low > 10 && bandwidth.high < 50);
}

assert.match(engineering(2_450_000, 'Hz'), /2\.45 MHz/);

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
