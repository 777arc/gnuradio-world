// RTL-SDR Source's browser half: which dongles the block accepts, which of them
// this origin may already open, and the one operation that must happen under a
// user gesture. main.ts owns orchestration; the WebUSB details live here.
//
// Nothing is bound for the session the way a local file is. WebUSB permission is
// granted per origin and outlives the tab, so a .grc needs only a serial number
// and the runner's worker re-acquires the device with getDevices() — there is no
// handoff between the editor and the runner frame at all. See docs/rtlsdr.md.

import type { Inst } from './graph-model';

export const RTLSDR_ID = 'wasm_rtlsdr_source';
export const RTLSDR_DTYPE = 'rtlsdr_device';

/**
 * The USB IDs the block accepts, as librtlsdr lists them. Kept in step with
 * RTL_DEVICE_FILTERS in runner/src/rtlsdr_reader.js by a case in
 * editor/test/rtlsdr.test.mjs: the two run in different realms and cannot share
 * a module, so drift is otherwise silent — the picker would offer a dongle the
 * worker then refuses to match, and the block would fail at run time with
 * "no RTL-SDR has been shared with this site".
 */
export const RTLSDR_USB_FILTERS: { vendorId: number; productId: number }[] = [
  { vendorId: 0x0bda, productId: 0x2838 },  // Realtek RTL2838 (generic)
  { vendorId: 0x0bda, productId: 0x2832 },  // Realtek RTL2832U
  { vendorId: 0x0413, productId: 0x6680 },  // DigitalNow Quad DVB-T
  { vendorId: 0x0413, productId: 0x6f0f },  // Leadtek WinFast DTV mini D
  { vendorId: 0x0458, productId: 0x707f },  // Genius TVGo DVB-T03USB
  { vendorId: 0x0ccd, productId: 0x00a9 },  // Terratec Cinergy T Stick Black
  { vendorId: 0x0ccd, productId: 0x00b3 },  // Terratec NOXON DAB/DAB+
  { vendorId: 0x0ccd, productId: 0x00d3 },  // Terratec Cinergy T Stick RC
  { vendorId: 0x0ccd, productId: 0x00e0 },  // Terratec NOXON rev1
  { vendorId: 0x1554, productId: 0x5020 },  // PixelView PV-DT235U
  { vendorId: 0x15f4, productId: 0x0131 },  // Astrometa DVB-T
  { vendorId: 0x185b, productId: 0x0620 },  // Compro Videomate U620F
  { vendorId: 0x1b80, productId: 0xd393 },  // GIGABYTE GT-U7300
  { vendorId: 0x1d19, productId: 0x1101 },  // Dexatek DK DVB-T
  { vendorId: 0x1f4d, productId: 0xb803 },  // GTek T803
];

export type UsbLike = {
  serialNumber?: string;
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
};

/** null in Firefox and Safari, which have both declined to implement WebUSB. */
export function usbApi(): any | null {
  return (navigator as any).usb ?? null;
}

/** A Device parameter of 'fake' or 'fake:<Hz>' opens no hardware at all. */
export function isFakeDevice(serial: string): boolean {
  return serial.startsWith('fake');
}

export function matchesRtl(device: UsbLike): boolean {
  return RTLSDR_USB_FILTERS.some(
    filter => filter.vendorId === device.vendorId &&
      filter.productId === device.productId);
}

/** Serial is the identifier a .grc stores; some dongles ship without one. */
export function rtlLabel(device: UsbLike): string {
  const name = device.productName || 'RTL-SDR';
  return device.serialNumber
    ? `${name} · ${device.serialNumber}`
    : `${name} · no serial`;
}

/** Dongles already shared with this origin. Empty when WebUSB is unavailable. */
export async function authorizedRtlDevices(): Promise<UsbLike[]> {
  const usb = usbApi();
  if (!usb) return [];
  try {
    return ((await usb.getDevices()) as UsbLike[]).filter(matchesRtl);
  } catch {
    return [];
  }
}

// The canvas draws a block face synchronously, but WebUSB only answers a
// promise, so what a block shows for its device has to come from a cache. It is
// refreshed on load and whenever a dongle is plugged in or pulled out.
let sharedDevices: UsbLike[] = [];

export async function refreshRtlDevices(): Promise<UsbLike[]> {
  sharedDevices = await authorizedRtlDevices();
  return sharedDevices;
}

/**
 * What a block face shows for a device parameter. An empty parameter means
 * "first available", which is the portable default -- a .grc pinned to one
 * dongle's serial will not run on anyone else's machine -- so rather than
 * writing a serial into the flowgraph, name the dongle it currently resolves
 * to. A block that reads simply blank is what prompted this.
 */
export function deviceDisplay(serial: string): string {
  const value = serial.trim();
  if (value) return value;
  const first = sharedDevices[0];
  if (!first) return 'first available';
  return `first available · ${first.serialNumber || first.productName || 'RTL-SDR'}`;
}

/** Keeps the cache current, calling `onChange` whenever the device set moves. */
export function watchRtlDevices(onChange: () => void): void {
  const usb = usbApi();
  if (!usb) return;
  const update = () => { void refreshRtlDevices().then(onChange); };
  usb.addEventListener?.('connect', update);
  usb.addEventListener?.('disconnect', update);
  update();
}

/** The serials the flowgraph's active RTL-SDR blocks need, '' meaning any. */
export function requiredRtlSerials(blocks: Inst[]): string[] {
  const wanted = new Set<string>();
  for (const block of blocks) {
    if (block.id !== RTLSDR_ID || !block.enabled || block.bypassed) continue;
    const serial = String(block.params?.device ?? '').trim();
    if (!isFakeDevice(serial)) wanted.add(serial);
  }
  return [...wanted];
}

/** Which of `wanted` no currently-shared device satisfies. */
export function unsatisfiedSerials(
  wanted: string[], available: UsbLike[]): string[] {
  return wanted.filter(serial => serial
    ? !available.some(device => device.serialNumber === serial)
    : available.length === 0);
}

/**
 * Ensures the flowgraph's RTL-SDR blocks have a device to open, prompting if
 * they do not. Must be called from a user gesture: requestDevice() needs one,
 * and neither a GNU Radio constructor nor the reader worker has one — which is
 * why this runs on the Run click rather than anywhere later.
 *
 * @returns a message to report, or null when everything is in place.
 */
export async function prepareRtlDevices(blocks: Inst[]): Promise<string | null> {
  const wanted = requiredRtlSerials(blocks);
  if (!wanted.length) return null;
  if (!usbApi())
    return 'RTL-SDR Source needs WebUSB, which only Chromium-based browsers ' +
           '(Chrome, Edge, Opera) provide. Firefox and Safari cannot run it.';

  if (!unsatisfiedSerials(wanted, await authorizedRtlDevices()).length) return null;
  try {
    await usbApi().requestDevice({ filters: RTLSDR_USB_FILTERS });
  } catch {
    // The chooser was dismissed, or it had nothing to offer.
  }
  const missing = unsatisfiedSerials(wanted, await authorizedRtlDevices());
  if (!missing.length) return null;

  const named = missing.filter(Boolean);
  return named.length
    ? `no RTL-SDR with serial ${named.map(s => `"${s}"`).join(', ')} is ` +
      'shared with this site — open the block\'s properties and choose a device'
    : 'no RTL-SDR is shared with this site — plug one in and choose it from ' +
      'the block\'s properties';
}
