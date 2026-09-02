// Browser-side device selection for the Signal Hound BB60 Source. The .grc
// stores only a USB serial; the runner worker re-acquires the device from this
// origin's persistent WebUSB permission. See docs/signalhound.md.

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

export const BB60_SOURCE_ID = 'wasm_bb60_source';
export const BB60_DTYPE = 'bb60_device';

// Kept in step with BB60_FILTERS in runner/src/bb60_worker.js. Both the BB60C
// and BB60D enumerate as this Cypress FX3 vendor/product pair.
export const BB60_USB_FILTERS: UsbFilter[] = [
  { vendorId: 0x2817, productId: 0x0005 },
];

export function matchesBb60(device: UsbLike): boolean {
  return BB60_USB_FILTERS.some(filter =>
    filter.vendorId === device.vendorId && filter.productId === device.productId);
}

export function bb60Label(device: UsbLike): string {
  const name = device.productName && device.productName !== 'FX3'
    ? device.productName : 'Signal Hound BB60';
  return device.serialNumber ? `${name} · ${device.serialNumber}` : `${name} · no serial`;
}

export async function authorizedBb60Devices(): Promise<UsbLike[]> {
  const usb = usbApi();
  if (!usb) return [];
  try {
    return ((await usb.getDevices()) as UsbLike[]).filter(matchesBb60);
  } catch {
    return [];
  }
}

let sharedDevices: UsbLike[] = [];

export async function refreshBb60Devices(): Promise<UsbLike[]> {
  sharedDevices = await authorizedBb60Devices();
  return sharedDevices;
}

export function bb60DeviceDisplay(serial: string): string {
  const value = serial.trim();
  if (value) return value;
  const first = sharedDevices[0];
  if (!first) return 'first available';
  return `first available · ${first.serialNumber || first.productName || 'BB60'}`;
}

export function bb60DeviceOptions(serial: string, shared: UsbLike[]): DeviceOption[] {
  const options = [{
    value: '',
    label: shared.length ? `First available — ${bb60Label(shared[0])}` : 'First available',
  }];
  for (const device of shared)
    if (device.serialNumber)
      options.push({ value: device.serialNumber, label: bb60Label(device) });
  if (serial && !shared.some(device => device.serialNumber === serial))
    options.push({
      value: serial,
      label: isFakeDevice(serial)
        ? `${serial} — test signal generator`
        : `${serial} — not connected`,
    });
  return options;
}

export function describeBb60(
  serial: string, shared: UsbLike[], hasUsb = !!usbApi()): string {
  if (isFakeDevice(serial))
    return 'Test device — no hardware is opened.';
  if (!hasUsb)
    return 'This browser has no WebUSB. Chrome, Edge and Opera can run this block.';
  if (!shared.length)
    return 'No BB60 shared with this site yet — click Add, or press Run and the ' +
           'browser will ask.';
  if (!serial)
    return `Uses ${bb60Label(shared[0])}` +
      (shared.length > 1 ? ` — first of ${shared.length} shared with this site` : '') +
      '. Choose an explicit device when a flowgraph has more than one BB60 block.';
  const match = shared.find(device => device.serialNumber === serial);
  return match
    ? `Connected · ${bb60Label(match)}`
    : `"${serial}" is not shared with this site right now — plug it in, or click Add.`;
}

export function watchBb60Devices(onChange: () => void): void {
  const usb = usbApi();
  if (!usb) return;
  const update = () => { void refreshBb60Devices().then(onChange); };
  usb.addEventListener?.('connect', update);
  usb.addEventListener?.('disconnect', update);
  update();
}

export function requiredBb60Serials(blocks: Inst[]): string[] {
  return blocks
    .filter(block => BB60_RADIO.owns(block) && block.enabled && !block.bypassed)
    .map(block => String(block.params?.device ?? '').trim())
    .filter(serial => !isFakeDevice(serial));
}

export async function needsBb60Gesture(blocks: Inst[]): Promise<boolean> {
  const wanted = requiredBb60Serials(blocks);
  return !!usbApi() && wanted.length > 0 &&
    unsatisfiedSerials(wanted, await authorizedBb60Devices()).length > 0;
}

export async function prepareBb60Devices(blocks: Inst[]): Promise<string | null> {
  const wanted = requiredBb60Serials(blocks);
  if (!wanted.length) return null;
  if (!usbApi())
    return 'The Signal Hound BB60 block needs WebUSB, which only Chromium-based ' +
           'browsers (Chrome, Edge, Opera) provide. Firefox and Safari cannot run it.';

  // Independent workers cannot coordinate access to one device, so every
  // active block needs a distinct explicit serial.
  if (wanted.length > 1) {
    if (wanted.some(serial => !serial))
      return 'a flowgraph with more than one BB60 block must select an explicit ' +
             'Device for every block';
    if (new Set(wanted).size !== wanted.length)
      return 'one physical BB60 cannot be used by more than one block at a time';
  }

  if (!unsatisfiedSerials(wanted, await authorizedBb60Devices()).length) return null;
  try {
    await usbApi().requestDevice({ filters: BB60_USB_FILTERS });
  } catch {
    // Chooser dismissed or no matching device.
  }
  const missing = unsatisfiedSerials(wanted, await refreshBb60Devices());
  if (!missing.length) return null;
  const named = missing.filter(Boolean);
  return named.length
    ? `no BB60 with serial ${named.map(serial => `"${serial}"`).join(', ')} is ` +
      'shared with this site — open the block properties and choose a device'
    : 'no BB60 is shared with this site — plug one in and choose it from the ' +
      'block properties';
}

export const BB60_RADIO: UsbRadio = {
  dtype: BB60_DTYPE,
  name: 'BB60',
  filters: BB60_USB_FILTERS,
  owns: inst => inst.id === BB60_SOURCE_ID,
  display: bb60DeviceDisplay,
  options: bb60DeviceOptions,
  describe: describeBb60,
  refresh: refreshBb60Devices,
  watch: watchBb60Devices,
  needsGesture: needsBb60Gesture,
  prepare: prepareBb60Devices,
};
