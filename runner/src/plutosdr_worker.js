// WebUSB producer/consumer for the browser-only PlutoSDR Source and Sink.
//
// The USB/IIOD command sequence follows Analog Devices' libiio v0 USB backend.
// Marc Newlin's 2020 websdr proved that the stock Pluto firmware accepts this
// protocol from WebUSB; this implementation removes that proof-of-concept's
// fixed interface, endpoint and iio:deviceN assumptions by discovering all
// three from the USB descriptors and PRINT XML. See docs/plutosdr.md.

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
  VALUE1_MILLI: 12,
  VALUE2_MILLI: 13,
  MODE1: 14,
  MODE2: 15,
  FLAGS: 16,
};
const CTRL_WORDS = 17;

const INITIAL = 0;
const RUNNING = 1;
const ERROR = 2;
const CANCELLED = 3;

const FLAG_QUADRATURE = 1 << 0;
const FLAG_RF_DC = 1 << 1;
const FLAG_BB_DC = 1 << 2;

const MODE_NAMES = ['slow_attack', 'fast_attack', 'hybrid', 'manual'];
const PLUTO_FILTERS = [{ vendorId: 0x0456, productId: 0xb673 }];
const RESET_PIPES = 0;
const OPEN_PIPE = 1;
const CLOSE_PIPE = 2;
const MAX_TRANSFER = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const recent = [];
const startedAt = performance.now();
let debugTrace = false;

function record(text) {
  const line = `${(performance.now() - startedAt).toFixed(1).padStart(8)}ms ${text}`;
  recent.push(line);
  if (recent.length > 64) recent.shift();
  if (debugTrace) postMessage({ type: 'trace', text: line });
}

function controlView(memory, pointer) {
  return new Int32Array(memory.buffer, pointer, CTRL_WORDS);
}

function cancelled(data) {
  return Atomics.load(controlView(data.memory, data.controlPointer), CTRL.STATE) === CANCELLED;
}

function fail(data, error) {
  const message = String(error instanceof Error ? error.message : error);
  try {
    const bytes = encoder.encode(message);
    const length = Math.min(bytes.byteLength, data.errorCapacity - 1);
    new Uint8Array(data.memory.buffer, data.errorPointer, data.errorCapacity).fill(0);
    new Uint8Array(data.memory.buffer, data.errorPointer, length).set(bytes.subarray(0, length));
    const control = controlView(data.memory, data.controlPointer);
    Atomics.store(control, CTRL.ERROR_LENGTH, length);
    Atomics.store(control, CTRL.STATE, ERROR);
    Atomics.notify(control, CTRL.READ_POS);
    Atomics.notify(control, CTRL.WRITE_POS);
  } catch {
    // The iframe may already be unloading.
  }
  postMessage({ type: 'error', message, recent: [...recent] });
  close();
}

function xmlAttributes(text) {
  const result = Object.create(null);
  for (const match of text.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g))
    result[match[1]] = match[2]
      .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  return result;
}

// PRINT XML is deliberately parsed without DOMParser: that API is not exposed
// in Web Workers in all Chromium versions supported by this project.
function parseContextXml(xml) {
  const devices = [];
  for (const deviceMatch of xml.matchAll(/<device\b([^>]*)>([\s\S]*?)<\/device>/g)) {
    const attrs = xmlAttributes(deviceMatch[1]);
    const device = { id: attrs.id || '', name: attrs.name || '', channels: [] };
    for (const channelMatch of deviceMatch[2].matchAll(
      /<channel\b([^>]*?)(?:\/>|>([\s\S]*?)<\/channel>)/g)) {
      const channelAttrs = xmlAttributes(channelMatch[1]);
      const body = channelMatch[2] || '';
      const scanMatch = body.match(/<scan-element\b([^>]*)\/>/);
      const scanAttrs = scanMatch ? xmlAttributes(scanMatch[1]) : null;
      device.channels.push({
        id: channelAttrs.id || '',
        output: channelAttrs.type === 'output',
        attributes: new Set([...body.matchAll(/<attribute\b([^>]*)\/>/g)]
          .map(match => xmlAttributes(match[1]).name).filter(Boolean)),
        scanIndex: scanAttrs ? Number(scanAttrs.index) : null,
        format: scanAttrs?.format || '',
      });
    }
    devices.push(device);
  }
  return devices;
}

function findDevice(devices, name) {
  const device = devices.find(candidate => candidate.name === name);
  if (!device) throw new Error(`PlutoSDR IIO context has no ${name} device`);
  return device;
}

function channelMask(device, channels) {
  const words = new Uint32Array(Math.ceil(device.channels.length / 32));
  for (const channel of channels) {
    const index = device.channels.indexOf(channel);
    if (index < 0) throw new Error(`IIO channel ${channel.id} is not part of ${device.name}`);
    words[index >>> 5] |= 1 << (index & 31);
  }
  let text = '';
  for (let i = words.length - 1; i >= 0; --i)
    text += words[i].toString(16).padStart(8, '0');
  return text;
}

function radioLayout(devices, direction, channelCount) {
  const phy = findDevice(devices, 'ad9361-phy');
  const stream = findDevice(
    devices, direction === 'rx' ? 'cf-ad9361-lpc' : 'cf-ad9361-dds-core-lpc');
  const scan = stream.channels.filter(channel => channel.scanIndex !== null)
    .sort((a, b) => a.scanIndex - b.scanIndex);
  const wanted = channelCount * 2;
  if (scan.length < wanted) {
    throw new Error(
      `this Pluto exposes only ${Math.floor(scan.length / 2)} ${direction.toUpperCase()} ` +
      `channel(s); ${channelCount} requested. Two-channel mode requires a 2R2T-capable ` +
      'Pluto configured with the official firmware settings');
  }
  const selected = scan.slice(0, wanted);
  for (const channel of selected) {
    if (!/^le:S(?:12|16)\/16>>0$/.test(channel.format))
      throw new Error(`unsupported Pluto scan format ${channel.format || '(missing)'}`);
  }
  const rfChannels = phy.channels.filter(channel =>
    channel.output === (direction === 'tx') &&
    channel.attributes.has(direction === 'rx' ? 'gain_control_mode' : 'hardwaregain'));
  if (rfChannels.length < channelCount)
    throw new Error(`the Pluto PHY exposes only ${rfChannels.length} ${direction.toUpperCase()} channel(s)`);
  const lo = phy.channels.find(channel =>
    channel.output && channel.id === (direction === 'rx' ? 'altvoltage0' : 'altvoltage1'));
  if (!lo) throw new Error(`the Pluto PHY has no ${direction.toUpperCase()} LO channel`);
  return {
    phy,
    stream,
    scan: selected,
    rfChannels: rfChannels.slice(0, channelCount),
    lo,
    mask: channelMask(stream, selected),
    frameBytes: wanted * 2,
  };
}

class UsbPipe {
  constructor(device, input, output) {
    this.device = device;
    this.input = input;
    this.output = output;
    this.pending = new Uint8Array(0);
  }

  async write(data) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await this.device.transferOut(this.output, bytes.subarray(offset));
      if (result.status !== 'ok')
        throw new Error(`USB endpoint ${this.output} write failed (${result.status})`);
      const written = result.bytesWritten ?? 0;
      if (!written) throw new Error(`USB endpoint ${this.output} wrote zero bytes`);
      offset += written;
    }
  }

  async receive(length = 64 * 1024) {
    const result = await this.device.transferIn(this.input, Math.min(length, MAX_TRANSFER));
    if (result.status === 'stall') {
      await this.device.clearHalt('in', this.input);
      return this.receive(length);
    }
    if (result.status !== 'ok' || !result.data)
      throw new Error(`USB endpoint ${this.input} read failed (${result.status})`);
    const view = new Uint8Array(
      result.data.buffer, result.data.byteOffset, result.data.byteLength);
    if (!view.byteLength) throw new Error(`USB endpoint ${this.input} returned zero bytes`);
    return view.slice();
  }

  append(chunk) {
    if (!this.pending.byteLength) {
      this.pending = chunk;
      return;
    }
    const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    merged.set(this.pending);
    merged.set(chunk, this.pending.byteLength);
    this.pending = merged;
  }

  async readExact(length) {
    while (this.pending.byteLength < length)
      this.append(await this.receive(length - this.pending.byteLength));
    const result = this.pending.slice(0, length);
    this.pending = this.pending.slice(length);
    return result;
  }

  async readLine() {
    for (;;) {
      const newline = this.pending.indexOf(10);
      if (newline >= 0) {
        let line = this.pending.slice(0, newline);
        this.pending = this.pending.slice(newline + 1);
        if (line.length && line[line.length - 1] === 13) line = line.slice(0, -1);
        return decoder.decode(line);
      }
      // The stock Pluto's IIOD USB implementation writes response integers as
      // their own short transfer. Marc Newlin's WebUSB proof of concept uses a
      // ten-byte read for the same reason; a large read can remain pending on
      // some host USB stacks while IIOD has only a short line ready.
      this.append(await this.receive(10));
    }
  }

  async readInteger() {
    const text = await this.readLine();
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value)) throw new Error(`IIOD returned a non-integer: ${text}`);
    return value;
  }

  async command(command) {
    record(`${this.output}/${this.input} ${command}`);
    await this.write(`${command}\r\n`);
    return this.readInteger();
  }
}

class PlutoUsb {
  constructor(device) {
    this.device = device;
    this.interfaceNumber = -1;
    this.pairs = [];
    this.control = null;
    this.data = null;
    this.dataDevice = '';
  }

  static async open(device) {
    const pluto = new PlutoUsb(device);
    await pluto.open();
    return pluto;
  }

  async open() {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    let alternate = null;
    for (const iface of this.device.configuration.interfaces) {
      for (const candidate of iface.alternates) {
        if (candidate.interfaceName === 'IIO') {
          this.interfaceNumber = iface.interfaceNumber;
          alternate = candidate;
          break;
        }
      }
      if (alternate) break;
    }
    // Very old firmware may omit the interface string. Its IIO interface is
    // still uniquely the one with at least two bulk endpoint pairs.
    if (!alternate) {
      for (const iface of this.device.configuration.interfaces) {
        for (const candidate of iface.alternates) {
          const bulk = candidate.endpoints.filter(endpoint => endpoint.type === 'bulk');
          if (bulk.length >= 4 && bulk.length % 2 === 0) {
            this.interfaceNumber = iface.interfaceNumber;
            alternate = candidate;
            break;
          }
        }
        if (alternate) break;
      }
    }
    if (!alternate) throw new Error('the Pluto USB device has no IIO interface');
    await this.device.claimInterface(this.interfaceNumber);
    if (alternate.alternateSetting !== 0)
      await this.device.selectAlternateInterface(
        this.interfaceNumber, alternate.alternateSetting);

    const endpoints = alternate.endpoints.filter(endpoint => endpoint.type === 'bulk');
    for (let index = 0; index < endpoints.length; index += 2) {
      const pair = endpoints.slice(index, index + 2);
      const input = pair.find(endpoint => endpoint.direction === 'in');
      const output = pair.find(endpoint => endpoint.direction === 'out');
      if (!input || !output) throw new Error('invalid IIO USB endpoint pairing');
      this.pairs.push({ input: input.endpointNumber, output: output.endpointNumber });
    }
    if (this.pairs.length < 2)
      throw new Error('the Pluto IIO interface has no streaming endpoint pair');

    await this.vendor(RESET_PIPES, 0);
    await this.vendor(OPEN_PIPE, 0);
    this.control = new UsbPipe(this.device, this.pairs[0].input, this.pairs[0].output);
    record(`opened interface ${this.interfaceNumber}; endpoint pairs ` +
      this.pairs.map(pair => `${pair.output}/${pair.input}`).join(', '));
  }

  async vendor(request, value) {
    const result = await this.device.controlTransferOut({
      requestType: 'vendor', recipient: 'interface', request, value,
      index: this.interfaceNumber,
    });
    if (result.status !== 'ok')
      throw new Error(`Pluto USB vendor request ${request} failed (${result.status})`);
  }

  async contextXml() {
    record('requesting IIOD context XML');
    await this.control.write('PRINT\r\n');
    record('PRINT sent; waiting for length');
    const length = await this.control.readInteger();
    record(`PRINT length ${length}`);
    if (length <= 0 || length > 4 * 1024 * 1024)
      throw new Error(`invalid IIOD PRINT length ${length}`);
    const xml = decoder.decode(await this.control.readExact(length));
    await this.control.readLine(); // terminating newline
    return xml;
  }

  async writeAttribute(device, direction, channel, attribute, value) {
    const bytes = encoder.encode(String(value));
    await this.control.write(
      `WRITE ${device.id} ${direction} ${channel.id} ${attribute} ${bytes.byteLength}\r\n`);
    await this.control.write(bytes);
    const result = await this.control.readInteger();
    if (result < 0) throw new Error(
      `writing ${device.name}.${channel.id}.${attribute} failed (${result})`);
    if (result !== bytes.byteLength) throw new Error(
      `writing ${device.name}.${channel.id}.${attribute} wrote ${result}/${bytes.byteLength} bytes`);
  }

  async readAttribute(device, direction, channel, attribute) {
    await this.control.write(
      `READ ${device.id} ${direction} ${channel.id} ${attribute}\r\n`);
    const length = await this.control.readInteger();
    if (length < 0) throw new Error(
      `reading ${device.name}.${channel.id}.${attribute} failed (${length})`);
    const value = decoder.decode(await this.control.readExact(length)).replace(/\0+$/, '');
    await this.control.readLine();
    return value;
  }

  async openBuffer(layout, samples) {
    await this.vendor(OPEN_PIPE, 1);
    const pair = this.pairs[1];
    this.data = new UsbPipe(this.device, pair.input, pair.output);
    this.dataDevice = layout.stream.id;
    const result = await this.data.command(
      `OPEN ${layout.stream.id} ${samples} ${layout.mask}`);
    if (result < 0) throw new Error(`opening ${layout.stream.name} buffer failed (${result})`);
    const timeout = await this.data.command('TIMEOUT 3000');
    if (timeout < 0) throw new Error(`setting Pluto IIO timeout failed (${timeout})`);
  }

  async readBuffer(length) {
    await this.data.write(`READBUF ${this.dataDevice} ${length}\r\n`);
    const chunks = [];
    let total = 0;
    let first = true;
    while (total < length) {
      const count = await this.data.readInteger();
      if (count < 0) throw new Error(`Pluto READBUF failed (${count})`);
      if (count === 0) break;
      if (first) {
        await this.data.readLine(); // mask actually returned by IIOD
        first = false;
      }
      const chunk = await this.data.readExact(count);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }

  async writeBuffer(bytes) {
    await this.data.write(`WRITEBUF ${this.dataDevice} ${bytes.byteLength}\r\n`);
    const ready = await this.data.readInteger();
    if (ready < 0) throw new Error(`Pluto WRITEBUF rejected the buffer (${ready})`);
    await this.data.write(bytes);
    const result = await this.data.readInteger();
    if (result < 0) throw new Error(`Pluto WRITEBUF failed (${result})`);
  }

  async closeBuffer() {
    if (!this.data) return;
    try { await this.data.command(`CLOSE ${this.dataDevice}`); } catch {}
    try { await this.vendor(CLOSE_PIPE, 1); } catch {}
    this.data = null;
  }

  async close() {
    try { await this.closeBuffer(); } catch {}
    try { await this.vendor(RESET_PIPES, 0); } catch {}
    try { await this.device.releaseInterface(this.interfaceNumber); } catch {}
    try { await this.device.close(); } catch {}
  }
}

async function pickDevice(serial) {
  if (!navigator.usb)
    throw new Error('this browser has no WebUSB; use Chrome, Edge or Opera');
  const devices = (await navigator.usb.getDevices()).filter(device =>
    PLUTO_FILTERS.some(filter =>
      filter.vendorId === device.vendorId && filter.productId === device.productId));
  if (!devices.length)
    throw new Error('no PlutoSDR has been shared with this site; open the block properties and add one');
  if (!serial) return devices[0];
  const device = devices.find(candidate => candidate.serialNumber === serial);
  if (!device) throw new Error(`no PlutoSDR with serial "${serial}" is available`);
  return device;
}

function readCommand(control) {
  for (let attempt = 0; attempt < 8; ++attempt) {
    const seq = Atomics.load(control, CTRL.CMD_SEQ);
    const command = {
      seq,
      frequency: Atomics.load(control, CTRL.FREQ_HI) * 4294967296 +
        (Atomics.load(control, CTRL.FREQ_LO) >>> 0),
      bandwidth: Atomics.load(control, CTRL.BANDWIDTH),
      value1: Atomics.load(control, CTRL.VALUE1_MILLI) / 1000,
      value2: Atomics.load(control, CTRL.VALUE2_MILLI) / 1000,
      mode1: Atomics.load(control, CTRL.MODE1),
      mode2: Atomics.load(control, CTRL.MODE2),
      flags: Atomics.load(control, CTRL.FLAGS),
    };
    if (Atomics.load(control, CTRL.CMD_SEQ) === seq) return command;
  }
  return null;
}

function commandWaiting(control, applied) {
  return !applied || Atomics.load(control, CTRL.CMD_SEQ) !== applied.seq;
}

async function configureStatic(pluto, layout, direction, sampleRate) {
  const primary = layout.rfChannels[0];
  await pluto.writeAttribute(
    layout.phy, direction === 'rx' ? 'INPUT' : 'OUTPUT', primary,
    'sampling_frequency', Math.round(sampleRate));
  const actual = Number(await pluto.readAttribute(
    layout.phy, direction === 'rx' ? 'INPUT' : 'OUTPUT', primary,
    'sampling_frequency'));
  if (!Number.isFinite(actual)) throw new Error('Pluto returned an invalid sample rate');
  return actual;
}

async function applyConfiguration(pluto, layout, direction, command, previous) {
  if (!command || (previous && command.seq === previous.seq)) return previous;
  const first = !previous;
  const write = (channel, attribute, value) => pluto.writeAttribute(
    layout.phy, direction === 'rx' ? 'INPUT' : 'OUTPUT', channel, attribute, value);

  if (first || command.frequency !== previous.frequency)
    await pluto.writeAttribute(
      layout.phy, 'OUTPUT', layout.lo, 'frequency', Math.round(command.frequency));
  if (first || command.bandwidth !== previous.bandwidth)
    await write(layout.rfChannels[0], 'rf_bandwidth', Math.round(command.bandwidth));

  if (direction === 'rx') {
    for (let index = 0; index < layout.rfChannels.length; ++index) {
      const channel = layout.rfChannels[index];
      const mode = index ? command.mode2 : command.mode1;
      const value = index ? command.value2 : command.value1;
      const oldMode = previous && (index ? previous.mode2 : previous.mode1);
      const oldValue = previous && (index ? previous.value2 : previous.value1);
      if (first || mode !== oldMode)
        await write(channel, 'gain_control_mode', MODE_NAMES[mode] || 'slow_attack');
      if ((first || value !== oldValue || mode !== oldMode) && mode === 3)
        await write(channel, 'hardwaregain', value);
      const corrections = [
        ['quadrature_tracking_en', FLAG_QUADRATURE],
        ['rf_dc_offset_tracking_en', FLAG_RF_DC],
        ['bb_dc_offset_tracking_en', FLAG_BB_DC],
      ];
      for (const [attribute, flag] of corrections) {
        if (!channel.attributes.has(attribute)) continue;
        if (first || ((command.flags ^ previous.flags) & flag))
          await write(channel, attribute, command.flags & flag ? 1 : 0);
      }
    }
  } else {
    for (let index = 0; index < layout.rfChannels.length; ++index) {
      const value = index ? command.value2 : command.value1;
      const oldValue = previous && (index ? previous.value2 : previous.value1);
      if (first || value !== oldValue)
        await write(layout.rfChannels[index], 'hardwaregain', -Math.abs(value));
    }
  }
  return command;
}

async function disableDds(pluto, layout) {
  for (const channel of layout.stream.channels) {
    if (channel.output && channel.scanIndex === null && channel.attributes.has('raw'))
      await pluto.writeAttribute(layout.stream, 'OUTPUT', channel, 'raw', 0);
  }
}

async function setSafeAttenuation(pluto, layout) {
  for (const channel of layout.rfChannels) {
    try {
      await pluto.writeAttribute(layout.phy, 'OUTPUT', channel, 'hardwaregain', -89.75);
    } catch {}
  }
}

function deliverRx(data, bytes, counters) {
  const frameBytes = data.channels * 4;
  const aligned = bytes.byteLength - (bytes.byteLength % frameBytes);
  if (!aligned) return;
  const frames = aligned / frameBytes;
  const control = controlView(data.memory, data.controlPointer);
  const read = Atomics.load(control, CTRL.READ_POS);
  const write = Atomics.load(control, CTRL.WRITE_POS);
  const used = write >= read ? write - read : data.capacityFrames - (read - write);
  const free = data.capacityFrames - used - 1;
  if (free < frames) {
    ++counters.events;
    counters.lost += frames;
    Atomics.store(control, CTRL.EVENTS, counters.events);
    Atomics.store(control, CTRL.LOST_SAMPLES, counters.lost);
    postMessage({ type: 'overrun', ...counters });
    return;
  }
  const ring = new Uint8Array(
    data.memory.buffer, data.ringPointer, data.capacityFrames * frameBytes);
  const beforeWrap = Math.min(frames, data.capacityFrames - write);
  ring.set(bytes.subarray(0, beforeWrap * frameBytes), write * frameBytes);
  if (beforeWrap < frames) ring.set(bytes.subarray(beforeWrap * frameBytes, aligned), 0);
  Atomics.store(control, CTRL.WRITE_POS, (write + frames) % data.capacityFrames);
  Atomics.notify(control, CTRL.WRITE_POS);
  counters.bytes += aligned;
}

async function fakeRxBuffer(data, phaseState) {
  const frames = data.bufferSize;
  const now = performance.now();
  if (!phaseState.nextDue || phaseState.nextDue < now - 1000) phaseState.nextDue = now;
  const due = phaseState.nextDue;
  phaseState.nextDue += frames / data.sampleRate * 1000;
  const wait = due - performance.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  const raw = new Int16Array(frames * data.channels * 2);
  const baseTone = Number(data.serial.slice(5)) || 100000;
  for (let frame = 0; frame < frames; ++frame) {
    for (let channel = 0; channel < data.channels; ++channel) {
      phaseState.phase[channel] += 2 * Math.PI * baseTone * (channel + 1) / data.sampleRate;
      if (phaseState.phase[channel] > 2 * Math.PI) phaseState.phase[channel] -= 2 * Math.PI;
      raw[(frame * data.channels + channel) * 2] =
        Math.round(1024 * Math.cos(phaseState.phase[channel]));
      raw[(frame * data.channels + channel) * 2 + 1] =
        Math.round(1024 * Math.sin(phaseState.phase[channel]));
    }
  }
  return new Uint8Array(raw.buffer);
}

async function rxLoop(data, pluto, layout, applied, fake) {
  const bytesPerBuffer = data.bufferSize * data.channels * 4;
  const counters = { bytes: 0, events: 0, lost: 0 };
  const phaseState = { phase: Array(data.channels).fill(0), nextDue: 0 };
  while (!cancelled(data)) {
    const control = controlView(data.memory, data.controlPointer);
    if (!fake && commandWaiting(control, applied)) {
      applied = await applyConfiguration(pluto, layout, 'rx', readCommand(control), applied);
      Atomics.store(control, CTRL.CMD_ACK, applied.seq);
    }
    const bytes = fake
      ? await fakeRxBuffer(data, phaseState)
      : await pluto.readBuffer(bytesPerBuffer);
    if (cancelled(data)) break;
    deliverRx(data, bytes, counters);
    if ((counters.bytes & ((16 * 1024 * 1024) - 1)) < bytes.byteLength)
      postMessage({ type: 'progress', ...counters });
  }
  postMessage({ type: 'cancelled', ...counters });
}

function txAvailable(data, control) {
  const read = Atomics.load(control, CTRL.READ_POS);
  const write = Atomics.load(control, CTRL.WRITE_POS);
  return write >= read ? write - read : data.capacityFrames - (read - write);
}

function takeTx(data, frames) {
  const frameBytes = data.channels * 4;
  const control = controlView(data.memory, data.controlPointer);
  const read = Atomics.load(control, CTRL.READ_POS);
  const ring = new Uint8Array(
    data.memory.buffer, data.ringPointer, data.capacityFrames * frameBytes);
  const bytes = new Uint8Array(frames * frameBytes);
  const beforeWrap = Math.min(frames, data.capacityFrames - read);
  bytes.set(ring.subarray(read * frameBytes, (read + beforeWrap) * frameBytes));
  if (beforeWrap < frames)
    bytes.set(ring.subarray(0, (frames - beforeWrap) * frameBytes), beforeWrap * frameBytes);
  Atomics.store(control, CTRL.READ_POS, (read + frames) % data.capacityFrames);
  Atomics.notify(control, CTRL.READ_POS);
  return bytes;
}

async function txLoop(data, pluto, layout, applied, fake) {
  let bytes = 0;
  let events = 0;
  let wrote = false;
  let nextDue = 0;
  while (!cancelled(data)) {
    const control = controlView(data.memory, data.controlPointer);
    if (!fake && commandWaiting(control, applied)) {
      applied = await applyConfiguration(pluto, layout, 'tx', readCommand(control), applied);
      Atomics.store(control, CTRL.CMD_ACK, applied.seq);
    }
    let available = txAvailable(data, control);
    if (available < data.bufferSize) {
      if (wrote) {
        ++events;
        Atomics.store(control, CTRL.EVENTS, events);
      }
      const expected = Atomics.load(control, CTRL.WRITE_POS);
      Atomics.wait(control, CTRL.WRITE_POS, expected, 100);
      continue;
    }
    const chunk = takeTx(data, data.bufferSize);
    if (fake) {
      const now = performance.now();
      if (!nextDue || nextDue < now - 1000) nextDue = now;
      const due = nextDue;
      nextDue += data.bufferSize / data.sampleRate * 1000;
      const wait = due - performance.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    } else {
      await pluto.writeBuffer(chunk);
    }
    wrote = true;
    bytes += chunk.byteLength;
    if ((bytes & ((16 * 1024 * 1024) - 1)) < chunk.byteLength)
      postMessage({ type: 'progress', bytes, events });
  }
  postMessage({ type: 'cancelled', bytes, events });
}

onmessage = event => {
  void run(event.data).catch(error => {
    // stop() may wake an Atomics.wait immediately, but an in-flight WebUSB
    // transfer can finish with a timeout/error first. The C++ block has already
    // declared its shared control cancelled, so do not turn that expected race
    // into ERROR or write through pointers whose block is being destroyed.
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
  if (!['rx', 'tx'].includes(data.direction)) throw new Error('invalid Pluto direction');
  if (![1, 2].includes(data.channels)) throw new Error('invalid Pluto channel count');
  if (!Number.isInteger(data.capacityFrames) || data.capacityFrames < data.bufferSize + 1)
    throw new Error('invalid Pluto ring capacity');
  if (!Number.isInteger(data.bufferSize) || data.bufferSize <= 0 ||
      data.bufferSize * data.channels * 4 > MAX_TRANSFER)
    throw new Error('invalid Pluto IIO buffer size');

  const fake = data.serial === 'fake' || data.serial.startsWith('fake:');
  let pluto = null;
  let layout = null;
  let applied = null;
  try {
    if (!fake) {
      pluto = await PlutoUsb.open(await pickDevice(data.serial));
      const devices = parseContextXml(await pluto.contextXml());
      layout = radioLayout(devices, data.direction, data.channels);
      const actualRate = await configureStatic(pluto, layout, data.direction, data.sampleRate);
      const control = controlView(data.memory, data.controlPointer);
      applied = await applyConfiguration(
        pluto, layout, data.direction, readCommand(control), null);
      Atomics.store(control, CTRL.CMD_ACK, applied.seq);
      if (data.direction === 'tx') await disableDds(pluto, layout);
      await pluto.openBuffer(layout, data.bufferSize);
      Atomics.store(control, CTRL.ACTUAL_RATE, Math.round(actualRate));
    } else {
      const control = controlView(data.memory, data.controlPointer);
      applied = readCommand(control);
      Atomics.store(control, CTRL.CMD_ACK, applied?.seq || 0);
      Atomics.store(control, CTRL.ACTUAL_RATE, Math.round(data.sampleRate));
    }
    const control = controlView(data.memory, data.controlPointer);
    Atomics.store(control, CTRL.STATE, RUNNING);
    Atomics.notify(control, CTRL.READ_POS);
    Atomics.notify(control, CTRL.WRITE_POS);
    postMessage({
      type: 'running', direction: data.direction, channels: data.channels,
      actualRate: Atomics.load(control, CTRL.ACTUAL_RATE), fake,
      serial: data.serial || 'first available',
    });
    if (data.direction === 'rx')
      await rxLoop(data, pluto, layout, applied, fake);
    else
      await txLoop(data, pluto, layout, applied, fake);
  } finally {
    if (pluto && data.direction === 'tx' && layout) await setSafeAttenuation(pluto, layout);
    if (pluto) await pluto.close();
  }
}
