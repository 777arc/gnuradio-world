// RTL-SDR Source's browser half: which dongles the block accepts, which of them
// this origin may already open, and the one operation that must happen under a
// user gesture. main.ts owns orchestration, ./usb-radio owns what this shares
// with the other WebUSB radios, and the RTL-SDR specifics live here. See
// docs/rtlsdr.md.

import type { Inst } from './graph-model';
import {
  isFakeDevice,
  unsatisfiedSerials,
  usbApi,
  type UsbFilter,
  type UsbLike,
  type UsbPreparationProblem,
  type UsbRadio,
} from './usb-radio';

export { isFakeDevice, unsatisfiedSerials, usbApi };
export type { UsbLike };

export const RTLSDR_ID = 'wasm_rtlsdr_source';
export const RTLSDR_DTYPE = 'rtlsdr_device';

export const RTLSDR_DRIVER_PROBLEM = {
  title: 'RTL-SDR device driver required',
  message: 'GNU Radio World can see this RTL-SDR, but the browser cannot ' +
    'claim its USB interface. Install and configure the device driver before ' +
    'continuing. On Windows, use Zadig to install the WinUSB driver. On Linux, ' +
    'detach or blacklist dvb_usb_rtl28xxu and make sure your user can access ' +
    'USB devices. Also close any other application using the RTL-SDR.',
};

/**
 * The USB IDs the block accepts, as librtlsdr lists them. Kept in step with
 * RTL_DEVICE_FILTERS in runner/src/rtlsdr_reader.js by a case in
 * editor/test/rtlsdr.test.mjs: the two run in different realms and cannot share
 * a module, so drift is otherwise silent — the picker would offer a dongle the
 * worker then refuses to match, and the block would fail at run time with
 * "no RTL-SDR has been shared with this site".
 */
export const RTLSDR_USB_FILTERS: UsbFilter[] = [
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

/**
 * Proves that WebUSB can get past host-driver ownership before a runner starts.
 * The chooser can enumerate and grant an RTL-SDR on Windows even when WinUSB
 * is not installed; only open/configure/claim exposes that unusable binding.
 */
export async function rtlDriverProblem(
  device: UsbLike,
): Promise<UsbPreparationProblem | null> {
  const usbDevice = device as any;
  const openedHere = !usbDevice.opened;
  let claimed = false;
  try {
    if (openedHere) await usbDevice.open();
    if (!usbDevice.configuration) await usbDevice.selectConfiguration(1);
    await usbDevice.claimInterface(0);
    claimed = true;
    return null;
  } catch {
    return { ...RTLSDR_DRIVER_PROBLEM };
  } finally {
    if (claimed) {
      try { await usbDevice.releaseInterface(0); } catch { /* close releases it too */ }
    }
    if (openedHere) {
      try { await usbDevice.close(); } catch { /* the probe is already finished */ }
    }
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

/**
 * The Device dropdown's options, in order. "First available" is the portable
 * default -- a flowgraph pinned to one dongle's serial will not run on anyone
 * else's -- so the empty value stays a real choice rather than being silently
 * replaced by a serial; what it currently resolves to is spelled out instead.
 */
export function deviceOptions(
  serial: string, shared: UsbLike[]): { value: string; label: string }[] {
  const options = [{
    value: '',
    label: shared.length
      ? `First available — ${rtlLabel(shared[0])}`
      : 'First available',
  }];
  for (const device of shared)
    if (device.serialNumber)
      options.push({ value: device.serialNumber, label: rtlLabel(device) });
  // A serial the browser cannot see right now still belongs in the list, or
  // opening the dialog would silently repoint the block at a dongle the reader
  // never chose.
  if (serial && !shared.some(d => d.serialNumber === serial))
    options.push({
      value: serial,
      label: isFakeDevice(serial)
        ? `${serial} — test signal generator`
        : `${serial} — not connected`,
    });
  return options;
}

/**
 * The line under the Device field, saying what this value will actually open.
 * Kept beside deviceOptions() rather than in the dialog: it is the same "which
 * dongle does this resolve to" question deviceDisplay() answers for the canvas.
 * `hasUsb` is passed rather than read from navigator so this stays a pure
 * function of what the dialog can see.
 */
export function describeDevice(
  serial: string, shared: UsbLike[], hasUsb = !!usbApi()): string {
  if (isFakeDevice(serial))
    return 'Test signal generator — no hardware is opened. Used by the ' +
           'runner\'s own tests.';
  if (!hasUsb)
    return 'This browser has no WebUSB, so no device can be chosen here. ' +
           'Chrome, Edge and Opera can run this block.';
  if (!shared.length)
    return 'No RTL-SDR shared with this site yet — click Add, or just press ' +
           'Run and the browser will ask.';
  if (!serial)
    return `Uses ${rtlLabel(shared[0])}` +
           (shared.length > 1
             ? ` — first of ${shared.length} shared with this site`
             : '') +
           '. Leaving this on "first available" keeps the flowgraph portable.';
  const match = shared.find(d => d.serialNumber === serial);
  return match
    ? `Connected · ${rtlLabel(match)}`
    : `"${serial}" is not shared with this site right now — plug it in, ` +
      'or click Add.';
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

/**
 * Ensures the flowgraph's RTL-SDR blocks have a device to open, prompting if
 * they do not. Must be called from a user gesture: requestDevice() needs one,
 * and neither a GNU Radio constructor nor the reader worker has one — which is
 * why this runs on the Run click rather than anywhere later.
 *
 * @returns a message to report, or null when everything is in place.
 */
export async function prepareRtlDevices(
  blocks: Inst[],
): Promise<UsbPreparationProblem | null> {
  const wanted = requiredRtlSerials(blocks);
  if (!wanted.length) return null;
  if (!usbApi())
    return 'RTL-SDR Source needs WebUSB, which only Chromium-based browsers ' +
           '(Chrome, Edge, Opera) provide. Firefox and Safari cannot run it.';

  let available = await authorizedRtlDevices();
  if (unsatisfiedSerials(wanted, available).length) {
    try {
      await usbApi().requestDevice({ filters: RTLSDR_USB_FILTERS });
    } catch {
      // The chooser was dismissed, or it had nothing to offer.
    }
    available = await authorizedRtlDevices();
  }
  const missing = unsatisfiedSerials(wanted, available);
  if (!missing.length) {
    const devices = [...new Set(wanted.map(serial => serial
      ? available.find(device => device.serialNumber === serial)
      : available[0]).filter((device): device is UsbLike => !!device))];
    for (const device of devices) {
      const problem = await rtlDriverProblem(device);
      if (problem) return problem;
    }
    return null;
  }

  const named = missing.filter(Boolean);
  return named.length
    ? `no RTL-SDR with serial ${named.map(s => `"${s}"`).join(', ')} is ` +
      'shared with this site — open the block\'s properties and choose a device'
    : 'no RTL-SDR is shared with this site — plug one in and choose it from ' +
      'the block\'s properties';
}

/** RTL-SDR Source as the editor's generic WebUSB wiring sees it. */
export const RTLSDR_RADIO: UsbRadio = {
  dtype: RTLSDR_DTYPE,
  name: 'RTL-SDR',
  filters: RTLSDR_USB_FILTERS,
  owns: inst => inst.id === RTLSDR_ID,
  display: deviceDisplay,
  options: deviceOptions,
  describe: describeDevice,
  refresh: refreshRtlDevices,
  watch: watchRtlDevices,
  prepare: prepareRtlDevices,
};
