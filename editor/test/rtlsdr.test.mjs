// RTL-SDR Source's editor half. The one thing here that cannot be checked by
// reading either file alone is the device table: the editor's picker and the
// runner's worker each carry a copy, they run in different realms and cannot
// share a module, and drift between them fails only at run time — the browser
// would offer a dongle the worker then refuses to match. See docs/rtlsdr.md.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';

const rtl = await bundleModule('../src/rtlsdr.ts');

// ---- The device table matches the reader worker's ----

const workerSource = await readFile(
  new URL('../../runner/src/rtlsdr_reader.js', import.meta.url), 'utf8');
const table = workerSource.match(
  /const RTL_DEVICE_FILTERS = \[([\s\S]*?)\n\];/);
assert.ok(table, 'RTL_DEVICE_FILTERS not found in runner/src/rtlsdr_reader.js');
const workerFilters = [...table[1].matchAll(
  /vendorId:\s*(0x[0-9a-f]+),\s*productId:\s*(0x[0-9a-f]+)/gi)]
  .map(([, vendorId, productId]) => `${vendorId}:${productId}`.toLowerCase());
const editorFilters = rtl.RTLSDR_USB_FILTERS.map(
  f => `0x${f.vendorId.toString(16).padStart(4, '0')}:` +
       `0x${f.productId.toString(16).padStart(4, '0')}`);

assert.ok(workerFilters.length >= 15, 'the worker table looks truncated');
assert.deepEqual(editorFilters, workerFilters,
  'editor/src/rtlsdr.ts and runner/src/rtlsdr_reader.js disagree about which ' +
  'USB devices are RTL-SDRs');

// ---- Device matching ----

const generic = { vendorId: 0x0bda, productId: 0x2838, serialNumber: '00000001' };
assert.equal(rtl.matchesRtl(generic), true);
assert.equal(rtl.matchesRtl({ vendorId: 0x1d50, productId: 0x6089 }), false,
  'a HackRF is not an RTL-SDR');

assert.equal(rtl.rtlLabel({ ...generic, productName: 'RTL2838UHIDIR' }),
  'RTL2838UHIDIR · 00000001');
assert.equal(rtl.rtlLabel({ vendorId: 0x0bda, productId: 0x2838 }),
  'RTL-SDR · no serial');

// ---- Which devices a flowgraph needs ----

const inst = (params, extra = {}) => ({
  uid: String(Math.random()), id: rtl.RTLSDR_ID, name: 'rtl',
  enabled: true, bypassed: false, params, ...extra,
});

assert.deepEqual(rtl.requiredRtlSerials([inst({ device: '00000001' })]),
  ['00000001']);
assert.deepEqual(rtl.requiredRtlSerials([inst({ device: '' })]), ['']),
assert.deepEqual(rtl.requiredRtlSerials([inst({ device: 'fake' })]), [],
  'the generator opens no hardware, so it needs no permission');
assert.deepEqual(rtl.requiredRtlSerials([inst({ device: 'fake:100000' })]), []);
assert.deepEqual(
  rtl.requiredRtlSerials([inst({ device: 'a' }, { enabled: false })]), [],
  'a disabled block needs nothing');
assert.deepEqual(
  rtl.requiredRtlSerials([inst({ device: 'a' }, { bypassed: true })]), [],
  'a bypassed block needs nothing');
assert.deepEqual(
  rtl.requiredRtlSerials([inst({ device: 'a' }), inst({ device: 'a' })]), ['a'],
  'two blocks on one dongle ask for it once');
assert.deepEqual(rtl.requiredRtlSerials([{ ...inst({}), id: 'blocks_null_source' }]), []);

// An empty serial means "first available", so it is satisfied by any dongle and
// unsatisfied only when there are none at all.
assert.deepEqual(rtl.unsatisfiedSerials([''], [generic]), []);
assert.deepEqual(rtl.unsatisfiedSerials([''], []), ['']);
assert.deepEqual(rtl.unsatisfiedSerials(['00000001'], [generic]), []);
assert.deepEqual(rtl.unsatisfiedSerials(['00000002'], [generic]), ['00000002'],
  'a named dongle is not satisfied by a different one');

// ---- What a block face shows ----

// The canvas draws synchronously from a cache, so with nothing shared the empty
// parameter still has to say something rather than leaving the row blank.
assert.equal(rtl.deviceDisplay(''), 'first available');
assert.equal(rtl.deviceDisplay('00000001'), '00000001',
  'a pinned serial shows as itself');
assert.equal(rtl.deviceDisplay('  00000001  '), '00000001');
assert.equal(rtl.deviceDisplay('fake:100000'), 'fake:100000');

// ---- No WebUSB at all ----

const savedNavigator = globalThis.navigator;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {}, configurable: true, writable: true,
  });
  assert.deepEqual(await rtl.authorizedRtlDevices(), [],
    'no WebUSB means no devices, not a throw');
  const message = await rtl.prepareRtlDevices([inst({ device: '' })]);
  assert.match(String(message), /WebUSB/,
    'a Firefox user is told why, not left with a generic failure');
  assert.equal(await rtl.prepareRtlDevices([inst({ device: 'fake' })]), null,
    'the generator runs even where WebUSB does not exist');
  assert.equal(await rtl.prepareRtlDevices([]), null);
} finally {
  Object.defineProperty(globalThis, 'navigator', {
    value: savedNavigator, configurable: true, writable: true,
  });
}

console.log('rtlsdr.test.mjs: ok');
