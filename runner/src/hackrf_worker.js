// WebUSB producer/consumer for the browser-only HackRF Source and Sink.
//
// This is a small WebUSB implementation of the stock protocol, with behavior
// checked against Great Scott Gadgets' libhackrf reference implementation.
// WebUSB owns the asynchronous USB side; GNU Radio's synchronous scheduler sees
// only a shared-memory ring and a seqlock command mailbox. See docs/hackrf.md.

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
  BANDWIDTH: 11,
  LNA_GAIN: 12,
  VGA_GAIN: 13,
  TXVGA_GAIN: 14,
  FLAGS: 15,
  SAMPLE_RATE: 16,
};
const CTRL_WORDS = 17;

const RUNNING = 1;
const ERROR = 2;
const CANCELLED = 3;
const FLAG_AMP = 1 << 0;
const FLAG_BIAS_TEE = 1 << 1;

const HACKRF_FILTERS = [{ vendorId: 0x1d50, productId: 0x6089 }];
const TRANSFER_DEPTH = 4;
const MAX_TRANSFER = 1024 * 1024;
const MODE_OFF = 0;
const MODE_RX = 1;
const MODE_TX = 2;

const REQUEST = {
  SET_TRANSCEIVER_MODE: 1,
  SET_SAMPLE_RATE: 6,
  SET_BASEBAND_FILTER_BANDWIDTH: 7,
  VERSION_STRING_READ: 15,
  SET_FREQ: 16,
  AMP_ENABLE: 17,
  SET_LNA_GAIN: 19,
  SET_VGA_GAIN: 20,
  SET_TXVGA_GAIN: 21,
  ANTENNA_ENABLE: 23,
};

const BANDWIDTHS = new Set([
  1750000, 2500000, 3500000, 5000000, 5500000, 6000000, 7000000,
  8000000, 9000000, 10000000, 12000000, 14000000, 15000000,
  20000000, 24000000, 28000000,
]);
const BANDWIDTH_LIST = [...BANDWIDTHS];

// Match libhackrf_compute_baseband_filter_bw_round_down_lt(): choose the
// greatest MAX2837 width strictly below 75% of the sample rate, clamping to
// the narrowest filter when even it is wider. The strict comparison matters
// at e.g. 8 and 20 MS/s, where libhackrf selects 5.5 and 14 MHz respectively.
function automaticBandwidth(sampleRate) {
  const wanted = sampleRate * 0.75;
  let selected = BANDWIDTH_LIST[0];
  for (const bandwidth of BANDWIDTH_LIST) {
    if (bandwidth >= wanted) break;
    selected = bandwidth;
  }
  return selected;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const recent = [];
const startedAt = performance.now();
let debugTrace = false;
let activeUsb = null;

function record(text) {
  const line = `${(performance.now() - startedAt).toFixed(1).padStart(8)}ms ${text}`;
  recent.push(line);
  if (recent.length > 64) recent.shift();
  if (debugTrace) postMessage({ type: 'trace', text: line });
}

function control(data) {
  return (data.controlView ??=
    new Int32Array(data.memory.buffer, data.controlPointer, CTRL_WORDS));
}

function ring(data) {
  return (data.ringView ??= new Uint8Array(
    data.memory.buffer, data.ringPointer, data.capacityPairs * 2));
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

function u32le(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

class HackRfUsb {
  constructor(device) {
    this.device = device;
    this.interfaceNumber = 0;
    this.input = 0;
    this.output = 0;
    this.closed = false;
  }

  static async open(device) {
    const hackrf = new HackRfUsb(device);
    try {
      await hackrf.open();
      return hackrf;
    } catch (error) {
      await hackrf.close();
      throw error;
    }
  }

  async open() {
    await this.device.open();
    if (!this.device.configuration)
      await this.device.selectConfiguration(1);

    let alternate = null;
    for (const iface of this.device.configuration.interfaces) {
      for (const candidate of iface.alternates) {
        const input = candidate.endpoints.find(endpoint =>
          endpoint.type === 'bulk' && endpoint.direction === 'in');
        const output = candidate.endpoints.find(endpoint =>
          endpoint.type === 'bulk' && endpoint.direction === 'out');
        if (!input || !output) continue;
        this.interfaceNumber = iface.interfaceNumber;
        this.input = input.endpointNumber;
        this.output = output.endpointNumber;
        alternate = candidate;
        break;
      }
      if (alternate) break;
    }
    if (!alternate) throw new Error('the HackRF has no bulk input/output interface');

    await this.device.claimInterface(this.interfaceNumber);
    if (alternate.alternateSetting !== 0)
      await this.device.selectAlternateInterface(
        this.interfaceNumber, alternate.alternateSetting);
    await this.setMode(MODE_OFF);
    record(`opened interface ${this.interfaceNumber}, endpoints ` +
      `${this.input} IN / ${this.output} OUT`);
  }

  async controlOut(request, value = 0, index = 0, bytes) {
    const result = await this.device.controlTransferOut({
      requestType: 'vendor', recipient: 'device', request, value, index,
    }, bytes);
    if (result.status !== 'ok')
      throw new Error(`HackRF USB request ${request} failed (${result.status})`);
    if (bytes && result.bytesWritten !== undefined && result.bytesWritten !== bytes.byteLength)
      throw new Error(
        `HackRF USB request ${request} wrote ${result.bytesWritten}/${bytes.byteLength} bytes`);
  }

  async controlIn(request, value = 0, index = 0, length = 1) {
    const result = await this.device.controlTransferIn({
      requestType: 'vendor', recipient: 'device', request, value, index,
    }, length);
    if (result.status !== 'ok' || !result.data)
      throw new Error(`HackRF USB request ${request} failed (${result.status})`);
    return new Uint8Array(
      result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
  }

  async setMode(mode) {
    await this.controlOut(REQUEST.SET_TRANSCEIVER_MODE, mode);
    record(`transceiver mode ${mode}`);
  }

  async version() {
    const bytes = await this.controlIn(REQUEST.VERSION_STRING_READ, 0, 0, 255);
    return decoder.decode(bytes).replace(/\0.*$/, '');
  }

  async setSampleRate(sampleRate) {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, sampleRate >>> 0, true);
    view.setUint32(4, 1, true);
    await this.controlOut(REQUEST.SET_SAMPLE_RATE, 0, 0, bytes);
  }

  async setBandwidth(bandwidth) {
    await this.controlOut(
      REQUEST.SET_BASEBAND_FILTER_BANDWIDTH,
      bandwidth & 0xffff,
      Math.floor(bandwidth / 65536));
  }

  async setFrequency(frequency) {
    const mhz = Math.floor(frequency / 1000000);
    const hz = Math.round(frequency - mhz * 1000000);
    const bytes = new Uint8Array(8);
    bytes.set(u32le(mhz), 0);
    bytes.set(u32le(hz), 4);
    await this.controlOut(REQUEST.SET_FREQ, 0, 0, bytes);
  }

  async setAmp(on) {
    await this.controlOut(REQUEST.AMP_ENABLE, on ? 1 : 0);
  }

  async setBiasTee(on) {
    await this.controlOut(REQUEST.ANTENNA_ENABLE, on ? 1 : 0);
  }

  async setGain(request, value, name) {
    const result = await this.controlIn(request, 0, value, 1);
    if (result.byteLength !== 1 || !result[0])
      throw new Error(`HackRF rejected ${name} gain ${value} dB`);
  }

  setLnaGain(value) { return this.setGain(REQUEST.SET_LNA_GAIN, value, 'RX IF'); }
  setVgaGain(value) { return this.setGain(REQUEST.SET_VGA_GAIN, value, 'RX baseband'); }
  setTxVgaGain(value) { return this.setGain(REQUEST.SET_TXVGA_GAIN, value, 'TX VGA'); }

  async read(length) {
    const result = await this.device.transferIn(this.input, length);
    if (result.status === 'stall') {
      await this.device.clearHalt('in', this.input);
      throw new Error('HackRF receive endpoint stalled');
    }
    if (result.status !== 'ok' || !result.data)
      throw new Error(`HackRF receive failed (${result.status})`);
    return new Uint8Array(
      result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
  }

  async write(bytes) {
    const result = await this.device.transferOut(this.output, bytes);
    if (result.status === 'stall') {
      await this.device.clearHalt('out', this.output);
      throw new Error('HackRF transmit endpoint stalled');
    }
    if (result.status !== 'ok' || result.bytesWritten !== bytes.byteLength)
      throw new Error(
        `HackRF transmit wrote ${result.bytesWritten ?? 0}/${bytes.byteLength} bytes ` +
        `(${result.status})`);
  }

  async emergencyStop() {
    if (this.closed) return;
    try { await this.setMode(MODE_OFF); } catch {}
    try { await this.setAmp(false); } catch {}
    try { await this.setBiasTee(false); } catch {}
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.controlOut(REQUEST.SET_TRANSCEIVER_MODE, MODE_OFF); } catch {}
    try { await this.controlOut(REQUEST.AMP_ENABLE, 0); } catch {}
    try { await this.controlOut(REQUEST.ANTENNA_ENABLE, 0); } catch {}
    try { await this.device.releaseInterface(this.interfaceNumber); } catch {}
    try { await this.device.close(); } catch {}
  }
}

async function pickDevice(serial) {
  if (!navigator.usb)
    throw new Error('this browser has no WebUSB; use Chrome, Edge or Opera');
  const devices = (await navigator.usb.getDevices()).filter(device =>
    HACKRF_FILTERS.some(filter =>
      filter.vendorId === device.vendorId && filter.productId === device.productId));
  if (!devices.length)
    throw new Error(
      'no HackRF has been shared with this site; open the block properties and add one');
  if (!serial) return devices[0];
  const device = devices.find(candidate => candidate.serialNumber === serial);
  if (!device) throw new Error(`no HackRF with serial "${serial}" is available`);
  return device;
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
      lnaGain: Atomics.load(mailbox, CTRL.LNA_GAIN),
      vgaGain: Atomics.load(mailbox, CTRL.VGA_GAIN),
      txvgaGain: Atomics.load(mailbox, CTRL.TXVGA_GAIN),
      flags: Atomics.load(mailbox, CTRL.FLAGS),
    };
    if (Atomics.load(mailbox, CTRL.CMD_SEQ) === seq) return command;
  }
  return null;
}

function validateCommand(command, direction) {
  if (!Number.isInteger(command.sampleRate) ||
      command.sampleRate < 2000000 || command.sampleRate > 20000000)
    throw new Error('HackRF sample rate must be an integer from 2 to 20 MS/s');
  if (!Number.isFinite(command.frequency) ||
      command.frequency < 1000000 || command.frequency > 6000000000)
    throw new Error('HackRF center frequency must be 1 MHz to 6 GHz');
  if (command.bandwidth !== 0 && !BANDWIDTHS.has(command.bandwidth))
    throw new Error(`unsupported HackRF baseband bandwidth ${command.bandwidth}`);
  if (direction === 'rx') {
    if (command.lnaGain < 0 || command.lnaGain > 40 || command.lnaGain % 8)
      throw new Error('HackRF RX IF gain must be 0-40 dB in 8 dB steps');
    if (command.vgaGain < 0 || command.vgaGain > 62 || command.vgaGain % 2)
      throw new Error('HackRF RX baseband gain must be 0-62 dB in 2 dB steps');
  } else if (command.txvgaGain < 0 || command.txvgaGain > 47) {
    throw new Error('HackRF TX VGA gain must be 0-47 dB');
  }
}

function commandWaiting(data, applied) {
  return !applied || Atomics.load(control(data), CTRL.CMD_SEQ) !== applied.seq;
}

async function applyPendingConfiguration(data, usb, direction, previous, fake) {
  if (!commandWaiting(data, previous)) return previous;
  const command = readCommand(data);
  if (!command) return previous;
  validateCommand(command, direction);
  const first = !previous;

  if (!fake) {
    if (first) {
      // Safe state first. The requested amp/bias settings are applied only
      // after every other field has succeeded.
      await usb.setMode(MODE_OFF);
      await usb.setAmp(false);
      await usb.setBiasTee(false);
    }
    if (first || command.sampleRate !== previous.sampleRate) {
      if (!first && direction !== 'rx')
        throw new Error('HackRF TX sample rate cannot be changed while running');
      await usb.setSampleRate(command.sampleRate);
    }
    if (first || command.bandwidth !== previous.bandwidth ||
        command.sampleRate !== previous.sampleRate)
      await usb.setBandwidth(command.bandwidth || automaticBandwidth(command.sampleRate));
    if (first || command.frequency !== previous.frequency)
      await usb.setFrequency(command.frequency);

    if (direction === 'rx') {
      if (first || command.lnaGain !== previous.lnaGain)
        await usb.setLnaGain(command.lnaGain);
      if (first || command.vgaGain !== previous.vgaGain)
        await usb.setVgaGain(command.vgaGain);
    } else if (first || command.txvgaGain !== previous.txvgaGain) {
      await usb.setTxVgaGain(command.txvgaGain);
    }

    const amp = !!(command.flags & FLAG_AMP);
    const oldAmp = !!(previous?.flags & FLAG_AMP);
    if (first || amp !== oldAmp) await usb.setAmp(amp);
    const biasTee = !!(command.flags & FLAG_BIAS_TEE);
    const oldBiasTee = !!(previous?.flags & FLAG_BIAS_TEE);
    if (first || biasTee !== oldBiasTee) await usb.setBiasTee(biasTee);
  }

  data.sampleRate = command.sampleRate;
  Atomics.store(control(data), CTRL.ACTUAL_RATE, command.sampleRate);
  Atomics.store(control(data), CTRL.CMD_ACK, command.seq);
  return { ...command, actualRate: command.sampleRate };
}

function deliverRx(data, bytes, counters) {
  let chunk = bytes;
  if (counters.carry !== null) {
    const joined = new Uint8Array(chunk.byteLength + 1);
    joined[0] = counters.carry;
    joined.set(chunk, 1);
    chunk = joined;
    counters.carry = null;
  }
  if (chunk.byteLength & 1) {
    counters.carry = chunk[chunk.byteLength - 1];
    chunk = chunk.subarray(0, chunk.byteLength - 1);
  }
  const pairs = chunk.byteLength / 2;
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
  ring(data).set(chunk.subarray(0, beforeWrap * 2), write * 2);
  if (beforeWrap < pairs) ring(data).set(chunk.subarray(beforeWrap * 2), 0);
  Atomics.store(control(data), CTRL.WRITE_POS, (write + pairs) % data.capacityPairs);
  Atomics.notify(control(data), CTRL.WRITE_POS);
  counters.bytes += pairs * 2;
}

function claimDeadline(state, pairs, sampleRate) {
  const now = performance.now();
  if (!state.nextDue || state.nextDue < now - 1000) state.nextDue = now;
  const due = state.nextDue;
  state.nextDue += pairs / sampleRate * 1000;
  return due;
}

async function waitUntil(due) {
  const wait = due - performance.now();
  if (wait > 0) await delay(wait);
}

async function fakeRxTransfer(data, state) {
  const pairs = data.transferBytes / 2;
  const due = claimDeadline(state, pairs, data.sampleRate);
  await waitUntil(due);
  const raw = new Int8Array(pairs * 2);
  const tone = Number(data.serial.slice(5)) || 100000;
  for (let pair = 0; pair < pairs; ++pair) {
    state.phase += 2 * Math.PI * tone / data.sampleRate;
    if (state.phase > 2 * Math.PI) state.phase -= 2 * Math.PI;
    raw[pair * 2] = Math.round(64 * Math.cos(state.phase));
    raw[pair * 2 + 1] = Math.round(64 * Math.sin(state.phase));
  }
  return new Uint8Array(raw.buffer);
}

async function rxLoop(data, usb, applied, fake) {
  const counters = { bytes: 0, events: 0, lost: 0, carry: null };
  const fakeState = { phase: 0, nextDue: 0 };
  const read = () => fake
    ? fakeRxTransfer(data, fakeState)
    : usb.read(data.transferBytes);
  const pending = [];
  while (pending.length < TRANSFER_DEPTH) pending.push(read());

  while (!cancelled(data)) {
    applied = await applyPendingConfiguration(data, usb, 'rx', applied, fake);
    const bytes = await pending.shift();
    if (cancelled(data)) break;
    deliverRx(data, bytes, counters);
    pending.push(read());
    if ((counters.bytes & ((16 * 1024 * 1024) - 1)) < bytes.byteLength)
      postMessage({ type: 'progress', ...counters });
  }
  postMessage({ type: 'cancelled', ...counters });
}

function takeTx(data, pairs) {
  const read = Atomics.load(control(data), CTRL.READ_POS);
  const bytes = new Uint8Array(pairs * 2);
  const beforeWrap = Math.min(pairs, data.capacityPairs - read);
  bytes.set(ring(data).subarray(read * 2, (read + beforeWrap) * 2));
  if (beforeWrap < pairs)
    bytes.set(ring(data).subarray(0, (pairs - beforeWrap) * 2), beforeWrap * 2);
  Atomics.store(control(data), CTRL.READ_POS, (read + pairs) % data.capacityPairs);
  Atomics.notify(control(data), CTRL.READ_POS);
  return bytes;
}

async function waitForTxPrefill(data, pairs) {
  const wanted = pairs * TRANSFER_DEPTH;
  while (!cancelled(data) && usedPairs(data) < wanted) await delay(1);
  return !cancelled(data);
}

async function txLoop(data, usb, applied, fake) {
  const pairs = data.transferBytes / 2;
  if (!await waitForTxPrefill(data, pairs)) return;
  if (!fake) await usb.setMode(MODE_TX);

  Atomics.store(control(data), CTRL.STATE, RUNNING);
  Atomics.notify(control(data), CTRL.READ_POS);
  Atomics.notify(control(data), CTRL.WRITE_POS);
  postMessage({
    type: 'running', direction: 'tx', actualRate: data.sampleRate,
    fake, serial: data.serial || 'first available',
  });

  let bytes = 0;
  const pacing = { nextDue: 0 };
  const send = chunk => {
    if (!fake) return usb.write(chunk);
    const due = claimDeadline(pacing, pairs, data.sampleRate);
    return waitUntil(due);
  };
  const pending = [];
  for (let i = 0; i < TRANSFER_DEPTH; ++i)
    pending.push(send(takeTx(data, pairs)));

  while (!cancelled(data)) {
    await pending.shift();
    if (cancelled(data)) break;
    applied = await applyPendingConfiguration(data, usb, 'tx', applied, fake);
    if (usedPairs(data) < pairs) {
      Atomics.store(control(data), CTRL.EVENTS, 1);
      if (!fake) await usb.setMode(MODE_OFF);
      throw new Error('HackRF transmit underflow; transmitter stopped');
    }
    pending.push(send(takeTx(data, pairs)));
    bytes += data.transferBytes;
    if ((bytes & ((16 * 1024 * 1024) - 1)) < data.transferBytes)
      postMessage({ type: 'progress', bytes, events: 0 });
  }
  postMessage({ type: 'cancelled', bytes, events: 0 });
}

onmessage = event => {
  if (event.data?.type === 'stop') {
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
  if (!['rx', 'tx'].includes(data.direction)) throw new Error('invalid HackRF direction');
  if (!Number.isInteger(data.capacityPairs) || data.capacityPairs < 2)
    throw new Error('invalid HackRF ring capacity');
  if (!Number.isInteger(data.transferBytes) || data.transferBytes <= 0 ||
      data.transferBytes > MAX_TRANSFER || data.transferBytes % 512)
    throw new Error('invalid HackRF USB transfer size');
  const transferPairs = data.transferBytes / 2;
  if (data.capacityPairs < transferPairs * TRANSFER_DEPTH + 1)
    throw new Error('HackRF ring is too small for the transfer queue');

  const fake = data.serial === 'fake' || data.serial.startsWith('fake:');
  let usb = null;
  let applied = null;
  try {
    if (!fake) {
      usb = await HackRfUsb.open(await pickDevice(data.serial));
      activeUsb = usb;
      const version = await usb.version();
      postMessage({
        type: 'device', firmware: version || 'unknown',
        usbApi: `${usb.device.deviceVersionMajor}.${String(usb.device.deviceVersionMinor).padStart(2, '0')}`,
      });
    }
    applied = await applyPendingConfiguration(data, usb, data.direction, null, fake);
    if (!applied) throw new Error('HackRF command mailbox was not readable');
    data.sampleRate = applied.actualRate;

    if (data.direction === 'rx') {
      if (!fake) await usb.setMode(MODE_RX);
      Atomics.store(control(data), CTRL.STATE, RUNNING);
      Atomics.notify(control(data), CTRL.READ_POS);
      Atomics.notify(control(data), CTRL.WRITE_POS);
      postMessage({
        type: 'running', direction: 'rx', actualRate: data.sampleRate,
        fake, serial: data.serial || 'first available',
      });
      await rxLoop(data, usb, applied, fake);
    } else {
      await txLoop(data, usb, applied, fake);
    }
  } finally {
    if (usb) await usb.close();
    activeUsb = null;
  }
}
