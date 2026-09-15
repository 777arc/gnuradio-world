// Browser-side device selection for the SDRplay RSP1A block. The RSP1A, RSP1B
// and RSP1 carry no USB serial string, so the .grc keeps nothing that names a
// unit: Device is '' (the first RSP shared with this site) or a fake, and the
// runner worker re-acquires whichever RSP the origin's persistent WebUSB
// permission covers. See docs/sdrplay.md.

import type { Inst } from './graph-model';
import {
  isFakeDevice,
  usbApi,
  type DeviceOption,
  type UsbFilter,
  type UsbLike,
  type UsbRadio,
} from './usb-radio';

export const SDRPLAY_SOURCE_ID = 'wasm_sdrplay_rsp1a_source';
export const SDRPLAY_DTYPE = 'sdrplay_device';

// Kept in step with SDRPLAY_DEVICES in runner/src/sdrplay_worker.js by
// editor/test/sdrplay.test.mjs: the picker and the worker must accept exactly
// the same radios, or one offers a device the other then refuses.
export const SDRPLAY_USB_FILTERS: UsbFilter[] = [
  { vendorId: 0x1df7, productId: 0x3000 },   // RSP1A
  { vendorId: 0x1df7, productId: 0x3050 },   // RSP1B
  { vendorId: 0x1df7, productId: 0x2500 },   // RSP1
];

const MODEL_NAMES: Record<number, string> = {
  0x3000: 'RSP1A',
  0x3050: 'RSP1B',
  0x2500: 'RSP1',
};

export function matchesSdrplay(device: UsbLike): boolean {
  return SDRPLAY_USB_FILTERS.some(filter =>
    filter.vendorId === device.vendorId && filter.productId === device.productId);
}

/** The device has no product string either (iProduct is 0), so name it by PID. */
export function sdrplayLabel(device: UsbLike): string {
  const model = MODEL_NAMES[device.productId] ?? 'RSP';
  return `SDRplay ${model}`;
}

export async function authorizedSdrplayDevices(): Promise<UsbLike[]> {
  const usb = usbApi();
  if (!usb) return [];
  try {
    return ((await usb.getDevices()) as UsbLike[]).filter(matchesSdrplay);
  } catch {
    return [];
  }
}

let sharedDevices: UsbLike[] = [];

export async function refreshSdrplayDevices(): Promise<UsbLike[]> {
  sharedDevices = await authorizedSdrplayDevices();
  return sharedDevices;
}

export function sdrplayDeviceDisplay(serial: string): string {
  const value = serial.trim();
  if (value) return value;
  const first = sharedDevices[0];
  if (!first) return 'first available';
  return `first available · ${sdrplayLabel(first)}`;
}

export function sdrplayDeviceOptions(serial: string, shared: UsbLike[]): DeviceOption[] {
  const options = [{
    value: '',
    label: shared.length ? `First available — ${sdrplayLabel(shared[0])}` : 'First available',
  }];
  if (serial)
    options.push({
      value: serial,
      label: isFakeDevice(serial)
        ? `${serial} — test signal generator`
        : `${serial} — not a valid device (RSPs have no serial number)`,
    });
  return options;
}

export function describeSdrplay(
  serial: string, shared: UsbLike[], hasUsb = !!usbApi()): string {
  if (isFakeDevice(serial))
    return 'Test device — no hardware is opened. Used by the runner tests.';
  if (!hasUsb)
    return 'This browser has no WebUSB. Chrome, Edge and Opera can run this block.';
  if (!shared.length)
    return 'No SDRplay RSP shared with this site yet — click Add, or press Run and ' +
           'the browser will ask.';
  if (serial)
    return `"${serial}" names nothing — an RSP has no serial number. Leave Device ` +
           'empty to use the first one shared with this site.';
  return `Uses ${sdrplayLabel(shared[0])}` +
    (shared.length > 1
      ? ` — first of ${shared.length} shared with this site; RSPs cannot be told apart`
      : '') + '.';
}

export function watchSdrplayDevices(onChange: () => void): void {
  const usb = usbApi();
  if (!usb) return;
  const update = () => { void refreshSdrplayDevices().then(onChange); };
  usb.addEventListener?.('connect', update);
  usb.addEventListener?.('disconnect', update);
  update();
}

/** The active RSP blocks, minus the ones that open no hardware. */
export function activeSdrplayBlocks(blocks: Inst[]): Inst[] {
  return blocks.filter(block => SDRPLAY_RADIO.owns(block) && block.enabled &&
    !block.bypassed && !isFakeDevice(String(block.params?.device ?? '').trim()));
}

export async function needsSdrplayGesture(blocks: Inst[]): Promise<boolean> {
  return !!usbApi() && activeSdrplayBlocks(blocks).length > 0 &&
    (await authorizedSdrplayDevices()).length === 0;
}

export async function prepareSdrplayDevices(blocks: Inst[]): Promise<string | null> {
  const active = activeSdrplayBlocks(blocks);
  if (!active.length) return null;
  if (!usbApi())
    return 'The SDRplay RSP1A block needs WebUSB, which only Chromium-based ' +
           'browsers (Chrome, Edge, Opera) provide. Firefox and Safari cannot run it.';
  // Nothing distinguishes two RSPs, and independent workers cannot share one,
  // so a flowgraph gets one RSP block.
  if (active.length > 1)
    return 'a flowgraph can have only one SDRplay RSP1A block: the radios carry ' +
           'no serial number, so a second block could not be told which unit to open';
  const named = active.find(block => String(block.params?.device ?? '').trim());
  if (named)
    return 'SDRplay RSP1A: leave Device empty — an RSP has no serial number to select by';

  if ((await authorizedSdrplayDevices()).length) return null;
  try {
    await usbApi().requestDevice({ filters: SDRPLAY_USB_FILTERS });
  } catch {
    // Chooser dismissed or no matching device.
  }
  if ((await refreshSdrplayDevices()).length) return null;
  return 'no SDRplay RSP is shared with this site — plug one in and choose it from ' +
         'the block properties';
}

export const SDRPLAY_RADIO: UsbRadio = {
  dtype: SDRPLAY_DTYPE,
  name: 'SDRplay RSP1A',
  filters: SDRPLAY_USB_FILTERS,
  owns: inst => inst.id === SDRPLAY_SOURCE_ID,
  display: sdrplayDeviceDisplay,
  options: sdrplayDeviceOptions,
  describe: describeSdrplay,
  refresh: refreshSdrplayDevices,
  watch: watchSdrplayDevices,
  needsGesture: needsSdrplayGesture,
  prepare: prepareSdrplayDevices,
};
