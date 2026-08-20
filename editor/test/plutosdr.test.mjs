// PlutoSDR's editor device picker and exclusive-ownership rules.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bundleModule } from './bundle-module.mjs';

const pluto = await bundleModule('../src/plutosdr.ts');
const workerSource = await readFile(
  new URL('../../runner/src/plutosdr_worker.js', import.meta.url), 'utf8');

// The VID/PID lives in three realms that cannot share a module -- the editor's
// picker, the worker, and the hardware harness page that grants the worker its
// permission -- so drift between them fails only at run time, with the browser
// offering a Pluto the worker then refuses to match. Compared as source text.
async function filtersIn(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const table = source.match(/const PLUTO_FILTERS = \[([^\n]+)\];/);
  assert.ok(table, `PLUTO_FILTERS not found in ${path}`);
  return [...table[1].matchAll(
    /vendorId:\s*(0x[0-9a-f]+),\s*productId:\s*(0x[0-9a-f]+)/gi)]
    .map(([, vendorId, productId]) => ({
      vendorId: Number(vendorId), productId: Number(productId),
    }));
}

for (const path of [
  '../../runner/src/plutosdr_worker.js',
  '../../test/hw/plutosdr_hw.html',
])
  assert.deepEqual(await filtersIn(path), pluto.PLUTOSDR_USB_FILTERS,
    `editor/src/plutosdr.ts and ${path.replace('../../', '')} disagree about ` +
    'which USB device is a PlutoSDR');

// Exercise the worker's XML-driven discovery without depending on deviceN,
// interface, or endpoint numbers. Fake streaming deliberately bypasses this.
const workerContext = {
  TextEncoder, TextDecoder, performance, Atomics, Int32Array, Uint8Array,
  Uint32Array, SharedArrayBuffer, BigInt, Map, Set, Promise, setTimeout, clearTimeout,
  navigator: { usb: {} }, postMessage() {}, close() {}, onmessage: null,
};
vm.runInNewContext(
  `${workerSource}\nthis.__plutoTest = { ` +
  `parseContextXml, radioLayout, applyPendingConfiguration, CTRL };`,
  workerContext);
const contextXml = `
<context>
  <device id="iio:device77" name="ad9361-phy">
    <channel id="voltage0" type="input"><attribute name="gain_control_mode"/></channel>
    <channel id="voltage0" type="output"><attribute name="hardwaregain"/></channel>
    <channel id="altvoltage0" type="output"><attribute name="frequency"/></channel>
    <channel id="altvoltage1" type="output"><attribute name="frequency"/></channel>
  </device>
  <device id="iio:device91" name="cf-ad9361-lpc">
    <channel id="voltage0" type="input"><scan-element index="0" format="le:S12/16&gt;&gt;0"/></channel>
    <channel id="voltage1" type="input"><scan-element index="1" format="le:S12/16&gt;&gt;0"/></channel>
  </device>
  <device id="iio:device105" name="cf-ad9361-dds-core-lpc">
    <channel id="voltage0" type="output"><scan-element index="0" format="le:S16/16&gt;&gt;0"/></channel>
    <channel id="voltage1" type="output"><scan-element index="1" format="le:S16/16&gt;&gt;0"/></channel>
  </device>
</context>`;
const discovered = workerContext.__plutoTest.parseContextXml(contextXml);
const rxLayout = workerContext.__plutoTest.radioLayout(discovered, 'rx', 1);
const txLayout = workerContext.__plutoTest.radioLayout(discovered, 'tx', 1);
assert.equal(rxLayout.stream.id, 'iio:device91');
assert.equal(txLayout.stream.id, 'iio:device105');
assert.equal(rxLayout.mask, '00000003');
assert.equal(txLayout.frameBytes, 4);
assert.throws(() => workerContext.__plutoTest.radioLayout(discovered, 'rx', 2),
  /only 1 RX channel/);

// A chooser update must traverse the shared mailbox, change fake-device pacing,
// publish the accepted rate, and acknowledge the exact command sequence. This
// is the same path a real worker uses before writing sampling_frequency to IIO.
const { CTRL } = workerContext.__plutoTest;
const mailboxMemory = { buffer: new SharedArrayBuffer(18 * Int32Array.BYTES_PER_ELEMENT) };
const mailbox = new Int32Array(mailboxMemory.buffer);
const fakeData = { memory: mailboxMemory, controlPointer: 0, sampleRate: 2500000 };
Atomics.store(mailbox, CTRL.SAMPLE_RATE, 2500000);
Atomics.store(mailbox, CTRL.CMD_SEQ, 1);
let applied = await workerContext.__plutoTest.applyPendingConfiguration(
  fakeData, null, null, 'rx', null, true);
assert.equal(applied.actualRate, 2500000);
Atomics.store(mailbox, CTRL.SAMPLE_RATE, 56000000);
Atomics.store(mailbox, CTRL.CMD_SEQ, 2);
applied = await workerContext.__plutoTest.applyPendingConfiguration(
  fakeData, null, null, 'rx', applied, true);
assert.equal(fakeData.sampleRate, 56000000);
assert.equal(Atomics.load(mailbox, CTRL.ACTUAL_RATE), 56000000);
assert.equal(Atomics.load(mailbox, CTRL.CMD_ACK), 2);

const hardware = {
  vendorId: 0x0456,
  productId: 0xb673,
  productName: 'ADALM-PLUTO',
  serialNumber: '1044735411960001',
};
assert.equal(pluto.matchesPluto(hardware), true);
assert.equal(pluto.matchesPluto({ vendorId: 0x0456, productId: 0xb672 }), false);
assert.equal(pluto.plutoLabel(hardware),
  'ADALM-PLUTO · 1044735411960001');
assert.deepEqual(pluto.plutoDeviceOptions('fake:100000', []).at(-1),
  { value: 'fake:100000', label: 'fake:100000 — test signal generator' });

assert.deepEqual(pluto.plutoDeviceOptions('', [hardware]), [
  { value: '', label: 'First available — ADALM-PLUTO · 1044735411960001' },
  { value: hardware.serialNumber, label: 'ADALM-PLUTO · 1044735411960001' },
]);
assert.deepEqual(pluto.plutoDeviceOptions('missing', [hardware]).at(-1),
  { value: 'missing', label: 'missing — not connected' });
assert.match(pluto.describePluto('', [hardware], true), /Uses ADALM-PLUTO/);
assert.match(pluto.describePluto('missing', [hardware], true), /not shared/);
assert.match(pluto.describePluto('fake', [], false), /Test device/);
assert.equal(pluto.plutoDeviceDisplay(''), 'first available');

let nextUid = 0;
const inst = (id, device, extra = {}) => ({
  uid: String(++nextUid), id, name: id, enabled: true, bypassed: false,
  params: { device }, ...extra,
});
const source = (device, extra) => inst(pluto.PLUTOSDR_SOURCE_ID, device, extra);
const sink = (device, extra) => inst(pluto.PLUTOSDR_SINK_ID, device, extra);

const savedNavigator = globalThis.navigator;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {}, configurable: true, writable: true,
  });
  assert.equal(await pluto.needsPlutoGesture([source('missing')]), false);
  assert.match(String(await pluto.preparePlutoDevices([source('')])), /WebUSB/);
  assert.equal(await pluto.preparePlutoDevices([source('fake')]), null);

  // Independent workers cannot coordinate one Pluto or resolve two blank
  // selectors safely. Distinct explicit serials are permitted.
  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: {
      getDevices: async () => [],
      requestDevice: async () => { throw new Error('not needed'); },
      addEventListener() {},
    } },
    configurable: true,
    writable: true,
  });
  assert.equal(await pluto.needsPlutoGesture([source('missing')]), true);
  assert.match(String(await pluto.preparePlutoDevices([source('a'), sink('a')])),
    /one physical PlutoSDR/);
  assert.match(String(await pluto.preparePlutoDevices([source(''), sink('b')])),
    /explicit Device/);

  const second = { ...hardware, serialNumber: '1044735411960002' };
  let devices = [hardware, second];
  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: {
      getDevices: async () => devices,
      requestDevice: async () => hardware,
      addEventListener() {},
    } },
    configurable: true,
    writable: true,
  });
  assert.equal(await pluto.needsPlutoGesture([source(hardware.serialNumber)]), false);
  assert.equal(await pluto.preparePlutoDevices([
    source(hardware.serialNumber), sink(second.serialNumber),
  ]), null);
  assert.equal(await pluto.preparePlutoDevices([
    source(hardware.serialNumber, { enabled: false }),
  ]), null);

  devices = [];
  assert.equal(await pluto.needsPlutoGesture([source('missing')]), true);
  assert.match(String(await pluto.preparePlutoDevices([source('missing')])),
    /no PlutoSDR with serial/);
} finally {
  Object.defineProperty(globalThis, 'navigator', {
    value: savedNavigator, configurable: true, writable: true,
  });
}

console.log('plutosdr.test.mjs: ok');
