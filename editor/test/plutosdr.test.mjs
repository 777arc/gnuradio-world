// PlutoSDR's editor device picker and exclusive-ownership rules.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bundleModule } from './bundle-module.mjs';

const pluto = await bundleModule('../src/plutosdr.ts');

const worker = await readFile(
  new URL('../../runner/src/plutosdr_worker.js', import.meta.url), 'utf8');
const table = worker.match(/const PLUTO_FILTERS = \[([^\n]+)\];/);
assert.ok(table, 'worker Pluto filter not found');
const pair = table[1].match(/vendorId:\s*(0x[0-9a-f]+),\s*productId:\s*(0x[0-9a-f]+)/i);
assert.ok(pair, 'worker Pluto VID/PID not found');
assert.deepEqual(pluto.PLUTOSDR_USB_FILTERS, [{
  vendorId: Number(pair[1]), productId: Number(pair[2]),
}], 'the editor and worker must accept the same USB device');

// Exercise the worker's XML-driven discovery without depending on deviceN,
// interface, or endpoint numbers. Fake streaming deliberately bypasses this.
const workerContext = {
  TextEncoder, TextDecoder, performance, Atomics, Int32Array, Uint8Array,
  Uint32Array, BigInt, Map, Set, Promise, setTimeout, clearTimeout,
  navigator: { usb: {} }, postMessage() {}, close() {}, onmessage: null,
};
vm.runInNewContext(`${worker}\nthis.__plutoTest = { parseContextXml, radioLayout };`,
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
assert.equal(pluto.isFakePluto('fake:100000'), true);

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
  assert.equal(await pluto.preparePlutoDevices([
    source(hardware.serialNumber), sink(second.serialNumber),
  ]), null);
  assert.equal(await pluto.preparePlutoDevices([
    source(hardware.serialNumber, { enabled: false }),
  ]), null);

  devices = [];
  assert.match(String(await pluto.preparePlutoDevices([source('missing')])),
    /no PlutoSDR with serial/);
} finally {
  Object.defineProperty(globalThis, 'navigator', {
    value: savedNavigator, configurable: true, writable: true,
  });
}

console.log('plutosdr.test.mjs: ok');
