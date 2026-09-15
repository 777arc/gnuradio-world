// SDRplay's editor picker: the device table must match the worker's, and the
// wording has to cope with radios that carry no serial number at all.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';

const sdrplay = await bundleModule('../src/sdrplay.ts');
const workerSource = await readFile(
  new URL('../../runner/src/sdrplay_worker.js', import.meta.url), 'utf8');

const table = workerSource.match(/const SDRPLAY_DEVICES = \[([\s\S]*?)\];/);
assert.ok(table, 'SDRPLAY_DEVICES not found in the worker');
const workerFilters = [...table[1].matchAll(
  /vendorId:\s*(0x[0-9a-f]+),\s*productId:\s*(0x[0-9a-f]+)/gi)]
  .map(([, vendorId, productId]) => ({
    vendorId: Number(vendorId), productId: Number(productId),
  }));
assert.deepEqual(workerFilters, sdrplay.SDRPLAY_USB_FILTERS,
  'the picker and worker must recognize exactly the same SDRplay devices');

const rsp1a = { vendorId: 0x1df7, productId: 0x3000 };
const rsp1b = { vendorId: 0x1df7, productId: 0x3050 };
assert.equal(sdrplay.matchesSdrplay(rsp1a), true);
assert.equal(sdrplay.matchesSdrplay({ vendorId: 0x1df7, productId: 0x3010 }), false,
  'the RSP2 has a different front end and is not accepted');
assert.equal(sdrplay.sdrplayLabel(rsp1a), 'SDRplay RSP1A');
assert.equal(sdrplay.sdrplayLabel(rsp1b), 'SDRplay RSP1B');

// No serial means one option: the first shared unit. A stray value is shown
// but flagged rather than offered as a second unit.
assert.deepEqual(sdrplay.sdrplayDeviceOptions('', [rsp1a]).map(o => o.value), ['']);
assert.match(sdrplay.sdrplayDeviceOptions('', [rsp1a])[0].label, /RSP1A/);
assert.match(sdrplay.sdrplayDeviceOptions('fake:1000', [])[1].label, /test signal/);
assert.match(sdrplay.sdrplayDeviceOptions('ABC', [rsp1a])[1].label, /no serial/);

assert.match(sdrplay.describeSdrplay('fake', [], true), /Test device/);
assert.match(sdrplay.describeSdrplay('', [], false), /no WebUSB/);
assert.match(sdrplay.describeSdrplay('', [], true), /click Add/);
assert.match(sdrplay.describeSdrplay('', [rsp1a], true), /Uses SDRplay RSP1A/);
assert.match(sdrplay.describeSdrplay('', [rsp1a, rsp1b], true), /cannot be told apart/);
assert.match(sdrplay.describeSdrplay('ABC', [rsp1a], true), /names nothing/);

const block = (device, extra = {}) => ({
  id: 'wasm_sdrplay_rsp1a_source', enabled: true, bypassed: false,
  params: { device }, ...extra,
});
assert.equal(sdrplay.activeSdrplayBlocks([block('fake'), block('')]).length, 1);
assert.equal(sdrplay.activeSdrplayBlocks([block('', { enabled: false })]).length, 0);
assert.equal(sdrplay.SDRPLAY_RADIO.owns(block('')), true);
assert.equal(sdrplay.SDRPLAY_RADIO.owns({ id: 'wasm_hackrf_source' }), false);

// Without WebUSB, prepare() explains rather than prompting; with two active
// blocks it refuses, since nothing could tell the workers apart.
const original = globalThis.navigator;
Object.defineProperty(globalThis, 'navigator', { value: { usb: undefined }, configurable: true });
assert.match(await sdrplay.prepareSdrplayDevices([block('')]), /WebUSB/);
assert.equal(await sdrplay.prepareSdrplayDevices([block('fake')]), null);
Object.defineProperty(globalThis, 'navigator', {
  value: { usb: { getDevices: async () => [rsp1a] } }, configurable: true,
});
assert.equal(await sdrplay.prepareSdrplayDevices([block('')]), null);
assert.match(await sdrplay.prepareSdrplayDevices([block(''), block('')]), /only one/);
assert.match(await sdrplay.prepareSdrplayDevices([block('ABC')]), /leave Device empty/);
Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });

console.log('sdrplay.test.mjs: ok');
