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
  usrpMasterClock,
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
  ['usrpb2xx', 'wasm_usrp_b2xx_source'],
]) {
  const flowgraph = sdrReceiveBenchmarkFlowgraph(radio, 'fake', 2_500_000);
  assert.match(flowgraph, new RegExp(`id: ${block}`), `${radio} gets its own source`);
  assert.match(flowgraph, /id: blocks_null_sink/, `${radio} is measured into a Null Sink`);
}
// The B2xx coerces a rate it cannot derive a tick rate for *upward* -- ask for
// 30.72 MS/s and get 40, which overflows and measures nothing useful -- so the
// master clock is pinned to the requested rate. It can only be pinned inside the
// device's own range, and pinning outside it throws, so below 5 MS/s the search
// is left to UHD. 0 is automatic.
assert.equal(usrpMasterClock(30.72e6), 30_720_000,
  'a pinnable rate is pinned, so UHD cannot coerce it upward');
assert.equal(usrpMasterClock(1e6), 0,
  'a rate below the B2xx master clock minimum is left automatic');
assert.equal(usrpMasterClock(80e6), 0,
  'a rate above the B2xx master clock maximum is left automatic');
assert.match(
  sdrReceiveBenchmarkFlowgraph('usrpb2xx', 'fake', 10_000_000),
  /master_clock_rate: '10000000'/,
  'the USRP speed test pins the master clock to the rate under test');
assert.match(
  sdrReceiveBenchmarkFlowgraph('usrpb2xx', 'fake', 1_000_000),
  /master_clock_rate: '0'/,
  'and leaves it automatic where the device cannot be pinned there');
// A USRP has no reader worker, so its counters arrive in the runner's own stats
// snapshot rather than window.__grUsbStats. Reading the wrong one would leave the
// test waiting for a 'running' state that never appears.
// Both are inside the B2xx master clock range, so both are pinned -- which is the
// only reason a request for 30.72 or 56 measures that rate at all instead of
// UHD quietly coercing it to 40.
assert.equal(usrpMasterClock(56e6), 56_000_000,
  '56 MS/s is pinnable and must be pinned');
assert.equal(usrpMasterClock(40e6), 40_000_000,
  'and so is 40 MS/s');
assert.match(speedTestSource, /statsFrom: 'runnerSnapshot'/,
  'the USRP reads its counters from the runner snapshot');
assert.match(speedTestSource, /startTimeoutMs: 300000/,
  'and is given long enough to load an FPGA image before the first sample');

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
