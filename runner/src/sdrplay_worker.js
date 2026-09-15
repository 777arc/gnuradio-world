// WebUSB producer for the browser-only SDRplay RSP1A block.
//
// An RSP1A (and the RSP1 and RSP1B) is a Mirics MSi2500 USB bridge/ADC in front
// of an MSi001 tuner. SDRplay's own API is closed, but the chip protocol is not:
// everything below is ported from libmirisdr-5 (Miroslav Slugen, Leif Asbrink,
// Edouard Griffiths and others, GPL-2.0-or-later,
// https://github.com/ericek111/libmirisdr-5), cross-checked against the Linux
// kernel's msi2500/msi001 drivers. GNU Radio World is GPL-3.0, so that is
// compatible; keep this notice when moving the protocol code.
//
// WebUSB owns the asynchronous USB side; GNU Radio's synchronous scheduler sees
// only a shared-memory ring of int16 IQ pairs and a seqlock command mailbox,
// exactly as the HackRF worker does. See docs/sdrplay.md.
//
// Everything above `const encoder = new TextEncoder();` is pure arithmetic and
// is evaluated on plain Node by runner/test/sdrplay_worker.test.mjs, so keep
// WebUSB, Worker and shared-memory code below that line.

// Reported in the 'device' message so a hardware report says which worker ran.
const WORKER_VERSION = 4;

const CTRL = {
  READ_POS: 0,
  WRITE_POS: 1,
  STATE: 2,
  ERROR_LENGTH: 3,
  EVENTS: 4,
  LOST_SAMPLES: 5,
  ACTUAL_RATE: 6,
  CMD_SEQ: 7,
  CMD_ACK: 8,
  FREQ_HI: 9,
  FREQ_LO: 10,
  SAMPLE_RATE: 11,
  BANDWIDTH: 12,
  GAIN: 13,
  FLAGS: 14,
  MODEL: 15,
};
const CTRL_WORDS = 16;

const RUNNING = 1;
const ERROR = 2;
const CANCELLED = 3;
const FLAG_BIAS_TEE = 1 << 0;
const FLAG_FM_NOTCH = 1 << 1;
const FLAG_DAB_NOTCH = 1 << 2;

// Kept in step with SDRPLAY_USB_FILTERS in editor/src/sdrplay.ts by
// editor/test/sdrplay.test.mjs. None of these carries a USB serial string.
const SDRPLAY_DEVICES = [
  { vendorId: 0x1df7, productId: 0x3000, name: 'SDRplay RSP1A', model: 0x3000 },
  { vendorId: 0x1df7, productId: 0x3050, name: 'SDRplay RSP1B', model: 0x3050 },
  { vendorId: 0x1df7, productId: 0x2500, name: 'SDRplay RSP1', model: 0x2500 },
];

const TRANSFER_DEPTH = 4;
const FRAME_BYTES = 1024;
const FRAME_HEADER = 16;
const FRAME_PAYLOAD = FRAME_BYTES - FRAME_HEADER;
const USB_PACKET = 512;
const MAX_TRANSFER = 1024 * 1024;

const MIN_RATE = 1300000;
const MAX_RATE = 12096000;
const MIN_FREQ = 10000;
const MAX_FREQ = 2000000000;
const MAX_GAIN = 102;

// MSi2500 vendor requests. Register writes pack a 24-bit value around the
// register number: wValue = (val & 0xff) << 8 | reg, wIndex = val >> 8.
const CMD_WREG = 0x41;
const CMD_START_STREAMING = 0x43;
const CMD_STOP_STREAMING = 0x45;

// The four ways the MSi2500 packs samples into a 1024-byte USB frame, chosen by
// sample rate: more bits per sample while the USB budget allows it. Each row is
// the register-7 word, the IQ pairs per frame (which is also how far the
// frame's sample counter advances) and the AGC nibble of register 3.
const FORMATS = [
  { name: '252_S16', maxRate: 6048000, reg7: 0x000094, pairs: 252, agc: 0x1, bits: 14 },
  { name: '336_S16', maxRate: 8064000, reg7: 0x000085, pairs: 336, agc: 0x5, bits: 12 },
  { name: '384_S16', maxRate: 9216000, reg7: 0x0000a5, pairs: 384, agc: 0x9, bits: 10 },
  { name: '504_S16', maxRate: Infinity, reg7: 0x000c94, pairs: 504, agc: 0xd, bits: 8 },
];

function formatForRate(rate) {
  return FORMATS.find(format => rate <= format.maxRate);
}

// MSi001 IF filter widths, in register-0 order (bits 14-16). Only zero-IF is
// used, so the narrow ones are simply narrow filters around the LO.
const BANDWIDTHS = [200000, 300000, 600000, 1536000, 5000000, 6000000, 7000000, 8000000];

function automaticBandwidth(sampleRate) {
  let selected = BANDWIDTHS[0];
  for (const bandwidth of BANDWIDTHS) if (bandwidth <= sampleRate) selected = bandwidth;
  return selected;
}

// libmirisdr's "SDRplay" frequency plan: which MSi001 input path handles a
// band, the LO divider for that path, and the register-8 word that drives the
// MSi2500's GPIOs -- the RSP's front-end filter and notch switches. The GPIO
// mapping was verified on an RSP1A only as far as docs/sdrplay.md says.
const MODE_AM = 0x01;
const MODE_VHF = 0x02;
const MODE_B3 = 0x04;
const MODE_B45 = 0x08;
const MODE_BL = 0x10;
const MODE_HIDDEN = 0x06;   // 261-404 MHz, undocumented but streams

const FREQUENCY_PLAN = [
  { lowCut: 0e6, mode: MODE_AM, upconvert: 1, amPort: 1, loDiv: 16, band: 0xf580 },
  { lowCut: 12e6, mode: MODE_AM, upconvert: 1, amPort: 1, loDiv: 16, band: 0xf580 },
  { lowCut: 30e6, mode: MODE_AM, upconvert: 1, amPort: 1, loDiv: 16, band: 0xf580 },
  { lowCut: 50e6, mode: MODE_VHF, upconvert: 0, amPort: 0, loDiv: 32, band: 0xf180 },
  { lowCut: 112e6, mode: MODE_B3, upconvert: 0, amPort: 0, loDiv: 16, band: 0xf580 },
  { lowCut: 250e6, mode: MODE_B3, upconvert: 0, amPort: 0, loDiv: 16, band: 0xf480 },
  { lowCut: 261e6, mode: MODE_HIDDEN, upconvert: 0, amPort: 0, loDiv: 8, band: 0xf480 },
  { lowCut: 404e6, mode: MODE_B45, upconvert: 0, amPort: 0, loDiv: 4, band: 0xf580 },
  { lowCut: 1000e6, mode: MODE_BL, upconvert: 0, amPort: 0, loDiv: 2, band: 0xf580 },
];

// Register-8 GPIO bits, in the 24-bit register value (val >> 8 is the GPIO
// byte). BIAS is libmirisdr's; the two notches follow its GPIO comments.
const GPIO_DAB_NOTCH = 1 << 8;
const GPIO_FM_NOTCH = 1 << 10;
const GPIO_BIAS_TEE = 1 << 11;

function planFor(frequency) {
  let plan = FREQUENCY_PLAN[0];
  for (const entry of FREQUENCY_PLAN) if (frequency >= entry.lowCut) plan = entry;
  return plan;
}

// libmirisdr's mirisdr_set_hard(): the ADC/USB sample-rate registers 3 and 4.
function rateRegisters(rate) {
  const format = formatForRate(rate);
  let i = 4;
  let vco = 0;
  for (; i < 16; i += 2) {
    vco = rate * i * 12;
    if (vco >= 202000000) break;
  }
  const n = Math.floor(vco / 48000000);
  const fract = Math.floor(0x200000 * (vco % 48000000) / 48000000);
  let reg3 = 0;
  reg3 |= 0x03;
  reg3 |= (0x07 & (i / 2 - 1)) << 2;
  reg3 |= (0x01 & (fract >> 20)) << 7;
  reg3 |= (0x0f & n) << 8;
  reg3 |= (0x0f & format.agc) << 12;
  reg3 |= 1 << 16;
  const reg4 = fract & 0xfffff;
  return { format, reg3: reg3 >>> 0, reg4 };
}

// libmirisdr's mirisdr_set_soft(): the MSi001 synthesiser and mode words for a
// centre frequency, plus the register-8 GPIO word. Integer arithmetic in
// BigInt because 96e6 * n * thresh * 4096 overflows a double's mantissa.
function tuningRegisters(frequency, bandwidthHz, flags = 0) {
  const plan = planFor(frequency);
  let reg0 = 0;
  let offset = 0;
  let loDiv;
  let amBand = false;
  if (plan.mode === MODE_AM) {
    reg0 |= MODE_AM << 4;
    reg0 |= plan.upconvert << 9;
    reg0 |= plan.amPort << 11;
    if (plan.upconvert) offset += 120000000;
    loDiv = 16;
    amBand = true;
  } else {
    reg0 |= plan.mode << 4;
    loDiv = plan.loDiv;
  }
  reg0 |= 1 << 10;                          // RF synthesiser on
  reg0 |= 3 << 12;                          // zero IF
  const bwIndex = Math.max(0, BANDWIDTHS.indexOf(bandwidthHz));
  reg0 |= bwIndex << 14;
  reg0 |= 2 << 17;                          // 24 MHz crystal
  // IF and VCO low-power modes: normal (0).

  const REF = 96000000n;
  const target = BigInt(frequency + offset);
  const div = BigInt(loDiv);
  const fvco = target * div;
  const n = fvco / REF;
  let thresh = REF / div;
  let frac = (fvco % REF) / div;
  let a = thresh;
  let b = frac;
  while (a !== 0n) { const c = a; a = b % a; b = c; }
  thresh /= b;
  frac /= b;
  const scale = (thresh + 4094n) / 4095n;
  thresh = (thresh + scale / 2n) / scale;
  frac = (frac + scale / 2n) / scale;
  const denominator = thresh * 4096n * div;
  let rfvco = (REF * (n * thresh * 4096n + frac * 4096n)) / denominator;
  if (target < rfvco && frac > 0n) frac -= 1n;
  rfvco = (REF * (n * thresh * 4096n + frac * 4096n)) / denominator;
  let afc = target > rfvco ? ((target - rfvco) * denominator) / REF : 0n;

  const reg3 = 3 | (Number(afc & 4095n) << 4);
  const reg5 = 5 | (Number(thresh & 0xfffn) << 4) | (0x28 << 16);
  const reg2 = 2 | (Number(frac & 0xfffn) << 4) | (Number(n & 0x3fn) << 16);
  const regd = 0x0d;
  let reg8 = plan.band;
  if (flags & FLAG_BIAS_TEE) reg8 |= GPIO_BIAS_TEE;
  if (flags & FLAG_FM_NOTCH) reg8 |= GPIO_FM_NOTCH;
  if (flags & FLAG_DAB_NOTCH) reg8 |= GPIO_DAB_NOTCH;
  // What the synthesiser actually lands on, for diagnostics.
  const actual = Number((REF * (n * thresh * 4096n + frac * 4096n + afc)) / denominator) - offset;
  return {
    reg8, reg0: reg0 >>> 0, reg3, reg5, reg2, regd, amBand,
    plan, actualFrequency: actual,
  };
}

// libmirisdr's mirisdr_set_tuner_gain() + mirisdr_set_gain(): one 0-102 dB
// "gain" spread over the MSi001's LNA, mixer and baseband attenuators, then
// the register-1 gain word and the register-6 DC-calibration word.
function gainRegisters(gain, amBand) {
  const g = Math.min(MAX_GAIN, Math.max(0, Math.round(gain)));
  let lna;
  let mixbuffer;
  let mixer;
  let baseband;
  if (g >= 43) {
    lna = 0; mixbuffer = 0; mixer = 0; baseband = 59 - (g - 43);
  } else if (g >= 19) {
    lna = 1; mixbuffer = 3; mixer = 0; baseband = 59 - (g - 19);
  } else {
    lna = 1; mixbuffer = 3; mixer = 1; baseband = 59 - g;
  }
  let reg1 = 1;
  reg1 |= baseband << 4;
  // The RSP's AM input is port 2: the up-converter buffer is either 0 or 24 dB.
  if (amBand) reg1 |= (mixbuffer === 0 ? 0 : 3) << 10;
  reg1 |= mixer << 12;
  if (!amBand) reg1 |= lna << 13;
  reg1 |= 2 << 14;                          // DC calibration: periodic 2
  const reg6 = 6 | (0x1f << 4) | (0x800 << 10);   // track 0x1f, period 0x800
  return { reg1: reg1 >>> 0, reg6: reg6 >>> 0, lna, mixer, baseband };
}

// One 1024-byte frame: u32 LE sample counter, 12 junk bytes, 1008 payload
// bytes. Returns IQ pairs as int16, I then Q, full-scale left-aligned.
function unpackFrame(format, frame, out, outOffset) {
  const p = FRAME_HEADER;
  let o = outOffset;
  switch (format.pairs) {
  case 252:
    for (let j = 0; j < FRAME_PAYLOAD; j += 4) {
      out[o++] = ((frame[p + j] << 2) | (frame[p + j + 1] << 10)) << 16 >> 16;
      out[o++] = ((frame[p + j + 2] << 2) | (frame[p + j + 3] << 10)) << 16 >> 16;
    }
    break;
  case 336:
    for (let j = 0; j < FRAME_PAYLOAD; j += 3) {
      out[o++] = ((frame[p + j] << 4) | ((frame[p + j + 1] & 0x0f) << 12)) << 16 >> 16;
      out[o++] = ((frame[p + j + 1] & 0xf0) | (frame[p + j + 2] << 8)) << 16 >> 16;
    }
    break;
  case 384: {
    let s = p;
    for (let block = 0; block < 6; ++block, s += 4) {
      const shift = frame[s + 160] | (frame[s + 161] << 8) |
        (frame[s + 162] << 16) | (frame[s + 163] << 24);
      for (let k = 0; k < 16; ++k, s += 10) {
        const v = [
          (frame[s] << 6) | ((frame[s + 1] & 0x03) << 14),
          ((frame[s + 1] & 0xfc) << 4) | ((frame[s + 2] & 0x0f) << 12),
          ((frame[s + 2] & 0xf0) << 2) | ((frame[s + 3] & 0x3f) << 10),
          (frame[s + 3] & 0xc0) | (frame[s + 4] << 8),
          (frame[s + 5] << 6) | ((frame[s + 6] & 0x03) << 14),
          ((frame[s + 6] & 0xfc) << 4) | ((frame[s + 7] & 0x0f) << 12),
          ((frame[s + 7] & 0xf0) << 2) | ((frame[s + 8] & 0x3f) << 10),
          (frame[s + 8] & 0xc0) | (frame[s + 9] << 8),
        ];
        const code = (shift >>> (2 * k)) & 0x3;
        const right = code === 0 ? 2 : code === 1 ? 1 : 0;
        for (let m = 0; m < 8; ++m) out[o++] = (v[m] << 16 >> 16) >> right;
      }
    }
    break;
  }
  default:
    for (let j = 0; j < FRAME_PAYLOAD; j += 2) {
      out[o++] = (frame[p + j] << 8) << 16 >> 16;
      out[o++] = (frame[p + j + 1] << 8) << 16 >> 16;
    }
  }
  return o - outOffset;
}

function frameCounter(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

// Splits one bulk transfer into frames, unpacks them and accounts for gaps in
// the sample counter. `state.expected` is the counter the next frame should
// carry, or null before the first frame. Bulk data arrives in whole 512-byte
// USB packets, so a transfer that does not start on a frame boundary is off by
// exactly one packet; the caller then reads 512 bytes to realign.
function unpackTransfer(format, bytes, state, out) {
  const frames = Math.floor(bytes.byteLength / FRAME_BYTES);
  let produced = 0;
  let lost = 0;
  let misaligned = 0;
  for (let i = 0; i < frames; ++i) {
    const frame = bytes.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
    const counter = frameCounter(frame, 0);
    if (state.expected !== null && counter !== state.expected) {
      const gap = (counter - state.expected) >>> 0;
      // A counter that runs backwards, or jumps by something that is not a
      // whole number of frames, is not a dropped frame: the frame boundary
      // has slipped by a USB packet.
      if (gap % format.pairs !== 0 || gap > format.pairs * 65536) ++misaligned;
      else lost += gap;
    }
    state.expected = (counter + format.pairs) >>> 0;
    produced += unpackFrame(format, frame, out, produced);
  }
  return { produced, lost, misaligned, frames };
}

// The inverse of unpackFrame, used by the fake device and the unit test.
function packPair(format, frame, base, pair, i, q) {
  const ui = i & ((1 << format.bits) - 1);
  const uq = q & ((1 << format.bits) - 1);
  switch (format.pairs) {
  case 252: {
    const o = base + pair * 4;
    frame[o] = ui & 0xff; frame[o + 1] = ui >> 8;
    frame[o + 2] = uq & 0xff; frame[o + 3] = uq >> 8;
    break;
  }
  case 336: {
    const o = base + pair * 3;
    frame[o] = ui & 0xff;
    frame[o + 1] = ((ui >> 8) & 0x0f) | ((uq & 0x0f) << 4);
    frame[o + 2] = uq >> 4;
    break;
  }
  case 384: {
    // 6 blocks of 16 groups of 8 samples, then the block's shift word.
    const sample = pair * 2;
    const block = Math.floor(sample / 128);
    const within = sample % 128;
    const group = Math.floor(within / 8);
    const slot = within % 8;
    const o = base + block * 164 + group * 10;
    const packed = [ui, uq];
    for (let m = 0; m < 2; ++m) {
      const s = slot + m;
      const v = packed[m] & 0x3ff;
      const half = s < 4 ? 0 : 5;
      const idx = s % 4;
      const bit = idx * 10;
      const byte = half + (bit >> 3);
      const shift = bit & 7;
      frame[o + byte] |= (v << shift) & 0xff;
      frame[o + byte + 1] |= (v >> (8 - shift)) & 0xff;
    }
    // Shift code 2: no shift, samples are used as packed.
    if (within === 0) {
      const s = base + block * 164 + 160;
      frame[s] = 0xaa; frame[s + 1] = 0xaa; frame[s + 2] = 0xaa; frame[s + 3] = 0xaa;
    }
    break;
  }
  default: {
    const o = base + pair * 2;
    frame[o] = ui & 0xff; frame[o + 1] = uq & 0xff;
  }
  }
}

const encoder = new TextEncoder();
const recent = [];
const startedAt = performance.now();
let debugTrace = false;
let activeUsb = null;
let stopRequested = null;
const stopSignal = new Promise(resolve => { stopRequested = resolve; });

function record(text) {
  const line = `${(performance.now() - startedAt).toFixed(1).padStart(8)}ms ${text}`;
  recent.push(line);
  if (recent.length > 64) recent.shift();
  if (debugTrace) postMessage({ type: 'trace', text: line });
}

function control(data) {
  return new Int32Array(data.memory.buffer, data.controlPointer, CTRL_WORDS);
}

function ring(data) {
  return new Int16Array(data.memory.buffer, data.ringPointer, data.capacityPairs * 2);
}

function usedPairs(data) {
  const read = Atomics.load(control(data), CTRL.READ_POS);
  const write = Atomics.load(control(data), CTRL.WRITE_POS);
  return write >= read ? write - read : data.capacityPairs - (read - write);
}

function cancelled(data) {
  return Atomics.load(control(data), CTRL.STATE) === CANCELLED;
}

function fail(data, error) {
  const message = String(error instanceof Error ? error.message : error);
  try {
    const bytes = encoder.encode(message);
    const length = Math.min(bytes.byteLength, data.errorCapacity - 1);
    new Uint8Array(data.memory.buffer, data.errorPointer, data.errorCapacity).fill(0);
    new Uint8Array(data.memory.buffer, data.errorPointer, length)
      .set(bytes.subarray(0, length));
    Atomics.store(control(data), CTRL.ERROR_LENGTH, length);
    Atomics.store(control(data), CTRL.STATE, ERROR);
    Atomics.notify(control(data), CTRL.READ_POS);
    Atomics.notify(control(data), CTRL.WRITE_POS);
  } catch {
    // The runner may already be unloading.
  }
  postMessage({ type: 'error', message, recent: [...recent] });
  close();
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class Msi2500Usb {
  constructor(device, info) {
    this.device = device;
    this.info = info;
    this.interfaceNumber = 0;
    this.input = 1;
    this.closed = false;
    this.streaming = false;
  }

  static async open(device, info) {
    const usb = new Msi2500Usb(device, info);
    try {
      await usb.open();
      return usb;
    } catch (error) {
      await usb.close();
      throw error;
    }
  }

  async open() {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const iface = this.device.configuration.interfaces[0];
    const bulk = iface.alternates.find(alternate => alternate.endpoints.some(endpoint =>
      endpoint.type === 'bulk' && endpoint.direction === 'in'));
    if (!bulk) throw new Error(`${this.info.name} has no bulk input alternate setting`);
    this.interfaceNumber = iface.interfaceNumber;
    this.bulkAlternate = bulk.alternateSetting;
    this.input = bulk.endpoints.find(endpoint =>
      endpoint.type === 'bulk' && endpoint.direction === 'in').endpointNumber;
    await this.device.claimInterface(this.interfaceNumber);
    // libmirisdr resets the device on open: "otherwise it sometimes refuses to
    // communicate". A reset does not drop the WebUSB permission.
    try {
      await this.device.reset();
      record('device reset');
    } catch (error) {
      record(`device reset skipped: ${error.message}`);
    }
    await this.command(CMD_STOP_STREAMING);
    await this.writeReg(0x03, 0x010000);            // ADC and USB interface asleep
    // ADC initialisation, verbatim from libmirisdr / the kernel driver.
    await this.writeReg(0x08, 0x006080);
    await this.writeReg(0x05, 0x00000c);
    await this.writeReg(0x00, 0x000200);
    await this.writeReg(0x02, 0x004801);
    await this.writeReg(0x08, 0x00f380);
    // The bulk endpoint exists only in this alternate setting, and a reset
    // puts the interface back on alternate 0 -- so select it here, after the
    // reset, and before any transfer is queued. Queueing a read first fails
    // with "endpoint is not part of a claimed and selected alternate
    // interface", which is exactly what it says.
    // The kernel driver leaves the interface on alternate 0 when it stops and
    // selects the streaming alternate when it starts, so a restart is a real
    // 0 -> N transition at the device rather than a re-select of the setting
    // it is already on, which the firmware may treat as a no-op.
    await this.device.selectAlternateInterface(this.interfaceNumber, 0);
    if (this.bulkAlternate)
      await this.device.selectAlternateInterface(this.interfaceNumber, this.bulkAlternate);
    // Reset the bulk endpoint's data toggle on both sides. libmirisdr gets
    // this from libusb_reset_device(), a real port reset on Linux; Chrome's
    // reset() on Windows is a pipe reset, and a device that ended its last
    // session mid-transfer then streams into a host that silently discards
    // every packet -- no error, no data, forever.
    try {
      await this.device.clearHalt('in', this.input);
    } catch (error) {
      record(`clearHalt skipped: ${error.message}`);
    }
    record(`opened ${this.info.name}, interface ${this.interfaceNumber}, ` +
      `bulk alternate ${this.bulkAlternate}, endpoint ${this.input} IN`);
  }

  async command(request, value = 0, index = 0) {
    const result = await this.device.controlTransferOut({
      requestType: 'vendor', recipient: 'device', request, value, index,
    });
    if (result.status !== 'ok')
      throw new Error(`${this.info.name} USB request 0x${request.toString(16)} failed (${result.status})`);
  }

  async writeReg(reg, value) {
    const wValue = (((value & 0xff) << 8) | reg) & 0xffff;
    const wIndex = (value >>> 8) & 0xffff;
    await this.command(CMD_WREG, wValue, wIndex);
    if (debugTrace) record(`reg 0x${reg.toString(16).padStart(2, '0')} <- 0x${(value >>> 0).toString(16).padStart(6, '0')}`);
  }

  async setSampleRate(rate) {
    const { format, reg3, reg4 } = rateRegisters(rate);
    await this.writeReg(0x07, format.reg7);
    await this.writeReg(0x04, reg4);
    await this.writeReg(0x03, reg3);
    record(`sample rate ${rate}: format ${format.name}, reg3 0x${reg3.toString(16)}, reg4 0x${reg4.toString(16)}`);
    return format;
  }

  async tune(frequency, bandwidth, flags) {
    const t = tuningRegisters(frequency, bandwidth, flags);
    await this.writeReg(0x08, t.reg8);
    await this.writeReg(0x09, 0x0e);
    await this.writeReg(0x09, t.reg3);
    await this.writeReg(0x09, t.reg0);
    await this.writeReg(0x09, t.reg5);
    await this.writeReg(0x09, t.reg2);
    await this.writeReg(0x09, t.regd);
    record(`tuned ${frequency} Hz (synth ${t.actualFrequency} Hz), mode 0x${t.plan.mode.toString(16)}, ` +
      `bandwidth ${bandwidth}, gpio 0x${t.reg8.toString(16)}`);
    return t;
  }

  async setGain(gain, amBand) {
    const g = gainRegisters(gain, amBand);
    await this.writeReg(0x09, g.reg1);
    await this.writeReg(0x09, g.reg6);
    record(`gain ${gain} dB: lna reduction ${g.lna}, mixer reduction ${g.mixer}, baseband reduction ${g.baseband}`);
  }

  async startStreaming() {
    await this.command(CMD_START_STREAMING);
    this.streaming = true;
    record('streaming started');
  }

  async stopStreaming() {
    if (!this.streaming) return;
    this.streaming = false;
    await this.command(CMD_STOP_STREAMING);
    record('streaming stopped');
  }

  async read(length) {
    const result = await this.device.transferIn(this.input, length);
    if (result.status === 'stall') {
      await this.device.clearHalt('in', this.input);
      throw new Error(`${this.info.name} receive endpoint stalled`);
    }
    if (result.status !== 'ok' || !result.data)
      throw new Error(`${this.info.name} receive failed (${result.status})`);
    return new Uint8Array(
      result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
  }

  async emergencyStop() {
    if (this.closed) return;
    try { await this.command(CMD_STOP_STREAMING); } catch {}
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.command(CMD_STOP_STREAMING); } catch {}
    try { await this.writeReg(0x03, 0x010000); } catch {}      // ADC + USB asleep
    try { await this.writeReg(0x09, 0x000000); } catch {}      // tuner powered down
    try { await this.device.selectAlternateInterface(this.interfaceNumber, 0); } catch {}
    try { await this.device.releaseInterface(this.interfaceNumber); } catch {}
    try { await this.device.close(); } catch {}
  }
}

function deviceInfo(device) {
  return SDRPLAY_DEVICES.find(entry =>
    entry.vendorId === device.vendorId && entry.productId === device.productId);
}

async function pickDevice() {
  if (!navigator.usb)
    throw new Error('this browser has no WebUSB; use Chrome, Edge or Opera');
  const devices = (await navigator.usb.getDevices()).filter(deviceInfo);
  if (!devices.length)
    throw new Error(
      'no SDRplay RSP has been shared with this site; open the block properties and add one');
  return devices[0];
}

function readCommand(data) {
  const mailbox = control(data);
  for (let attempt = 0; attempt < 8; ++attempt) {
    const seq = Atomics.load(mailbox, CTRL.CMD_SEQ);
    const command = {
      seq,
      sampleRate: Atomics.load(mailbox, CTRL.SAMPLE_RATE),
      frequency: Atomics.load(mailbox, CTRL.FREQ_HI) * 4294967296 +
        (Atomics.load(mailbox, CTRL.FREQ_LO) >>> 0),
      bandwidth: Atomics.load(mailbox, CTRL.BANDWIDTH),
      gain: Atomics.load(mailbox, CTRL.GAIN),
      flags: Atomics.load(mailbox, CTRL.FLAGS),
    };
    if (Atomics.load(mailbox, CTRL.CMD_SEQ) === seq) return command;
  }
  return null;
}

function validateCommand(command) {
  if (!Number.isInteger(command.sampleRate) ||
      command.sampleRate < MIN_RATE || command.sampleRate > MAX_RATE)
    throw new Error('SDRplay sample rate must be an integer from 1.3 to 12.096 MS/s');
  if (!Number.isFinite(command.frequency) ||
      command.frequency < MIN_FREQ || command.frequency > MAX_FREQ)
    throw new Error('SDRplay center frequency must be 10 kHz to 2 GHz');
  if (command.bandwidth !== 0 && !BANDWIDTHS.includes(command.bandwidth))
    throw new Error(`unsupported SDRplay IF bandwidth ${command.bandwidth}`);
  if (command.gain < 0 || command.gain > MAX_GAIN)
    throw new Error('SDRplay gain must be 0-102 dB');
}

async function applyPendingConfiguration(data, usb, previous, fake) {
  const mailbox = control(data);
  if (previous && Atomics.load(mailbox, CTRL.CMD_SEQ) === previous.seq) return previous;
  const command = readCommand(data);
  if (!command) return previous;
  validateCommand(command);
  const first = !previous;
  if (!first && command.sampleRate !== previous.sampleRate)
    throw new Error('SDRplay sample rate cannot be changed while running');
  const bandwidth = command.bandwidth || automaticBandwidth(command.sampleRate);
  let amBand = previous ? previous.amBand : planFor(command.frequency).mode === MODE_AM;

  if (!fake) {
    if (first) data.format = await usb.setSampleRate(command.sampleRate);
    if (first || command.frequency !== previous.frequency ||
        bandwidth !== previous.bandwidthApplied || command.flags !== previous.flags) {
      const tuned = await usb.tune(command.frequency, bandwidth, command.flags);
      amBand = tuned.amBand;
    }
    // Retuning across the AM boundary changes which attenuators exist, and
    // libmirisdr restores the gain after every tune for that reason.
    if (first || command.gain !== previous.gain || amBand !== previous.amBand ||
        command.frequency !== previous.frequency)
      await usb.setGain(command.gain, amBand);
  } else {
    data.format = formatForRate(command.sampleRate);
  }

  Atomics.store(mailbox, CTRL.ACTUAL_RATE, command.sampleRate);
  Atomics.store(mailbox, CTRL.CMD_ACK, command.seq);
  return { ...command, bandwidthApplied: bandwidth, amBand };
}

function deliverRx(data, samples, count, counters) {
  const pairs = count / 2;
  if (!pairs) return;
  const free = data.capacityPairs - usedPairs(data) - 1;
  if (free < pairs) {
    ++counters.events;
    counters.lost += pairs;
    Atomics.store(control(data), CTRL.EVENTS, counters.events);
    Atomics.store(control(data), CTRL.LOST_SAMPLES, counters.lost);
    postMessage({ type: 'overrun', ...counters });
    return;
  }
  const write = Atomics.load(control(data), CTRL.WRITE_POS);
  const beforeWrap = Math.min(pairs, data.capacityPairs - write);
  const view = ring(data);
  view.set(samples.subarray(0, beforeWrap * 2), write * 2);
  if (beforeWrap < pairs) view.set(samples.subarray(beforeWrap * 2, count), 0);
  Atomics.store(control(data), CTRL.WRITE_POS, (write + pairs) % data.capacityPairs);
  Atomics.notify(control(data), CTRL.WRITE_POS);
  counters.bytes += pairs * 4;
}

function claimDeadline(state, pairs, sampleRate) {
  const now = performance.now();
  if (!state.nextDue || state.nextDue < now - 1000) state.nextDue = now;
  const due = state.nextDue;
  state.nextDue += pairs / sampleRate * 1000;
  return due;
}

// The fake device produces frames exactly as the hardware would pack them,
// so the unpackers and the counter bookkeeping run in the smoke test too.
async function fakeTransfer(data, state) {
  const frames = data.transferBytes / FRAME_BYTES;
  const format = data.format;
  const due = claimDeadline(state, frames * format.pairs, data.sampleRate);
  const wait = due - performance.now();
  if (wait > 0) await delay(wait);
  const bytes = new Uint8Array(frames * FRAME_BYTES);
  const tone = Number(String(data.serial).slice(5)) || 100000;
  for (let f = 0; f < frames; ++f) {
    const frame = bytes.subarray(f * FRAME_BYTES, (f + 1) * FRAME_BYTES);
    frame[0] = state.counter & 0xff;
    frame[1] = (state.counter >>> 8) & 0xff;
    frame[2] = (state.counter >>> 16) & 0xff;
    frame[3] = (state.counter >>> 24) & 0xff;
    state.counter = (state.counter + format.pairs) >>> 0;
    for (let pair = 0; pair < format.pairs; ++pair) {
      state.phase += 2 * Math.PI * tone / data.sampleRate;
      if (state.phase > 2 * Math.PI) state.phase -= 2 * Math.PI;
      // Half scale, in the format's own bit depth, packed like the device.
      const i = Math.round(Math.cos(state.phase) * (1 << (format.bits - 2)));
      const q = Math.round(Math.sin(state.phase) * (1 << (format.bits - 2)));
      packPair(format, frame, FRAME_HEADER, pair, i, q);
    }
  }
  return bytes;
}


async function rxLoop(data, usb, applied, fake) {
  const counters = { bytes: 0, events: 0, lost: 0, frames: 0, resyncs: 0 };
  const fakeState = { phase: 0, nextDue: 0, counter: 0 };
  const frameState = { expected: null };
  const samples = new Int16Array((data.transferBytes / FRAME_BYTES) * 504 * 2);
  const read = length => fake ? fakeTransfer(data, fakeState) : usb.read(length);
  const pending = [];
  while (pending.length < TRANSFER_DEPTH) pending.push(read(data.transferBytes));
  if (!fake) await usb.startStreaming();

  while (!cancelled(data)) {
    applied = await applyPendingConfiguration(data, usb, applied, fake);
    // Once streaming is stopped the device completes no more reads, so a
    // stop must win this race or close() would never run.
    const bytes = await Promise.race([pending.shift(), stopSignal]);
    if (cancelled(data) || !bytes) break;
    const result = unpackTransfer(data.format, bytes, frameState, samples);
    counters.frames += result.frames;
    if (result.misaligned) {
      // Off by one USB packet. Everything already in flight started on the
      // same wrong boundary, so drain it all, read one packet to step back
      // onto a frame boundary, and re-prime. Costs a few transfers, once.
      ++counters.resyncs;
      frameState.expected = null;
      record(`frame boundary slipped; resynchronising (${counters.resyncs})`);
      await Promise.all(pending);
      pending.length = 0;
      await read(USB_PACKET);
      while (pending.length < TRANSFER_DEPTH) pending.push(read(data.transferBytes));
    } else {
      if (result.lost) {
        ++counters.events;
        counters.lost += result.lost;
        Atomics.store(control(data), CTRL.EVENTS, counters.events);
        Atomics.store(control(data), CTRL.LOST_SAMPLES, counters.lost);
      }
      deliverRx(data, samples, result.produced, counters);
      pending.push(read(data.transferBytes));
    }
    if ((counters.bytes & ((16 * 1024 * 1024) - 1)) < result.produced * 2)
      postMessage({ type: 'progress', ...counters });
  }
  postMessage({ type: 'cancelled', ...counters });
}

onmessage = event => {
  if (event.data?.type === 'stop') {
    stopRequested();
    void activeUsb?.emergencyStop();
    return;
  }
  void run(event.data).catch(error => {
    if (cancelled(event.data)) {
      postMessage({ type: 'cancelled' });
      close();
    } else {
      fail(event.data, error);
    }
  });
};

async function run(data) {
  debugTrace = !!data.debug;
  if (!Number.isInteger(data.capacityPairs) || data.capacityPairs < 2)
    throw new Error('invalid SDRplay ring capacity');
  if (!Number.isInteger(data.transferBytes) || data.transferBytes <= 0 ||
      data.transferBytes > MAX_TRANSFER || data.transferBytes % FRAME_BYTES)
    throw new Error('invalid SDRplay USB transfer size');
  if (data.capacityPairs < (data.transferBytes / FRAME_BYTES) * 504 * TRANSFER_DEPTH + 1)
    throw new Error('SDRplay ring is too small for the transfer queue');

  const serial = String(data.serial || '');
  const fake = serial === 'fake' || serial.startsWith('fake:');
  let usb = null;
  let applied = null;
  try {
    if (!fake) {
      const device = await pickDevice();
      const info = deviceInfo(device);
      usb = await Msi2500Usb.open(device, info);
      activeUsb = usb;
      Atomics.store(control(data), CTRL.MODEL, info.model);
      postMessage({ type: 'device', name: info.name, model: info.model, worker: WORKER_VERSION });
    } else {
      Atomics.store(control(data), CTRL.MODEL, 0);
    }
    applied = await applyPendingConfiguration(data, usb, null, fake);
    if (!applied) throw new Error('SDRplay command mailbox was not readable');
    data.sampleRate = applied.sampleRate;

    Atomics.store(control(data), CTRL.STATE, RUNNING);
    Atomics.notify(control(data), CTRL.READ_POS);
    Atomics.notify(control(data), CTRL.WRITE_POS);
    postMessage({
      type: 'running', actualRate: data.sampleRate, fake,
      format: data.format.name, bits: data.format.bits,
      serial: fake ? serial : (usb.info.name),
    });
    await rxLoop(data, usb, applied, fake);
  } finally {
    if (usb) await usb.close();
    activeUsb = null;
  }
}
