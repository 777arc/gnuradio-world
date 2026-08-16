// Browser-side device selection for the PlutoSDR Source and Sink. The .grc
// stores only a USB serial number; the runner worker re-acquires the device
// from the origin's persistent WebUSB permission and owns it for the run.
// ./usb-radio owns what this shares with the other WebUSB radios; the Pluto
// specifics -- its device table, its wording and its exclusive ownership rule
// -- are here. See docs/plutosdr.md.

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

export const PLUTOSDR_SOURCE_ID = 'wasm_plutosdr_source';
export const PLUTOSDR_SINK_ID = 'wasm_plutosdr_sink';
export const PLUTOSDR_DTYPE = 'plutosdr_device';

/**
 * Kept in step with PLUTO_FILTERS in runner/src/plutosdr_worker.js and in
 * test/hw/plutosdr_hw.html by a case in editor/test/plutosdr.test.mjs: the
 * three run in different realms and cannot share a module, so drift is
 * otherwise silent — the picker would offer a Pluto the worker then refuses.
 */
export const PLUTOSDR_USB_FILTERS: UsbFilter[] = [
  { vendorId: 0x0456, productId: 0xb673 },  // Analog Devices ADALM-PLUTO
];

export function matchesPluto(device: UsbLike): boolean {
  return PLUTOSDR_USB_FILTERS.some(filter =>
    filter.vendorId === device.vendorId && filter.productId === device.productId);
}

/** Serial is the identifier a .grc stores. */
export function plutoLabel(device: UsbLike): string {
  const name = device.productName || 'ADALM-PLUTO';
  return device.serialNumber
    ? `${name} · ${device.serialNumber}`
    : `${name} · no serial`;
}

/** Plutos already shared with this origin. Empty when WebUSB is unavailable. */
export async function authorizedPlutoDevices(): Promise<UsbLike[]> {
  const usb = usbApi();
  if (!usb) return [];
  try {
    return ((await usb.getDevices()) as UsbLike[]).filter(matchesPluto);
  } catch {
    return [];
  }
}

// The canvas draws a block face synchronously, but WebUSB only answers a
// promise, so what a block shows for its device has to come from a cache.
let sharedDevices: UsbLike[] = [];

export async function refreshPlutoDevices(): Promise<UsbLike[]> {
  sharedDevices = await authorizedPlutoDevices();
  return sharedDevices;
}

export function plutoDeviceDisplay(serial: string): string {
  const value = serial.trim();
  if (value) return value;
  const first = sharedDevices[0];
  if (!first) return 'first available';
  return `first available · ${first.serialNumber || first.productName || 'PlutoSDR'}`;
}

export function plutoDeviceOptions(
  serial: string, shared: UsbLike[]): DeviceOption[] {
  const options = [{
    value: '',
    label: shared.length
      ? `First available — ${plutoLabel(shared[0])}`
      : 'First available',
  }];
  for (const device of shared)
    if (device.serialNumber)
      options.push({ value: device.serialNumber, label: plutoLabel(device) });
  if (serial && !shared.some(device => device.serialNumber === serial))
    options.push({
      value: serial,
      label: isFakeDevice(serial)
        ? `${serial} — test signal generator`
        : `${serial} — not connected`,
    });
  return options;
}

export function describePluto(
  serial: string, shared: UsbLike[], hasUsb = !!usbApi()): string {
  if (isFakeDevice(serial))
    return 'Test device — no hardware is opened. Used by the runner tests.';
  if (!hasUsb)
    return 'This browser has no WebUSB. Chrome, Edge and Opera can run this block.';
  if (!shared.length)
    return 'No PlutoSDR shared with this site yet — click Add, or press Run and ' +
           'the browser will ask.';
  if (!serial)
    return `Uses ${plutoLabel(shared[0])}` +
      (shared.length > 1 ? ` — first of ${shared.length} shared with this site` : '') +
      '. Choose an explicit device when a flowgraph has more than one PlutoSDR block.';
  const match = shared.find(device => device.serialNumber === serial);
  return match
    ? `Connected · ${plutoLabel(match)}`
    : `"${serial}" is not shared with this site right now — plug it in, or click Add.`;
}

export function watchPlutoDevices(onChange: () => void): void {
  const usb = usbApi();
  if (!usb) return;
  const update = () => { void refreshPlutoDevices().then(onChange); };
  usb.addEventListener?.('connect', update);
  usb.addEventListener?.('disconnect', update);
  update();
}

/** The serials the flowgraph's active PlutoSDR blocks need, '' meaning any. */
function requiredPlutoSerials(blocks: Inst[]): string[] {
  return blocks
    .filter(block => PLUTOSDR_RADIO.owns(block) && block.enabled && !block.bypassed)
    .map(block => String(block.params?.device ?? '').trim())
    .filter(serial => !isFakeDevice(serial));
}

/**
 * Enforces the current ownership model and obtains any missing WebUSB grant.
 * Separate real Plutos may run together, but one physical device cannot be
 * shared between workers. A future full-duplex block can coordinate both pipes.
 *
 * Unlike requiredRtlSerials() this keeps duplicates: two blocks naming one
 * Pluto is exactly what has to be rejected below.
 *
 * @returns a message to report, or null when everything is in place.
 */
export async function preparePlutoDevices(blocks: Inst[]): Promise<string | null> {
  const wanted = requiredPlutoSerials(blocks);
  if (!wanted.length) return null;
  if (!usbApi())
    return 'PlutoSDR blocks need WebUSB, which only Chromium-based browsers ' +
           '(Chrome, Edge, Opera) provide. Firefox and Safari cannot run them.';

  if (wanted.length > 1) {
    if (wanted.some(serial => !serial))
      return 'a flowgraph with more than one PlutoSDR block must select an ' +
             'explicit Device for every block';
    if (new Set(wanted).size !== wanted.length)
      return 'one physical PlutoSDR cannot be used by more than one Source or ' +
             'Sink block at a time';
  }

  if (!unsatisfiedSerials(wanted, await authorizedPlutoDevices()).length) return null;
  try {
    await usbApi().requestDevice({ filters: PLUTOSDR_USB_FILTERS });
  } catch {
    // The chooser was dismissed, or it had nothing to offer.
  }
  const missing = unsatisfiedSerials(wanted, await refreshPlutoDevices());
  if (!missing.length) return null;

  const named = missing.filter(Boolean);
  return named.length
    ? `no PlutoSDR with serial ${named.map(serial => `"${serial}"`).join(', ')} ` +
      'is shared with this site — open the block properties and choose a device'
    : 'no PlutoSDR is shared with this site — plug one in and choose it from ' +
      'the block properties';
}

/** The PlutoSDR blocks as the editor's generic WebUSB wiring sees them. */
export const PLUTOSDR_RADIO: UsbRadio = {
  dtype: PLUTOSDR_DTYPE,
  name: 'PlutoSDR',
  filters: PLUTOSDR_USB_FILTERS,
  owns: inst => inst.id === PLUTOSDR_SOURCE_ID || inst.id === PLUTOSDR_SINK_ID,
  display: plutoDeviceDisplay,
  options: plutoDeviceOptions,
  describe: describePluto,
  refresh: refreshPlutoDevices,
  watch: watchPlutoDevices,
  prepare: preparePlutoDevices,
};
