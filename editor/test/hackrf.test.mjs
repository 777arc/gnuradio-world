// HackRF's editor picker/ownership rules and worker protocol constants.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bundleModule } from './bundle-module.mjs';

const hackrf = await bundleModule('../src/hackrf.ts');
const workerSource = await readFile(
  new URL('../../runner/src/hackrf_worker.js', import.meta.url), 'utf8');

const filterTable = workerSource.match(/const HACKRF_FILTERS = \[([^\n]+)\];/);
assert.ok(filterTable, 'HACKRF_FILTERS not found in the worker');
const workerFilters = [...filterTable[1].matchAll(
  /vendorId:\s*(0x[0-9a-f]+),\s*productId:\s*(0x[0-9a-f]+)/gi)]
  .map(([, vendorId, productId]) => ({
    vendorId: Number(vendorId), productId: Number(productId),
  }));
assert.deepEqual(workerFilters, hackrf.HACKRF_USB_FILTERS,
  'the picker and worker must recognize exactly the same HackRF devices');

const workerContext = {
  TextEncoder, TextDecoder, performance, Atomics, Int32Array, Int8Array,
  Uint8Array, SharedArrayBuffer, DataView, Map, Set, Promise,
  setTimeout, clearTimeout, navigator: { usb: {} }, postMessage() {}, close() {},
  onmessage: null,
};
vm.runInNewContext(
  `${workerSource}\nthis.__hackrfTest = { ` +
    'validateCommand, automaticBandwidth, applyPendingConfiguration, ' +
    'REQUEST, BANDWIDTHS, CTRL };',
  workerContext);
const {
  validateCommand, automaticBandwidth, applyPendingConfiguration,
  REQUEST, BANDWIDTHS, CTRL,
} =
  workerContext.__hackrfTest;
assert.equal(REQUEST.SET_TRANSCEIVER_MODE, 1);
assert.equal(REQUEST.SET_FREQ, 16);
assert.equal(REQUEST.SET_TXVGA_GAIN, 21);
assert.equal(BANDWIDTHS.has(7000000), true);
assert.equal(automaticBandwidth(2000000), 1750000);
assert.equal(automaticBandwidth(8000000), 5500000);
assert.equal(automaticBandwidth(10000000), 7000000);
assert.equal(automaticBandwidth(20000000), 14000000);

const valid = {
  sampleRate: 10000000, frequency: 100000000, bandwidth: 0,
  lnaGain: 16, vgaGain: 16, txvgaGain: 0, flags: 0,
};
assert.doesNotThrow(() => validateCommand(valid, 'rx'));
assert.doesNotThrow(() => validateCommand(valid, 'tx'));
assert.throws(() => validateCommand({ ...valid, sampleRate: 1000000 }, 'rx'), /sample rate/);
assert.throws(() => validateCommand({ ...valid, bandwidth: 1234567 }, 'rx'), /bandwidth/);
assert.throws(() => validateCommand({ ...valid, lnaGain: 17 }, 'rx'), /IF gain/);
assert.throws(() => validateCommand({ ...valid, txvgaGain: 48 }, 'tx'), /TX VGA/);

// A chooser update must change fake-device pacing, publish the accepted rate,
// and acknowledge the command sequence. Real RX uses the same mailbox path
// before sending SET_SAMPLE_RATE and the matching automatic filter bandwidth.
const mailboxMemory = {
  buffer: new SharedArrayBuffer(17 * Int32Array.BYTES_PER_ELEMENT),
};
const mailbox = new Int32Array(mailboxMemory.buffer);
const fakeData = { memory: mailboxMemory, controlPointer: 0, sampleRate: 10000000 };
for (const [slot, value] of [
  [CTRL.SAMPLE_RATE, 10000000], [CTRL.FREQ_HI, 0],
  [CTRL.FREQ_LO, 100000000], [CTRL.BANDWIDTH, 0], [CTRL.LNA_GAIN, 16],
  [CTRL.VGA_GAIN, 16], [CTRL.TXVGA_GAIN, 0], [CTRL.FLAGS, 0],
  [CTRL.CMD_SEQ, 1],
]) Atomics.store(mailbox, slot, value);
let applied = await applyPendingConfiguration(fakeData, null, 'rx', null, true);
assert.equal(applied.actualRate, 10000000);
Atomics.store(mailbox, CTRL.SAMPLE_RATE, 20000000);
Atomics.store(mailbox, CTRL.CMD_SEQ, 2);
applied = await applyPendingConfiguration(fakeData, null, 'rx', applied, true);
assert.equal(fakeData.sampleRate, 20000000);
assert.equal(Atomics.load(mailbox, CTRL.ACTUAL_RATE), 20000000);
assert.equal(Atomics.load(mailbox, CTRL.CMD_ACK), 2);

const device = {
  vendorId: 0x1d50, productId: 0x6089,
  productName: 'HackRF One', serialNumber: '0000000000000001',
};
assert.equal(hackrf.matchesHackRf(device), true);
assert.equal(hackrf.matchesHackRf({ vendorId: 0x0456, productId: 0xb673 }), false);
assert.equal(hackrf.hackRfLabel(device), 'HackRF One · 0000000000000001');
assert.deepEqual(hackrf.hackRfDeviceOptions('', [device]), [
  { value: '', label: 'First available — HackRF One · 0000000000000001' },
  { value: device.serialNumber, label: 'HackRF One · 0000000000000001' },
]);
assert.deepEqual(hackrf.hackRfDeviceOptions('fake:100000', []).at(-1),
  { value: 'fake:100000', label: 'fake:100000 — test signal generator' });
assert.match(hackrf.describeHackRf('', [device], true), /Uses HackRF One/);
assert.match(hackrf.describeHackRf('missing', [device], true), /not shared/);

let uid = 0;
const inst = (id, serial, extra = {}) => ({
  uid: String(++uid), id, name: id, enabled: true, bypassed: false,
  params: { device: serial }, ...extra,
});
const source = (serial, extra) => inst(hackrf.HACKRF_SOURCE_ID, serial, extra);
const sink = (serial, extra) => inst(hackrf.HACKRF_SINK_ID, serial, extra);
assert.deepEqual(hackrf.requiredHackRfSerials([source('a'), sink('a')]), ['a', 'a']);
assert.deepEqual(hackrf.requiredHackRfSerials([source('fake')]), []);

const savedNavigator = globalThis.navigator;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {}, configurable: true, writable: true,
  });
  assert.equal(await hackrf.needsHackRfGesture([source(device.serialNumber)]), false);
  assert.match(String(await hackrf.prepareHackRfDevices([source('')])), /WebUSB/);
  assert.equal(await hackrf.prepareHackRfDevices([source('fake')]), null);

  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: {
      getDevices: async () => [device],
      requestDevice: async () => device,
      addEventListener() {},
    } },
    configurable: true, writable: true,
  });
  assert.match(String(await hackrf.prepareHackRfDevices([
    source(device.serialNumber), sink(device.serialNumber),
  ])), /one physical HackRF/);
  assert.match(String(await hackrf.prepareHackRfDevices([source(''), sink('b')])),
    /explicit Device/);
  assert.equal(await hackrf.prepareHackRfDevices([source(device.serialNumber)]), null);

  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: { getDevices: async () => [], addEventListener() {} } },
    configurable: true, writable: true,
  });
  assert.equal(await hackrf.needsHackRfGesture([source(device.serialNumber)]), true);
  assert.equal(await hackrf.needsHackRfGesture([source('fake')]), false);
} finally {
  Object.defineProperty(globalThis, 'navigator', {
    value: savedNavigator, configurable: true, writable: true,
  });
}

console.log('hackrf.test.mjs: ok');
