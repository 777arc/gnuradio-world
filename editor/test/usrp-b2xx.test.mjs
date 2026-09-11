// The USRP B2xx picker, its ownership rules, and the VID/PID table.
//
// There is no JavaScript worker for this radio -- libusb's Emscripten backend
// does the USB work inside b2xx.wasm -- so the drift check the HackRF and Pluto
// tests run against their workers is against UHD's own header instead, which is
// the actual authority on which devices exist.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';

const usrp = await bundleModule('../src/usrp-b2xx.ts');

// --- the device table matches UHD -------------------------------------------
// Skipped rather than failed when the dependency sources are not present: a
// checkout that has not run deps/fetch-deps.sh should not fail the editor suite.
const ifaceUrl = new URL(
  '../../deps/src/uhd-4.10.0.0/host/lib/usrp/b200/b200_iface.hpp', import.meta.url);
let iface = null;
try {
  iface = await readFile(ifaceUrl, 'utf8');
} catch {
  console.log('  (skipping UHD VID/PID drift check: deps/src/uhd-4.10.0.0 absent)');
}
if (iface) {
  const constant = name => {
    const match = iface.match(
      new RegExp(`${name}\\s*=\\s*(0x[0-9a-fA-F]+)`));
    assert.ok(match, `${name} not found in b200_iface.hpp`);
    return Number(match[1]);
  };
  const vendor = constant('B200_VENDOR_ID');
  const vendorNi = constant('B200_VENDOR_NI_ID');
  const expected = [
    { vendorId: vendor, productId: constant('B200_PRODUCT_ID') },
    { vendorId: vendor, productId: constant('B200MINI_PRODUCT_ID') },
    { vendorId: vendor, productId: constant('B205MINI_PRODUCT_ID') },
    { vendorId: vendor, productId: constant('B206MINI_PRODUCT_ID') },
    { vendorId: vendorNi, productId: constant('B200_PRODUCT_NI_ID') },
    { vendorId: vendorNi, productId: constant('B210_PRODUCT_NI_ID') },
  ];
  assert.deepEqual(usrp.USRP_B2XX_USB_FILTERS, expected,
    'the picker must offer exactly the devices UHD recognises');
  // The Cypress recovery ids are deliberately not offered.
  assert.ok(!usrp.USRP_B2XX_USB_FILTERS.some(f => f.vendorId === 0x04b4),
    'FX3 recovery ids must not appear in the picker');
}

// --- matching ---------------------------------------------------------------
assert.ok(usrp.matchesUsrpB2xx({ vendorId: 0x2500, productId: 0x0020 }));
assert.ok(usrp.matchesUsrpB2xx({ vendorId: 0x3923, productId: 0x7814 }));
assert.ok(!usrp.matchesUsrpB2xx({ vendorId: 0x1d50, productId: 0x6089 }),
  'a HackRF must not be offered as a USRP');

// --- labels are display hints ------------------------------------------------
assert.equal(
  usrp.usrpB2xxLabel({ productName: 'USRP B200', serialNumber: 'F5D86A' }),
  'USRP B200 · F5D86A');
assert.equal(usrp.usrpB2xxLabel({ serialNumber: '' }), 'USRP B2xx · no serial');

// --- options -----------------------------------------------------------------
const shared = [
  { vendorId: 0x2500, productId: 0x0020, productName: 'USRP B200', serialNumber: 'F5D86A' },
];
const options = usrp.usrpB2xxDeviceOptions('', shared);
assert.equal(options[0].value, '', 'the first option is always "first available"');
assert.ok(options[0].label.includes('F5D86A'));
assert.ok(options.some(o => o.value === 'F5D86A'));

const withMissing = usrp.usrpB2xxDeviceOptions('NOPE', shared);
assert.ok(withMissing.some(o => o.value === 'NOPE' && o.label.includes('not connected')));

const withFake = usrp.usrpB2xxDeviceOptions('fake:100000', []);
assert.ok(withFake.some(o => o.value === 'fake:100000' &&
  o.label.includes('test signal generator')));

// --- describe ----------------------------------------------------------------
assert.match(usrp.describeUsrpB2xx('fake', [], true), /no hardware is opened/);
assert.match(usrp.describeUsrpB2xx('', [], false), /no WebUSB/);
// The two-grant cold start is the single most confusing thing about this radio,
// so the empty-list text has to mention it.
assert.match(usrp.describeUsrpB2xx('', [], true), /granting twice|changes USB identity/);
assert.match(usrp.describeUsrpB2xx('F5D86A', shared, true), /Connected/);
assert.match(usrp.describeUsrpB2xx('OTHER', shared, true), /not shared with this site/);

// --- ownership and required serials -----------------------------------------
const block = (params, extra = {}) => ({
  id: 'wasm_usrp_b2xx_source', uid: 'u1', enabled: true, bypassed: false,
  params, ...extra,
});
assert.ok(usrp.USRP_B2XX_RADIO.owns(block({})));
assert.ok(!usrp.USRP_B2XX_RADIO.owns({ id: 'wasm_hackrf_source' }));

assert.deepEqual(usrp.requiredUsrpB2xxSerials([block({ device: 'F5D86A' })]), ['F5D86A']);
assert.deepEqual(usrp.requiredUsrpB2xxSerials([block({ device: 'fake' })]), [],
  'a fake device needs no permission');
assert.deepEqual(
  usrp.requiredUsrpB2xxSerials([block({ device: 'F5D86A' }, { enabled: false })]), [],
  'a disabled block needs no device');
assert.deepEqual(
  usrp.requiredUsrpB2xxSerials([block({ device: 'F5D86A' }, { bypassed: true })]), [],
  'a bypassed block needs no device');

// --- preparation and gesture rules, against a stubbed WebUSB -----------------
const device = {
  vendorId: 0x2500, productId: 0x0020,
  productName: 'USRP B200', serialNumber: 'F5D86A',
};
const source = serial => block({ device: serial });
const second = serial => ({ ...block({ device: serial }), uid: 'u2' });

const savedNavigator = globalThis.navigator;
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {}, configurable: true, writable: true,
  });
  assert.equal(await usrp.needsUsrpB2xxGesture([source('F5D86A')]), false,
    'no WebUSB means no gesture can help');
  assert.match(String(await usrp.prepareUsrpB2xxDevices([source('')])), /WebUSB/);
  assert.equal(await usrp.prepareUsrpB2xxDevices([source('fake')]), null,
    'an all-fake flowgraph needs no preparation');

  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: {
      getDevices: async () => [device],
      requestDevice: async () => device,
      addEventListener() {},
    } },
    configurable: true, writable: true,
  });
  assert.match(
    String(await usrp.prepareUsrpB2xxDevices([source('F5D86A'), second('F5D86A')])),
    /one physical USRP/,
    'two blocks must not share one board');
  assert.match(String(await usrp.prepareUsrpB2xxDevices([source(''), second('b')])),
    /explicit Device/,
    'with two blocks, "first available" is ambiguous');
  assert.equal(await usrp.prepareUsrpB2xxDevices([source('F5D86A')]), null);

  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: { getDevices: async () => [], addEventListener() {} } },
    configurable: true, writable: true,
  });
  assert.equal(await usrp.needsUsrpB2xxGesture([source('F5D86A')]), true);
  assert.equal(await usrp.needsUsrpB2xxGesture([source('fake')]), false);
  // The Windows hint matters here: an empty chooser on Windows almost always
  // means the device is not bound to WinUSB.
  assert.match(String(await usrp.prepareUsrpB2xxDevices([source('')])), /WinUSB/);
} finally {
  Object.defineProperty(globalThis, 'navigator', {
    value: savedNavigator, configurable: true, writable: true,
  });
}

console.log('usrp-b2xx tests passed');
