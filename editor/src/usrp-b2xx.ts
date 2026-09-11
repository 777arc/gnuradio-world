// Browser-side device selection and ownership rules for the USRP B2xx Source.
// The .grc stores only a USB serial; the runner re-acquires the device from this
// origin's persistent WebUSB permission. See docs/usrp-b2xx.md.

import type { Inst } from './graph-model';
import {
  isFakeDevice,
  unsatisfiedSerials,
  usbApi,
  type DeviceOption,
  type UsbFilter,
  type UsbLike,
  type UsbRadio,
} from './usb-radio';

export const USRP_B2XX_SOURCE_ID = 'wasm_usrp_b2xx_source';
export const USRP_B2XX_DTYPE = 'usrp_b2xx_device';

// Every normal-runtime B2xx USB id, transcribed from UHD's own b200_vid_pid_pairs
// (host/lib/usrp/b200/b200_iface.hpp). The Cypress FX3 recovery ids (0x04b4) are
// deliberately absent: a board whose EEPROM needs repair is a job for
// b2xx_fx3_utils on a native host, not for a browser.
//
// Note these do NOT change when UHD loads the device's firmware. UHD decides
// whether firmware is present by reading the USB *manufacturer string*
// (libusb1_base.cpp firmware_loaded()), and it is the string descriptors and the
// serial number that change on re-enumeration -- which is exactly why a cold
// board needs granting twice. Kept in step by editor/test/usrp-b2xx.test.mjs.
export const USRP_B2XX_USB_FILTERS: UsbFilter[] = [
  { vendorId: 0x2500, productId: 0x0020 },  // B200 and B210 share this one
  { vendorId: 0x2500, productId: 0x0021 },  // B200mini
  { vendorId: 0x2500, productId: 0x0022 },  // B205mini
  { vendorId: 0x2500, productId: 0x0023 },  // B206mini
  { vendorId: 0x3923, productId: 0x7813 },  // NI USRP-2900
  { vendorId: 0x3923, productId: 0x7814 },  // NI USRP-2901
];

export function matchesUsrpB2xx(device: UsbLike): boolean {
  return USRP_B2XX_USB_FILTERS.some(filter =>
    filter.vendorId === device.vendorId && filter.productId === device.productId);
}

// The browser's product string is a display hint and nothing more. B200 and B210
// share a USB product id, a pre-firmware board reports whatever Cypress put in
// the descriptor ("WestBridge" on Windows), and only the EEPROM -- which UHD reads
// once the device is open -- says which board this really is.
export function usrpB2xxLabel(device: UsbLike): string {
  const name = device.productName || 'USRP B2xx';
  return device.serialNumber ? `${name} · ${device.serialNumber}` : `${name} · no serial`;
}

export async function authorizedUsrpB2xxDevices(): Promise<UsbLike[]> {
  const usb = usbApi();
  if (!usb) return [];
  try {
    return ((await usb.getDevices()) as UsbLike[]).filter(matchesUsrpB2xx);
  } catch {
    return [];
  }
}

let sharedDevices: UsbLike[] = [];

export async function refreshUsrpB2xxDevices(): Promise<UsbLike[]> {
  sharedDevices = await authorizedUsrpB2xxDevices();
  return sharedDevices;
}

export function usrpB2xxDeviceDisplay(serial: string): string {
  const value = serial.trim();
  if (value) return value;
  const first = sharedDevices[0];
  if (!first) return 'first available';
  return `first available · ${first.serialNumber || first.productName || 'USRP'}`;
}

export function usrpB2xxDeviceOptions(
  serial: string, shared: UsbLike[]): DeviceOption[] {
  const options = [{
    value: '',
    label: shared.length
      ? `First available — ${usrpB2xxLabel(shared[0])}`
      : 'First available',
  }];
  for (const device of shared)
    if (device.serialNumber)
      options.push({ value: device.serialNumber, label: usrpB2xxLabel(device) });
  if (serial && !shared.some(device => device.serialNumber === serial))
    options.push({
      value: serial,
      label: isFakeDevice(serial)
        ? `${serial} — test signal generator`
        : `${serial} — not connected`,
    });
  return options;
}

export function describeUsrpB2xx(
  serial: string, shared: UsbLike[], hasUsb = !!usbApi()): string {
  if (isFakeDevice(serial))
    return 'Test device — no hardware is opened, and no firmware or FPGA image ' +
           'is fetched. Used by the runner tests.';
  if (!hasUsb)
    return 'This browser has no WebUSB. Chrome, Edge and Opera can run this block.';
  if (!shared.length)
    return 'No USRP shared with this site yet — click Add, or press Run and the ' +
           'browser will ask. A board that has not been used since it was ' +
           'powered on needs granting twice: it changes USB identity when its ' +
           'firmware loads.';
  if (!serial)
    return `Uses ${usrpB2xxLabel(shared[0])}` +
      (shared.length > 1 ? ` — first of ${shared.length} shared with this site` : '') +
      '. Choose an explicit device when a flowgraph has more than one USRP block.';
  const match = shared.find(device => device.serialNumber === serial);
  return match
    ? `Connected · ${usrpB2xxLabel(match)}`
    : `"${serial}" is not shared with this site right now — plug it in, or click ` +
      'Add. A serial recorded before the firmware was loaded will not match ' +
      'afterwards; pick the device again.';
}

export function watchUsrpB2xxDevices(onChange: () => void): void {
  const usb = usbApi();
  if (!usb) return;
  const update = () => { void refreshUsrpB2xxDevices().then(onChange); };
  usb.addEventListener?.('connect', update);
  usb.addEventListener?.('disconnect', update);
  update();
}

export function requiredUsrpB2xxSerials(blocks: Inst[]): string[] {
  return blocks
    .filter(block => USRP_B2XX_RADIO.owns(block) && block.enabled && !block.bypassed)
    .map(block => String(block.params?.device ?? '').trim())
    .filter(serial => !isFakeDevice(serial));
}

export async function needsUsrpB2xxGesture(blocks: Inst[]): Promise<boolean> {
  const wanted = requiredUsrpB2xxSerials(blocks);
  return !!usbApi() && wanted.length > 0 &&
    unsatisfiedSerials(wanted, await authorizedUsrpB2xxDevices()).length > 0;
}

export async function prepareUsrpB2xxDevices(blocks: Inst[]): Promise<string | null> {
  const wanted = requiredUsrpB2xxSerials(blocks);
  if (!wanted.length) return null;
  if (!usbApi())
    return 'USRP blocks need WebUSB, which only Chromium-based browsers ' +
           '(Chrome, Edge, Opera) provide. Firefox and Safari cannot run them.';

  // One device, one block: UHD owns the whole radio once it opens it, so two
  // blocks cannot share one board.
  if (wanted.length > 1) {
    if (wanted.some(serial => !serial))
      return 'a flowgraph with more than one USRP block must select an ' +
             'explicit Device for every block';
    if (new Set(wanted).size !== wanted.length)
      return 'one physical USRP cannot be used by more than one block at a time';
  }

  if (!unsatisfiedSerials(wanted, await authorizedUsrpB2xxDevices()).length) return null;
  try {
    await usbApi().requestDevice({ filters: USRP_B2XX_USB_FILTERS });
  } catch {
    // Chooser dismissed or no matching device.
  }
  const missing = unsatisfiedSerials(wanted, await refreshUsrpB2xxDevices());
  if (!missing.length) return null;
  const named = missing.filter(Boolean);
  return named.length
    ? `no USRP with serial ${named.map(serial => `"${serial}"`).join(', ')} is ` +
      'shared with this site — open the block properties and choose a device'
    : 'no USRP is shared with this site — plug one in and choose it from the ' +
      'block properties. On Windows the device must be bound to WinUSB first, ' +
      'or the browser will not list it.';
}

export const USRP_B2XX_RADIO: UsbRadio = {
  dtype: USRP_B2XX_DTYPE,
  name: 'USRP B2xx',
  filters: USRP_B2XX_USB_FILTERS,
  owns: inst => inst.id === USRP_B2XX_SOURCE_ID,
  display: usrpB2xxDeviceDisplay,
  options: usrpB2xxDeviceOptions,
  describe: describeUsrpB2xx,
  refresh: refreshUsrpB2xxDevices,
  watch: watchUsrpB2xxDevices,
  needsGesture: needsUsrpB2xxGesture,
  prepare: prepareUsrpB2xxDevices,
};
