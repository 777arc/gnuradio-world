// RTL-SDR Source's editor half. The one thing here that cannot be checked by
// reading either file alone is the device table: the editor's picker and the
// runner's worker each carry a copy, they run in different realms and cannot
// share a module, and drift between them fails only at run time — the browser
// would offer a dongle the worker then refuses to match. See docs/rtlsdr.md.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';

const rtl = await bundleModule('../src/rtlsdr.ts');

// ---- The device table matches every other copy of it ----

// Three files carry it: this module, the reader worker, and the hardware
// harness page that grants the worker its permission. They run in three realms
// and cannot share a module, so the table is compared as source text.
async function filtersIn(path, name) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const table = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
  assert.ok(table, `${name} not found in ${path}`);
  return [...table[1].matchAll(
    /vendorId:\s*(0x[0-9a-f]+),\s*productId:\s*(0x[0-9a-f]+)/gi)]
    .map(([, vendorId, productId]) => `${vendorId}:${productId}`.toLowerCase());
}

const editorFilters = rtl.RTLSDR_USB_FILTERS.map(
  f => `0x${f.vendorId.toString(16).padStart(4, '0')}:` +
       `0x${f.productId.toString(16).padStart(4, '0')}`);
assert.ok(editorFilters.length >= 15, 'the editor table looks truncated');

for (const [path, name] of [
  ['../../runner/src/rtlsdr_reader.js', 'RTL_DEVICE_FILTERS'],
  ['../../test/hw/rtlsdr_hw.html', 'RTL_FILTERS'],
])
  assert.deepEqual(await filtersIn(path, name), editorFilters,
    `editor/src/rtlsdr.ts and ${path.replace('../../', '')} disagree about ` +
    'which USB devices are RTL-SDRs');

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

// ---- What the Properties dialog offers ----

// "First available" stays a real, selectable choice: pinning a serial into the
// .grc is what makes a flowgraph unrunnable on anyone else's machine.
assert.deepEqual(rtl.deviceOptions('', []),
  [{ value: '', label: 'First available' }]);
assert.deepEqual(rtl.deviceOptions('', [{ ...generic, productName: 'RTL2838' }]), [
  { value: '', label: 'First available — RTL2838 · 00000001' },
  { value: '00000001', label: 'RTL2838 · 00000001' },
]);
// A serial the browser cannot see right now still has to be listed, or opening
// the dialog would silently repoint the block at a different dongle.
assert.deepEqual(rtl.deviceOptions('00000009', [generic]).at(-1),
  { value: '00000009', label: '00000009 — not connected' });
assert.deepEqual(rtl.deviceOptions('fake:100000', []).at(-1),
  { value: 'fake:100000', label: 'fake:100000 — test signal generator' });
// A dongle with no serial cannot be named, so it appears only as "first
// available" rather than as an option that would store an empty value twice.
assert.equal(
  rtl.deviceOptions('', [{ vendorId: 0x0bda, productId: 0x2838 }]).length, 1);

assert.match(rtl.describeDevice('fake', [], true), /Test signal generator/);
assert.match(rtl.describeDevice('00000001', [generic], true), /^Connected/);
assert.match(rtl.describeDevice('00000009', [generic], true),
  /not shared with this site/);
assert.match(rtl.describeDevice('', [generic], true), /keeps the flowgraph portable/);
assert.match(rtl.describeDevice('', [], true), /No RTL-SDR shared with this site/);
// A Firefox user is told why the picker is inert rather than left with an
// empty dropdown; the fake device is still described, since it needs no WebUSB.
assert.match(rtl.describeDevice('00000001', [generic], false), /no WebUSB/);
assert.match(rtl.describeDevice('fake', [], false), /Test signal generator/);

// ---- No WebUSB at all ----

const savedNavigator = globalThis.navigator;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {}, configurable: true, writable: true,
  });
  assert.deepEqual(await rtl.authorizedRtlDevices(), [],
    'no WebUSB means no devices, not a throw');
  assert.equal(await rtl.needsRtlGesture([inst({ device: '' })]), false,
    'a browser without WebUSB cannot offer a useful permission gesture');
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

// ---- Host driver preflight ----

const calls = [];
const usable = {
  ...generic,
  opened: false,
  configuration: null,
  async open() { calls.push('open'); this.opened = true; },
  async selectConfiguration(value) {
    calls.push(`configure:${value}`); this.configuration = { configurationValue: value };
  },
  async claimInterface(value) { calls.push(`claim:${value}`); },
  async releaseInterface(value) { calls.push(`release:${value}`); },
  async close() { calls.push('close'); this.opened = false; },
};
assert.equal(await rtl.rtlDriverProblem(usable), null);
assert.deepEqual(calls, ['open', 'configure:1', 'claim:0', 'release:0', 'close'],
  'the preflight claims the same interface as the worker and leaves it free');

let closedAfterFailure = false;
const missingDriver = {
  ...generic,
  opened: false,
  configuration: { configurationValue: 1 },
  async open() { this.opened = true; },
  async claimInterface() { throw new DOMException('Unable to claim interface', 'NetworkError'); },
  async close() { closedAfterFailure = true; this.opened = false; },
};
const driverProblem = await rtl.rtlDriverProblem(missingDriver);
assert.equal(driverProblem.title, 'RTL-SDR device driver required');
assert.match(driverProblem.message, /install the WinUSB driver/i);
assert.equal(closedAfterFailure, true, 'a failed probe still closes what it opened');

const navigatorBeforePrepareProbe = globalThis.navigator;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: {
      async getDevices() { return [missingDriver]; },
      async requestDevice() { throw new Error('the existing grant should be used'); },
    } },
    configurable: true,
    writable: true,
  });
  const prepareProblem = await rtl.prepareRtlDevices([
    inst({ device: generic.serialNumber }),
  ]);
  assert.equal(await rtl.needsRtlGesture([inst({ device: generic.serialNumber })]), false,
    'an existing origin grant needs no new gesture');
  assert.equal(prepareProblem.title, 'RTL-SDR device driver required',
    'the normal Run preflight blocks an already-authorized unusable dongle');
} finally {
  Object.defineProperty(globalThis, 'navigator', {
    value: navigatorBeforePrepareProbe, configurable: true, writable: true,
  });
}

const navigatorBeforeGesture = globalThis.navigator;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: { getDevices: async () => [] } }, configurable: true, writable: true,
  });
  assert.equal(await rtl.needsRtlGesture([inst({ device: generic.serialNumber })]), true);
  assert.equal(await rtl.needsRtlGesture([inst({ device: 'fake' })]), false);
} finally {
  Object.defineProperty(globalThis, 'navigator', {
    value: navigatorBeforeGesture, configurable: true, writable: true,
  });
}

console.log('rtlsdr.test.mjs: ok');
