import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as mainSource, cssSource } from './editor-contract-source.mjs';

const speedTestSource = await readFile(
  new URL('../src/sdr-speed-test.ts', import.meta.url), 'utf8');

const {
  receiveRate,
  speedometerAngle,
  formatSdrRate,
  sdrReceiveBenchmarkFlowgraph,
} = await bundleModule('../src/sdr-speed-test.ts');

assert.equal(receiveRate(
  { seconds: 1, items: 2_000_000 },
  { seconds: 6, items: 102_000_000 },
), 20_000_000, 'the gauge uses GNU Radio item deltas over runner uptime deltas');
assert.equal(receiveRate(
  { seconds: 2, items: 10 }, { seconds: 2, items: 20 }), null,
  'two readings from the same diagnostics tick cannot produce a rate');
assert.equal(receiveRate(
  { seconds: 1, items: 20 }, { seconds: 2, items: 10 }), null,
  'a counter reset is not reported as negative throughput');

assert.equal(speedometerAngle(0, 20e6), -90);
assert.equal(speedometerAngle(10e6, 20e6), 0);
assert.equal(speedometerAngle(20e6, 20e6), 90);
assert.equal(speedometerAngle(30e6, 20e6), 90, 'the needle clamps at the dial ceiling');
assert.equal(formatSdrRate(19_876_543), '19.88 MSamples/s');
assert.equal(formatSdrRate(875_500), '875.5 kSamples/s');

for (const [radio, block] of [
  ['hackrf', 'wasm_hackrf_source'],
  ['plutosdr', 'wasm_plutosdr_source'],
  ['rtlsdr', 'wasm_rtlsdr_source'],
]) {
  const flowgraph = sdrReceiveBenchmarkFlowgraph(radio, 'fake', 2_500_000);
  assert.match(flowgraph, new RegExp(`id: ${block}`), `${radio} gets its own source`);
  assert.match(flowgraph, /id: blocks_null_sink/, `${radio} is measured into a Null Sink`);
}
assert.match(
  sdrReceiveBenchmarkFlowgraph('plutosdr', 'fake', 2_500_000, 8192),
  /buffer_size: '8192'/,
  'the PlutoSDR speed test uses its selected IIO buffer size');
assert.throws(
  () => sdrReceiveBenchmarkFlowgraph('plutosdr', 'fake', 2_500_000, 262145),
  /buffer size must be an integer from 1 to 262144/,
  'the PlutoSDR speed test rejects buffers larger than its single-channel limit');

assert.match(mainSource, /label: 'SDR Receive Speed Test…'/,
  'the speed test is reachable from Help');
assert.match(mainSource, /isSdrSpeedTestFrameSource/,
  'its private runner messages are excluded from the editor Run state');
assert.match(mainSource, /showUsbPreparationProblem\(problem\)/,
  'an RTL-SDR driver failure opens a modal before a normal flowgraph starts');
assert.match(speedTestSource, /rtlDriverProblem\(device\)/,
  'the speed test uses the RTL-SDR host-driver probe');
assert.ok(
  speedTestSource.indexOf('if (!await rtlIsAccessible(radio, device)) return;') <
    speedTestSource.indexOf('running = true;'),
  'the speed test blocks on the driver probe before starting its runner');
for (const selector of [
  '.sdr-gauge', '.sdr-gauge-needle', '.sdr-speed-progress', '.sdr-speed-run',
  '.sdr-speed-buffer',
])
  assert.ok(cssSource.includes(selector), `missing ${selector} speed-test styling`);

console.log('checked SDR speed-test rate math, gauge scale, menu wiring, and styling');
