// Browser-side device selection and ownership rules for HackRF Source/Sink.
// The .grc stores only a USB serial; the runner worker re-acquires the device
// from this origin's persistent WebUSB permission. See docs/hackrf.md.

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

export const HACKRF_SOURCE_ID = 'wasm_hackrf_source';
export const HACKRF_SINK_ID = 'wasm_hackrf_sink';
export const HACKRF_DTYPE = 'hackrf_device';

// Kept in step with HACKRF_FILTERS in runner/src/hackrf_worker.js and the
// hardware harness by editor/test/hackrf.test.mjs.
export const HACKRF_USB_FILTERS: UsbFilter[] = [
  { vendorId: 0x1d50, productId: 0x6089 },
];

export function matchesHackRf(device: UsbLike): boolean {
  return HACKRF_USB_FILTERS.some(filter =>
    filter.vendorId === device.vendorId && filter.productId === device.productId);
}

export function hackRfLabel(device: UsbLike): string {
  const name = device.productName || 'HackRF One';
  return device.serialNumber ? `${name} · ${device.serialNumber}` : `${name} · no serial`;
}

export async function authorizedHackRfDevices(): Promise<UsbLike[]> {
  const usb = usbApi();
  if (!usb) return [];
  try {
    return ((await usb.getDevices()) as UsbLike[]).filter(matchesHackRf);
  } catch {
    return [];
  }
}

let sharedDevices: UsbLike[] = [];

export async function refreshHackRfDevices(): Promise<UsbLike[]> {
  sharedDevices = await authorizedHackRfDevices();
  return sharedDevices;
}

export function hackRfDeviceDisplay(serial: string): string {
  const value = serial.trim();
  if (value) return value;
  const first = sharedDevices[0];
  if (!first) return 'first available';
  return `first available · ${first.serialNumber || first.productName || 'HackRF'}`;
}

export function hackRfDeviceOptions(
  serial: string, shared: UsbLike[]): DeviceOption[] {
  const options = [{
    value: '',
    label: shared.length
      ? `First available — ${hackRfLabel(shared[0])}`
      : 'First available',
  }];
  for (const device of shared)
    if (device.serialNumber)
      options.push({ value: device.serialNumber, label: hackRfLabel(device) });
  if (serial && !shared.some(device => device.serialNumber === serial))
    options.push({
      value: serial,
      label: isFakeDevice(serial)
        ? `${serial} — test signal generator`
        : `${serial} — not connected`,
    });
  return options;
}

export function describeHackRf(
  serial: string, shared: UsbLike[], hasUsb = !!usbApi()): string {
  if (isFakeDevice(serial))
    return 'Test device — no hardware is opened. Used by the runner tests.';
  if (!hasUsb)
    return 'This browser has no WebUSB. Chrome, Edge and Opera can run this block.';
  if (!shared.length)
    return 'No HackRF shared with this site yet — click Add, or press Run and ' +
           'the browser will ask.';
  if (!serial)
    return `Uses ${hackRfLabel(shared[0])}` +
      (shared.length > 1 ? ` — first of ${shared.length} shared with this site` : '') +
      '. Choose an explicit device when a flowgraph has more than one HackRF block.';
  const match = shared.find(device => device.serialNumber === serial);
  return match
    ? `Connected · ${hackRfLabel(match)}`
    : `"${serial}" is not shared with this site right now — plug it in, or click Add.`;
}

export function watchHackRfDevices(onChange: () => void): void {
  const usb = usbApi();
  if (!usb) return;
  const update = () => { void refreshHackRfDevices().then(onChange); };
  usb.addEventListener?.('connect', update);
  usb.addEventListener?.('disconnect', update);
  update();
}

export function requiredHackRfSerials(blocks: Inst[]): string[] {
  return blocks
    .filter(block => HACKRF_RADIO.owns(block) && block.enabled && !block.bypassed)
    .map(block => String(block.params?.device ?? '').trim())
    .filter(serial => !isFakeDevice(serial));
}

export async function needsHackRfGesture(blocks: Inst[]): Promise<boolean> {
  const wanted = requiredHackRfSerials(blocks);
  return !!usbApi() && wanted.length > 0 &&
    unsatisfiedSerials(wanted, await authorizedHackRfDevices()).length > 0;
}

export async function prepareHackRfDevices(blocks: Inst[]): Promise<string | null> {
  const wanted = requiredHackRfSerials(blocks);
  if (!wanted.length) return null;
  if (!usbApi())
    return 'HackRF blocks need WebUSB, which only Chromium-based browsers ' +
           '(Chrome, Edge, Opera) provide. Firefox and Safari cannot run them.';

  // HackRF is half-duplex. Independent workers also cannot coordinate access
  // to one device, so every active block needs a distinct explicit serial.
  if (wanted.length > 1) {
    if (wanted.some(serial => !serial))
      return 'a flowgraph with more than one HackRF block must select an ' +
             'explicit Device for every block';
    if (new Set(wanted).size !== wanted.length)
      return 'one physical HackRF cannot be used by more than one Source or ' +
             'Sink block at a time';
  }

  if (!unsatisfiedSerials(wanted, await authorizedHackRfDevices()).length) return null;
  try {
    await usbApi().requestDevice({ filters: HACKRF_USB_FILTERS });
  } catch {
    // Chooser dismissed or no matching device.
  }
  const missing = unsatisfiedSerials(wanted, await refreshHackRfDevices());
  if (!missing.length) return null;
  const named = missing.filter(Boolean);
  return named.length
    ? `no HackRF with serial ${named.map(serial => `"${serial}"`).join(', ')} ` +
      'is shared with this site — open the block properties and choose a device'
    : 'no HackRF is shared with this site — plug one in and choose it from ' +
      'the block properties';
}

export const HACKRF_RADIO: UsbRadio = {
  dtype: HACKRF_DTYPE,
  name: 'HackRF',
  filters: HACKRF_USB_FILTERS,
  owns: inst => inst.id === HACKRF_SOURCE_ID || inst.id === HACKRF_SINK_ID,
  display: hackRfDeviceDisplay,
  options: hackRfDeviceOptions,
  describe: describeHackRf,
  refresh: refreshHackRfDevices,
  watch: watchHackRfDevices,
  needsGesture: needsHackRfGesture,
  prepare: prepareHackRfDevices,
};
