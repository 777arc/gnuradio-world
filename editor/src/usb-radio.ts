// What every WebUSB radio block looks like to the editor, so the canvas, the
// Properties dialog and the Run click can wire one up without knowing which
// radio it is. The per-radio wording, device tables and ownership rules stay in
// ./rtlsdr and ./plutosdr; what is here is the shape they share, plus the two
// WebUSB primitives neither of them should own a private copy of.
//
// Nothing is bound for the session the way a local file is. WebUSB permission
// is granted per origin and outlives the tab, so a .grc needs only a serial
// number and the runner's worker re-acquires the device with getDevices() --
// there is no handoff between the editor and the runner frame at all.

import type { Inst } from './graph-model';

export type UsbLike = {
  serialNumber?: string;
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
};

export type UsbFilter = { vendorId: number; productId: number };

export type DeviceOption = { value: string; label: string };

/** A run-stopping problem that deserves a modal rather than console text alone. */
export type UsbPreparationProblem = string | {
  title: string;
  message: string;
};

/** null in Firefox and Safari, which have both declined to implement WebUSB. */
export function usbApi(): any | null {
  return (navigator as any).usb ?? null;
}

/**
 * A Device parameter of 'fake' or 'fake:<Hz>' opens no hardware at all. Spelled
 * exactly as the workers spell it (`isFake` in rtlsdr_reader.js, `fake` in
 * plutosdr_worker.js): a looser test here would skip the permission prompt for
 * a serial the worker then went looking for on real hardware.
 */
export function isFakeDevice(serial: string): boolean {
  return serial === 'fake' || serial.startsWith('fake:');
}

/** Which of `wanted` no currently-shared device satisfies. '' means any. */
export function unsatisfiedSerials(
  wanted: string[], available: UsbLike[]): string[] {
  return wanted.filter(serial => serial
    ? !available.some(device => device.serialNumber === serial)
    : available.length === 0);
}

/** One family of WebUSB radio blocks, as the editor's generic wiring sees it. */
export type UsbRadio = {
  /** The parameter dtype that turns a field into this radio's device picker. */
  dtype: string;
  /** How the radio is named in the dialog's own text. */
  name: string;
  filters: UsbFilter[];
  /** Whether a block on the canvas is one of this radio's. */
  owns(inst: Inst): boolean;
  /** What a block face shows for a device parameter, drawn from the cache. */
  display(serial: string): string;
  /** The Device dropdown's options, in order. */
  options(serial: string, shared: UsbLike[]): DeviceOption[];
  /** The line under the Device field: what this value will actually open. */
  describe(serial: string, shared: UsbLike[]): string;
  /** Refreshes the shared cache `display` draws from, and returns it. */
  refresh(): Promise<UsbLike[]>;
  /** Calls back whenever the set of shared devices moves. */
  watch(onChange: () => void): void;
  /** Read-only check: whether prepare() would need a requestDevice() gesture. */
  needsGesture(blocks: Inst[]): Promise<boolean>;
  /**
   * Obtains any permission the flowgraph's blocks are missing, and returns a
   * message when the run cannot go ahead. Must be called from a user gesture.
   */
  prepare(blocks: Inst[]): Promise<UsbPreparationProblem | null>;
};
