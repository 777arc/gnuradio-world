// Browser-side device selection for the PlutoSDR Source and Sink. The .grc
// stores only a USB serial number; the runner worker re-acquires the device
// from the origin's persistent WebUSB permission and owns it for the run.

import type { Inst } from './graph-model';
import { usbApi, type UsbLike } from './rtlsdr';

export const PLUTOSDR_SOURCE_ID = 'wasm_plutosdr_source';
export const PLUTOSDR_SINK_ID = 'wasm_plutosdr_sink';
export const PLUTOSDR_DTYPE = 'plutosdr_device';
export const PLUTOSDR_USB_FILTERS = [{ vendorId: 0x0456, productId: 0xb673 }];

export function isFakePluto(serial: string): boolean {
  return serial === 'fake' || serial.startsWith('fake:');
}

export function matchesPluto(device: UsbLike): boolean {
  return PLUTOSDR_USB_FILTERS.some(filter =>
    filter.vendorId === device.vendorId && filter.productId === device.productId);
}

export function plutoLabel(device: UsbLike): string {
  const name = device.productName || 'ADALM-PLUTO';
  return device.serialNumber
    ? `${name} · ${device.serialNumber}`
    : `${name} · no serial`;
}

export async function authorizedPlutoDevices(): Promise<UsbLike[]> {
  const usb = usbApi();
  if (!usb) return [];
  try {
    return ((await usb.getDevices()) as UsbLike[]).filter(matchesPluto);
  } catch {
    return [];
  }
}

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
  serial: string, shared: UsbLike[]): { value: string; label: string }[] {
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
      label: isFakePluto(serial)
        ? `${serial} — test signal generator`
        : `${serial} — not connected`,
    });
  return options;
}

export function describePluto(
  serial: string, shared: UsbLike[], hasUsb = !!usbApi()): string {
  if (isFakePluto(serial))
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

function activePlutoBlocks(blocks: Inst[]): Inst[] {
  return blocks.filter(block =>
    (block.id === PLUTOSDR_SOURCE_ID || block.id === PLUTOSDR_SINK_ID) &&
    block.enabled && !block.bypassed);
}

/**
 * Enforces the current ownership model and obtains any missing WebUSB grant.
 * Separate real Plutos may run together, but one physical device cannot be
 * shared between workers. A future full-duplex block can coordinate both pipes.
 */
export async function preparePlutoDevices(blocks: Inst[]): Promise<string | null> {
  const active = activePlutoBlocks(blocks);
  const real = active.map(block => String(block.params?.device ?? '').trim())
    .filter(serial => !isFakePluto(serial));
  if (!real.length) return null;
  if (!usbApi())
    return 'PlutoSDR blocks need WebUSB, which only Chromium-based browsers ' +
           '(Chrome, Edge, Opera) provide. Firefox and Safari cannot run them.';

  if (real.length > 1) {
    if (real.some(serial => !serial))
      return 'a flowgraph with more than one PlutoSDR block must select an ' +
             'explicit Device for every block';
    if (new Set(real).size !== real.length)
      return 'one physical PlutoSDR cannot be used by more than one Source or ' +
             'Sink block at a time';
  }

  const available = await authorizedPlutoDevices();
  const missing = real.filter(serial => serial
    ? !available.some(device => device.serialNumber === serial)
    : available.length === 0);
  if (!missing.length) return null;
  try {
    await usbApi().requestDevice({ filters: PLUTOSDR_USB_FILTERS });
  } catch {
    // The chooser was dismissed or contained no Pluto.
  }
  const after = await refreshPlutoDevices();
  const stillMissing = real.filter(serial => serial
    ? !after.some(device => device.serialNumber === serial)
    : after.length === 0);
  if (!stillMissing.length) return null;
  const named = stillMissing.filter(Boolean);
  return named.length
    ? `no PlutoSDR with serial ${named.map(serial => `"${serial}"`).join(', ')} ` +
      'is shared with this site — open the block properties and choose a device'
    : 'no PlutoSDR is shared with this site — plug one in and choose it from ' +
      'the block properties';
}
