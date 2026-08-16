// Bounded producer for RtlSdrSource. One instance of this worker owns one
// RTL-SDR dongle over WebUSB and writes raw unsigned 8-bit IQ pairs into a
// single-producer/single-consumer ring in shared WASM memory.
//
// The RTL2832U register protocol and the R820T/R828D tuner drivers below are
// ported from Jacobo Tarrio's Web RTL-SDR (https://github.com/jtarrio/webrtlsdr)
// and Sandeep Mistry's rtlsdrjs (https://github.com/sandeepmistry/rtlsdrjs),
// both Apache-2.0 and both descended from Google's 2013 Radio Receiver Chrome
// App. Apache-2.0 is one-way compatible into this repository's GPL-3.0.
// The magic numbers ultimately come from the rtl-sdr project. See
// docs/rtlsdr.md for what each layer does and why it is shaped this way.

// ---- Shared control block --------------------------------------------------
// Index order must match struct Control in blocks/src/rtlsdr_source.hpp.
const CTRL = {
  READ_POS: 0,
  WRITE_POS: 1,
  STATE: 2,
  ERROR_LENGTH: 3,
  OVERRUNS: 4,
  DROPPED_PAIRS: 5,
  ACTUAL_RATE: 6,
  CMD_SEQ: 7,
  CMD_ACK: 8,
  FREQ_HI: 9,
  FREQ_LO: 10,
  GAIN_TENTHS: 11,
  PPM: 12,
  FLAGS: 13,
};
const CTRL_WORDS = 14;

const INITIAL = 0;
const RUNNING = 1;
const ERROR = 2;
const CANCELLED = 3;

const FLAG_AGC = 1 << 0;
const FLAG_BIAS_TEE = 1 << 1;

// How many bulk transfers stay queued on the endpoint. One in flight leaves the
// dongle producing into its own FIFO while JavaScript is busy; four is enough
// to cover a garbage collection without adding meaningful latency.
const TRANSFER_DEPTH = 4;

// How many times a rejected control transfer is retried, clearing the bulk
// endpoint's halt between attempts. A retune that loses a race with the USB
// stack should cost a few milliseconds, not the whole flowgraph.
const CONTROL_RETRIES = 4;

// ---- Tracing ---------------------------------------------------------------
// Temporary instrumentation for the retune path. Control transfers only happen
// at startup and when a command is applied -- never during streaming -- so this
// is quiet in the steady state and verbose exactly where the trouble is.
// Set TRACE to false to silence the running commentary; the flight recorder
// below costs nothing and stays.
let TRACE = true;

const t0 = performance.now();
const stamp = () => (performance.now() - t0).toFixed(1).padStart(8) + 'ms';

function trace(...parts) {
  if (TRACE) postMessage({ type: 'trace', text: `${stamp()} ${parts.join(' ')}` });
}

// The last few USB operations, dumped with any failure. A control transfer that
// fails says nothing about what preceded it, and in this driver the operation
// that wedges the device is usually not the one that reports the error.
const recent = [];
function record(entry) {
  recent.push(`${stamp()} ${entry}`);
  if (recent.length > 64) recent.shift();
}

const hex = n => '0x' + n.toString(16);

// ---- Low-level RTL2832U communications -------------------------------------

const BLOCK_DEMOD = 0x000;
const BLOCK_USB = 0x100;
const BLOCK_SYS = 0x200;
const BLOCK_I2C = 0x600;
// Set in a control message's index field to make it a write.
const WRITE_FLAG = 0x10;

class RtlCom {
  constructor(device) {
    this.device = device;
  }

  getBranding() {
    return {
      manufacturer: this.device.manufacturerName,
      model: this.device.productName,
    };
  }

  // WebUSB requires the full open -> configure -> claim sequence; claiming an
  // unopened device fails with "The device must be opened first". Chrome
  // usually selects configuration 1 during open(), but not on every platform,
  // and selecting one that is already active throws, so check before asking.
  async open() {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    await this.device.claimInterface(0);
  }

  async releaseInterface() {
    await this.device.releaseInterface(0);
  }


  async close() {
    await this.device.close();
  }

  // Every register access is a vendor control transfer with bRequest 0, the
  // register in `value` and the block in `index`; writes are the same message
  // with WRITE_FLAG or-ed into the block.
  // A failed control transfer says only "A transfer error has occurred", which
  // is useless on its own: the register being addressed is the whole diagnosis.
  // WebUSB reports failure two different ways -- a rejected promise for a
  // protocol-level failure, a resolved one with a non-'ok' status for a stall --
  // so both have to be turned into the same message.
  static _describe(operation, value, index, cause) {
    return new Error(
      `USB control ${operation} failed for register 0x${value.toString(16)} ` +
      `in block 0x${index.toString(16)}: ${cause}`);
  }

  // A control transfer to this dongle can be rejected outright while the bulk
  // endpoint is unhappy -- most often after the endpoint has been idle long
  // enough for the FIFO to overflow. The device recovers once the pipe is
  // cleared, so a rejection is retried rather than failing the flowgraph: a
  // retune is not worth killing a running graph over.
  async _retry(label, attempt) {
    let lastError;
    for (let tries = 0; tries < CONTROL_RETRIES; ++tries) {
      if (tries) {
        try {
          await this.device.clearHalt('in', 1);
          record(`  clearHalt(in,1) ok before retry ${tries}`);
        } catch (error) {
          record(`  clearHalt(in,1) failed: ${error.message || error}`);
        }
        await new Promise(resolve => setTimeout(resolve, 5 * tries));
      }
      const started = performance.now();
      try {
        const result = await attempt();
        const took = (performance.now() - started).toFixed(1);
        if (result.status === 'ok') {
          record(`${label} ${result.status} ${took}ms` +
                 (tries ? ` (after ${tries} retr${tries === 1 ? 'y' : 'ies'})` : ''));
          return result;
        }
        lastError = `status ${result.status}`;
        record(`${label} status=${result.status} ${took}ms (try ${tries + 1})`);
      } catch (error) {
        lastError = error.message || String(error);
        record(`${label} THREW after ${(performance.now() - started).toFixed(1)}ms ` +
               `(try ${tries + 1}): ${lastError}`);
      }
    }
    await this._probe();
    throw lastError;
  }

  /**
   * Which register blocks still answer, once one has stopped. Retries and
   * clearHalt() have already been shown not to help, so the open question is
   * whether the *device* has stopped talking or only one path to it has: a
   * read from the USB and SYS blocks goes through the same control pipe as the
   * demod write that failed, but touches completely different hardware.
   * Deliberately bypasses _retry() -- this must not recurse.
   */
  async _probe() {
    const probes = [
      ['USB   0x2148/0x100', 0x2148, BLOCK_USB],
      ['SYS   0x3000/0x200', 0x3000, BLOCK_SYS],
      ['DEMOD 0x120/0xa', 0x0120, 0x0a],
    ];
    for (const [label, value, index] of probes) {
      try {
        const result = await this.device.controlTransferIn(
          { requestType: 'vendor', recipient: 'device', request: 0, value, index }, 8);
        record(`  probe READ ${label} -> ${result.status}` +
               (result.status === 'ok'
                 ? ' ' + [...new Uint8Array(result.data.buffer)]
                     .map(b => b.toString(16).padStart(2, '0')).join('')
                 : ''));
      } catch (error) {
        record(`  probe READ ${label} THREW: ${error.message || error}`);
      }
    }
    // Reads passing while writes fail leaves one question: is every OUT
    // transfer refused, or only the demodulator/I2C path? These two write back
    // a value that was just read, so both are no-ops on the hardware whatever
    // the answer turns out to be.
    for (const [label, value, index, bytes] of [
      ['SYS   0x3001/0x200', 0x3001, BLOCK_SYS, [0x18]],
      ['USB   0x2148/0x100', 0x2148, BLOCK_USB, [0x00, 0x00]],
    ]) {
      try {
        const result = await this.device.controlTransferOut(
          { requestType: 'vendor', recipient: 'device', request: 0, value,
            index: index | WRITE_FLAG },
          new Uint8Array(bytes).buffer);
        record(`  probe WRITE ${label} -> ${result.status}`);
      } catch (error) {
        record(`  probe WRITE ${label} THREW: ${error.message || error}`);
      }
    }
    record(`  probe device.opened=${this.device.opened} ` +
           `configuration=${this.device.configuration?.configurationValue}`);
  }

  async _readCtrl(value, index, length) {
    const result = await this._retry(
      `READ  ${hex(value)}/${hex(index)}`,
      () => this.device.controlTransferIn(
        {
          requestType: 'vendor',
          recipient: 'device',
          request: 0,
          value,
          index,
        },
        // Reads shorter than 8 bytes come back short on some dongles; ask for
        // the floor and slice. Inherited from the 2013 Chrome App, still needed.
        Math.max(8, length))
    ).catch(cause => { throw RtlCom._describe('read', value, index, cause); });
    return result.data.buffer.slice(0, length);
  }

  async _writeCtrl(value, index, data) {
    const bytes = [...new Uint8Array(data)]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    await this._retry(
      `WRITE ${hex(value)}/${hex(index)} =${bytes}`,
      () => this.device.controlTransferOut(
        {
          requestType: 'vendor',
          recipient: 'device',
          request: 0,
          value,
          index: index | WRITE_FLAG,
        },
        data)
    ).catch(cause => { throw RtlCom._describe('write', value, index, cause); });
  }

  static _toBuffer(value, length, bigEndian) {
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    if (length === 1) view.setUint8(0, value);
    else if (length === 2) view.setUint16(0, value, !bigEndian);
    else if (length === 4) view.setUint32(0, value, !bigEndian);
    else throw new Error(`cannot encode a ${length}-byte register value`);
    return buffer;
  }

  static _fromBuffer(buffer) {
    const view = new DataView(buffer);
    if (buffer.byteLength === 1) return view.getUint8(0);
    if (buffer.byteLength === 2) return view.getUint16(0, true);
    if (buffer.byteLength === 4) return view.getUint32(0, true);
    throw new Error(`cannot decode a ${buffer.byteLength}-byte register value`);
  }

  async _setReg(block, address, value, length) {
    await this._writeCtrl(address, block, RtlCom._toBuffer(value, length));
  }

  async _getReg(block, address, length) {
    return RtlCom._fromBuffer(await this._readCtrl(address, block, length));
  }

  setUsbReg(address, value, length) {
    return this._setReg(BLOCK_USB, address, value, length);
  }

  setSysReg(address, value) {
    return this._setReg(BLOCK_SYS, address, value, 1);
  }

  getSysReg(address) {
    return this._getReg(BLOCK_SYS, address, 1);
  }

  // A demodulator register is addressed as (addr << 8) | 0x20 within its page,
  // is written big-endian, and needs the dummy read-back below to take effect.
  async setDemodReg(page, address, value, length) {
    await this._writeCtrl(
      (address << 8) | 0x20, page, RtlCom._toBuffer(value, length, true));
    return this._getReg(0x0a, (0x01 << 8) | 0x20, 1);
  }

  // The tuner hangs off an I2C bus the demodulator bridges. The repeater has to
  // be open around every tuner access and closed afterwards.
  async openI2C() {
    await this.setDemodReg(1, 0x01, 0x18, 1);
  }

  async closeI2C() {
    await this.setDemodReg(1, 0x01, 0x10, 1);
  }

  async setI2CReg(address, register, value) {
    await this._writeCtrl(
      address, BLOCK_I2C, new Uint8Array([register, value]).buffer);
  }

  async getI2CReg(address, register) {
    await this._writeCtrl(address, BLOCK_I2C, new Uint8Array([register]).buffer);
    return this._getReg(BLOCK_I2C, address, 1);
  }

  async getI2CRegBuffer(address, register, length) {
    await this._writeCtrl(address, BLOCK_I2C, new Uint8Array([register]).buffer);
    return this._readCtrl(address, BLOCK_I2C, length);
  }

  async setGpioOutput(gpio) {
    const bit = 1 << gpio;
    await this.setSysReg(0x3004, (await this.getSysReg(0x3004)) & ~bit);
    await this.setSysReg(0x3003, (await this.getSysReg(0x3003)) | bit);
  }

  async setGpioBit(gpio, value) {
    const bit = 1 << gpio;
    const current = await this.getSysReg(0x3001);
    await this.setSysReg(0x3001, value ? current | bit : current & ~bit);
  }

  /** One bulk read from the sample endpoint. Returns a Uint8Array. */
  async getSamples(length) {
    const result = await this.device.transferIn(1, length);
    if (result.status === 'ok') return new Uint8Array(result.data.buffer);
    if (result.status === 'stall') {
      await this.device.clearHalt('in', 1);
      return new Uint8Array(0);
    }
    throw new Error(`USB bulk read failed (status ${result.status})`);
  }
}

// ---- R820T / R828D tuners --------------------------------------------------

/** Standard multiplexer configurations per frequency band. */
const STD_MUX_CFGS = [
  [0, 0b1000, 0b00000010, 0b11011111],
  [50, 0b1000, 0b00000010, 0b10111110],
  [55, 0b1000, 0b00000010, 0b10001011],
  [60, 0b1000, 0b00000010, 0b01111011],
  [65, 0b1000, 0b00000010, 0b01101001],
  [70, 0b1000, 0b00000010, 0b01011000],
  [75, 0b0000, 0b00000010, 0b01000100],
  [90, 0b0000, 0b00000010, 0b00110100],
  [110, 0b0000, 0b00000010, 0b00100100],
  [140, 0b0000, 0b00000010, 0b00010100],
  [180, 0b0000, 0b00000010, 0b00010011],
  [250, 0b0000, 0b00000010, 0b00010001],
  [280, 0b0000, 0b00000010, 0b00000000],
  [310, 0b0000, 0b01000001, 0b00000000],
  [588, 0b0000, 0b01000000, 0b00000000],
];

/** RTL-SDR Blog V4 multiplexer configurations. */
const MUX_CFGS_V4 = [
  [0, 0b0000, 0b00000010, 0b11011111],
  [2.2, 0b1000, 0b00000010, 0b11011111],
  [50, 0b1000, 0b00000010, 0b10111110],
  [55, 0b1000, 0b00000010, 0b10001011],
  [60, 0b1000, 0b00000010, 0b01111011],
  [65, 0b1000, 0b00000010, 0b01101001],
  [70, 0b1000, 0b00000010, 0b01011000],
  [75, 0b1000, 0b00000010, 0b01000100],
  [85, 0b0000, 0b00000010, 0b01000100],
  [90, 0b0000, 0b00000010, 0b00110100],
  [110, 0b0000, 0b00000010, 0b00100100],
  [112, 0b1000, 0b00000010, 0b00100100],
  [140, 0b1000, 0b00000010, 0b00010100],
  [172, 0b0000, 0b00000010, 0b00010100],
  [180, 0b0000, 0b00000010, 0b00010011],
  [242, 0b1000, 0b00000010, 0b00010011],
  [250, 0b1000, 0b00000010, 0b00010001],
  [280, 0b1000, 0b00000010, 0b00000000],
  [310, 0b1000, 0b01000001, 0b00000000],
  [588, 0b1000, 0b01000000, 0b00000000],
];

const R8XX_REGISTERS = [
  0b10000011, 0b00110010, 0b01110101, 0b11000000, 0b01000000, 0b11010110,
  0b01101100, 0b11110101, 0b01100011, 0b01110101, 0b01101000, 0b01101100,
  0b10000011, 0b10000000, 0b00000000, 0b00001111, 0b00000000, 0b11000000,
  0b00110000, 0b01001000, 0b11001100, 0b01100000, 0b00000000, 0b01010100,
  0b10101110, 0b01001010, 0b11000000,
];

const BIT_REVS = [
  0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe,
  0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf,
];

const XTAL_FREQ = 28800000;
const IF_FREQ = 3570000;

class R8xx {
  constructor(com, i2c, muxCfgs, vcoPowerRef) {
    this.com = com;
    this.i2c = i2c;
    this.muxCfgs = muxCfgs;
    this.vcoPowerRef = vcoPowerRef;
    this.xtalFreq = XTAL_FREQ;
    this.hasPllLock = false;
    this.shadowRegs = new Uint8Array();
  }

  static async check(com, i2c) {
    await com.openI2C();
    let found = false;
    try {
      found = (await com.getI2CReg(i2c, 0)) === 0x69;
    } catch {
      found = false;
    }
    await com.closeI2C();
    return found;
  }

  getIntermediateFrequency() { return IF_FREQ; }
  getMinimumFrequency() { return XTAL_FREQ; }
  setXtalFrequency(xtalFreq) { this.xtalFreq = xtalFreq; }

  async setFrequency(freq) {
    await this._setMux(freq + IF_FREQ);
    const actual = await this._setPll(freq + IF_FREQ);
    return actual - IF_FREQ;
  }

  async open() {
    // [0] disable zero-IF input [1] DC estimation [3] IQ compensation [4] IQ estimation
    await this.com.setDemodReg(1, 0xb1, 0b00011010, 1);
    // [6] enable ADC_Q [7] disable ADC_I
    await this.com.setDemodReg(0, 0x08, 0b01001101, 1);
    // [0] inverted spectrum
    await this.com.setDemodReg(1, 0x15, 0b00000001, 1);
    await this.com.openI2C();
    this.shadowRegs = new Uint8Array(R8XX_REGISTERS);
    for (let i = 0; i < this.shadowRegs.length; ++i)
      await this.com.setI2CReg(this.i2c, i + 5, this.shadowRegs[i]);
    await this._initElectronics();
    await this.com.closeI2C();
  }

  async close() {
    await this._writeRegMask(0x06, 0b10110001, 0xff);
    await this._writeRegMask(0x05, 0b10110011, 0xff);
    await this._writeRegMask(0x07, 0b00111010, 0xff);
    await this._writeRegMask(0x08, 0b01000000, 0xff);
    await this._writeRegMask(0x09, 0b11000000, 0xff);
    await this._writeRegMask(0x0a, 0b00111010, 0xff);
    await this._writeRegMask(0x0c, 0b00110101, 0xff);
    await this._writeRegMask(0x0f, 0b01101000, 0xff);
    await this._writeRegMask(0x11, 0b00000011, 0xff);
    await this._writeRegMask(0x17, 0b11110100, 0xff);
    await this._writeRegMask(0x19, 0b00001100, 0xff);
  }

  async setAutoGain() {
    await this._writeRegMask(0x05, 0b00000000, 0b00010000);  // LNA gain auto
    await this._writeRegMask(0x07, 0b00010000, 0b00010000);  // mixer gain auto
    await this._writeRegMask(0x0c, 0b00001011, 0b10011111);  // IF VGA 26.5 dB
  }

  async setManualGain(gain) {
    // Experimentally, the LNA moves in 2.3 dB steps and the mixer in 1.2 dB.
    let fullsteps = Math.floor(gain / 3.5);
    let halfsteps = gain - 3.5 * fullsteps >= 2.3 ? 1 : 0;
    if (fullsteps < 0) fullsteps = 0;
    if (fullsteps > 15) fullsteps = 15;
    if (fullsteps === 15) halfsteps = 0;
    await this._writeRegMask(0x05, 0b00010000, 0b00010000);  // LNA gain manual
    await this._writeRegMask(0x07, 0b00000000, 0b00010000);  // mixer gain manual
    await this._writeRegMask(0x0c, 0b00001000, 0b10011111);  // IF VGA 16 dB
    await this._writeRegMask(0x05, fullsteps + halfsteps, 0b00001111);
    await this._writeRegMask(0x07, fullsteps, 0b00001111);
  }

  async _calibrateFilter() {
    let firstTry = true;
    for (;;) {
      await this._writeRegMask(0x0b, 0b01100000, 0b01100000);
      await this._writeRegMask(0x0f, 0b00000100, 0b00000100);
      await this._writeRegMask(0x10, 0b00000000, 0b00000011);
      await this._setPll(56000000);
      if (!this.hasPllLock)
        throw new Error('tuner PLL did not lock during filter calibration');
      await this._writeRegMask(0x0b, 0b00010000, 0b00010000);
      await this._writeRegMask(0x0b, 0b00000000, 0b00010000);
      await this._writeRegMask(0x0f, 0b00000000, 0b00000100);
      const arr = new Uint8Array(await this._readRegBuffer(0x00, 5));
      let filterCap = arr[4] & 0b00001111;
      if (filterCap === 0b00001111) filterCap = 0;
      if (filterCap === 0 || !firstTry) return filterCap;
      firstTry = false;
    }
  }

  async _setMux(freq) {
    const freqMhz = freq / 1000000;
    let i;
    for (i = 0; i < this.muxCfgs.length - 1; ++i)
      if (freqMhz < this.muxCfgs[i + 1][0]) break;
    const cfg = this.muxCfgs[i];
    await this._writeRegMask(0x17, cfg[1], 0b00001000);
    await this._writeRegMask(0x1a, cfg[2], 0b11000011);
    await this._writeRegMask(0x1b, cfg[3], 0b11111111);
    await this._writeRegMask(0x10, 0b00000000, 0b00001011);
    await this._writeRegMask(0x08, 0b00000000, 0b00111111);
    await this._writeRegMask(0x09, 0b00000000, 0b00111111);
  }

  async _setPll(freq) {
    const pllRef = Math.floor(this.xtalFreq);
    await this._writeRegMask(0x10, 0b00000000, 0b00010000);
    await this._writeRegMask(0x1a, 0b00000000, 0b00001100);
    await this._writeRegMask(0x12, 0b10000000, 0b11100000);
    let divNum = Math.min(6, Math.floor(Math.log(1770000000 / freq) / Math.LN2));
    const mixDiv = 1 << (divNum + 1);
    const arr = new Uint8Array(await this._readRegBuffer(0x00, 5));
    const vcoFineTune = (arr[4] & 0x30) >> 4;
    if (vcoFineTune > this.vcoPowerRef) --divNum;
    else if (vcoFineTune < this.vcoPowerRef) ++divNum;
    await this._writeRegMask(0x10, divNum << 5, 0b11100000);
    const vcoFreq = freq * mixDiv;
    const nint = Math.floor(vcoFreq / (2 * pllRef));
    const vcoFra = vcoFreq % (2 * pllRef);
    if (nint > 63) {
      this.hasPllLock = false;
      return 0;
    }
    const ni = Math.floor((nint - 13) / 4);
    const si = (nint - 13) % 4;
    await this._writeRegMask(0x14, ni + (si << 6), 0b11111111);
    await this._writeRegMask(0x12, vcoFra === 0 ? 0b1000 : 0b0000, 0b00001000);
    const sdm = Math.min(65535, Math.floor((32768 * vcoFra) / pllRef));
    await this._writeRegMask(0x16, sdm >> 8, 0b11111111);
    await this._writeRegMask(0x15, sdm & 0xff, 0b11111111);
    await this._getPllLock();
    await this._writeRegMask(0x1a, 0b00001000, 0b00001000);
    return (2 * pllRef * (nint + sdm / 65536)) / mixDiv;
  }

  async _getPllLock() {
    let firstTry = true;
    for (;;) {
      const arr = new Uint8Array(await this._readRegBuffer(0x00, 3));
      if (arr[2] & 0b01000000) {
        this.hasPllLock = true;
        return;
      }
      if (!firstTry) {
        this.hasPllLock = true;
        return;
      }
      await this._writeRegMask(0x12, 0b01100000, 0b11100000);
      firstTry = false;
    }
  }

  async _initElectronics() {
    await this._writeRegMask(0x0c, 0b00000000, 0b00001111);
    await this._writeRegMask(0x13, 0b00110001, 0b00111111);
    await this._writeRegMask(0x1d, 0b00000000, 0b00111000);
    const filterCap = await this._calibrateFilter();
    await this._writeRegMask(0x0a, 0b00010000 | filterCap, 0b00011111);
    await this._writeRegMask(0x0b, 0b01101011, 0b11101111);
    await this._writeRegMask(0x07, 0b00000000, 0b10000000);
    await this._writeRegMask(0x06, 0b00010000, 0b00110000);
    await this._writeRegMask(0x1e, 0b01000000, 0b01100000);
    await this._writeRegMask(0x05, 0b00000000, 0b10000000);
    await this._writeRegMask(0x1f, 0b00000000, 0b10000000);
    await this._writeRegMask(0x0f, 0b00000000, 0b10000000);
    await this._writeRegMask(0x19, 0b01100000, 0b01100000);
    await this._writeRegMask(0x1d, 0b11100101, 0b11000111);
    await this._writeRegMask(0x1c, 0b00100100, 0b11111000);
    await this._writeRegMask(0x0d, 0b01010011, 0b11111111);
    await this._writeRegMask(0x0e, 0b01110101, 0b11111111);
    await this._writeRegMask(0x05, 0b00000000, 0b01100000);
    await this._writeRegMask(0x06, 0b00000000, 0b00001000);
    await this._writeRegMask(0x11, 0b00111000, 0b00001000);
    await this._writeRegMask(0x17, 0b00110000, 0b00110000);
    await this._writeRegMask(0x0a, 0b01000000, 0b01100000);
    await this._writeRegMask(0x1d, 0b00000000, 0b00111000);
    await this._writeRegMask(0x1c, 0b00000000, 0b00000100);
    await this._writeRegMask(0x06, 0b00000000, 0b01000000);
    await this._writeRegMask(0x1a, 0b00110000, 0b00110000);
    await this._writeRegMask(0x1d, 0b00011000, 0b00111000);
    await this._writeRegMask(0x1c, 0b00100100, 0b00000100);
    await this._writeRegMask(0x1e, 0b00001101, 0b00011111);
    await this._writeRegMask(0x1a, 0b00100000, 0b00110000);
  }

  async _readRegBuffer(addr, length) {
    const buf = new Uint8Array(
      await this.com.getI2CRegBuffer(this.i2c, addr, length));
    // The tuner returns each byte bit-reversed.
    for (let i = 0; i < buf.length; ++i) {
      const b = buf[i];
      buf[i] = (BIT_REVS[b & 0xf] << 4) | BIT_REVS[b >> 4];
    }
    return buf.buffer;
  }

  async _writeRegMask(addr, value, mask) {
    const current = this.shadowRegs[addr - 5];
    const next = (current & ~mask) | (value & mask);
    this.shadowRegs[addr - 5] = next;
    await this.com.setI2CReg(this.i2c, addr, next);
  }
}

class R820T extends R8xx {
  constructor(com) {
    super(com, 0x34, STD_MUX_CFGS, 2);
  }

  static async maybeInit(com) {
    if (!(await R8xx.check(com, 0x34))) return null;
    const tuner = new R820T(com);
    await tuner.open();
    return tuner;
  }
}

/**
 * Identifies the tuner. The probe reads chip id 0x69 from an I2C address, but a
 * *read* from an address with nothing on it does not reliably fail on every
 * dongle -- so a candidate that answers the probe and then NAKs its first write
 * has to fall through to the next one rather than abort. Getting that wrong
 * looks exactly like broken USB: "control write failed for register 0x34 in
 * block 0x600", from a dongle whose tuner was at 0x74 all along.
 */
async function findTuner(com) {
  const { manufacturer, model } = com.getBranding();
  const attempts = [];
  for (const [name, maybeInit] of
       [['R820T', R820T.maybeInit], ['R828D', R828D.maybeInit]]) {
    try {
      const tuner = await maybeInit(com);
      if (tuner) {
        postMessage({ type: 'tuner', tuner: name, manufacturer, model });
        return tuner;
      }
      attempts.push(`${name}: not present`);
    } catch (error) {
      attempts.push(`${name}: ${error.message || error}`);
    }
  }
  throw new Error(
    `could not initialize a tuner on this dongle (${manufacturer || '?'} / ` +
    `${model || '?'}). Only R820T/R820T2/R860 and R828D are supported. ` +
    `Tried -- ${attempts.join('; ')}`);
}

class R828D extends R8xx {
  constructor(com, isBlogV4) {
    super(com, 0x74, isBlogV4 ? MUX_CFGS_V4 : STD_MUX_CFGS, 1);
    this.isBlogV4 = isBlogV4;
    this.input = -1;
  }

  static async maybeInit(com) {
    if (!(await R8xx.check(com, 0x74))) return null;
    const { manufacturer, model } = com.getBranding();
    const isBlogV4 = manufacturer === 'RTLSDRBlog' && model === 'Blog V4';
    const tuner = new R828D(com, isBlogV4);
    await tuner.open();
    return tuner;
  }

  // The RTL-SDR Blog V4 puts an upconverter and a three-way input switch in
  // front of the tuner, so HF arrives shifted up by one crystal frequency.
  async setFrequency(freq) {
    const upconvert = this.isBlogV4 && freq < 28800000 ? 28800000 : 0;
    const actual = await super.setFrequency(freq + upconvert);
    if (this.isBlogV4) {
      const input = freq <= 28800000 ? 2 : freq < 250000000 ? 1 : 0;
      if (this.input !== input) {
        this.input = input;
        if (input === 0) {
          await this._writeRegMask(0x06, 0x00, 0x08);
          await this._writeRegMask(0x05, 0x00, 0x60);
        } else if (input === 1) {
          await this._writeRegMask(0x06, 0x00, 0x08);
          await this._writeRegMask(0x05, 0x60, 0x60);
        } else {
          await this._writeRegMask(0x06, 0x08, 0x08);
          await this._writeRegMask(0x05, 0x20, 0x60);
        }
        await this.com.setGpioOutput(5);
        await this.com.setGpioBit(5, input === 2 ? 0 : 1);
      }
    } else {
      // Cable 1 LNA off above 345 MHz, on below.
      const input = freq > 345000000 ? 0 : 1;
      if (this.input !== input) {
        this.input = input;
        await this._writeRegMask(0x05, input === 0 ? 0x00 : 0x60, 0x60);
      }
    }
    return actual - upconvert;
  }

  getMinimumFrequency() {
    return this.isBlogV4 ? 0 : super.getMinimumFrequency();
  }
}

// ---- The RTL2832U demodulator ----------------------------------------------

class RTL2832U {
  constructor(com, tuner) {
    this.com = com;
    this.tuner = tuner;
    this.ppm = 0;
    this.gain = null;
    this.centerFrequency = 0;
    this.directSamplingMethod = 0;  // 0 off, 1 I branch, 2 Q branch
    this.directSampling = 0;
    this.biasTee = false;
  }

  static async open(device) {
    const com = new RtlCom(device);
    await com.open();
    try {
      await RTL2832U._init(com);
      return new RTL2832U(com, await findTuner(com));
    } catch (error) {
      // Hand the dongle back rather than leaving it claimed until the tab is
      // closed, which would make the next attempt fail for a different reason.
      try {
        await com.releaseInterface();
        await com.close();
      } catch {}
      throw error;
    }
  }

  static async _init(com) {
    // USB_SYSCTL [0] DMA enable [3] full packet mode
    await com.setUsbReg(0x2000, 0b00001001, 1);
    // USB_EPA_MAXPKT: 0x200 bytes
    await com.setUsbReg(0x2158, 0x0200, 2);
    // USB_EPA_CTL [4] stall endpoint [9] FIFO reset
    await com.setUsbReg(0x2148, 0b0000001000010000, 2);
    // DEMOD_CTL1, then DEMOD_CTL [3] ADC_Q [5] release reset [6] ADC_I [7] PLL
    await com.setSysReg(0x300b, 0b00100010);
    await com.setSysReg(0x3000, 0b11101000);
    // Reset the demodulator.
    await com.setDemodReg(1, 0x01, 0b00010100, 1);
    await com.setDemodReg(1, 0x01, 0b00010000, 1);
    // Spectrum not inverted, adjacent channel rejection off.
    await com.setDemodReg(1, 0x15, 0b00000000, 1);
    // Clear the carrier frequency offset registers.
    for (let i = 0; i < 6; ++i) await com.setDemodReg(1, 0x16 + i, 0x00, 1);
    // The default FIR filter coefficients.
    const FIR = [
      0xca, 0xdc, 0xd7, 0xd8, 0xe0, 0xf2, 0x0e, 0x35,
      0x06, 0x50, 0x9c, 0x0d, 0x71, 0x11, 0x14, 0x71,
      0x74, 0x19, 0x41, 0xa5,
    ];
    for (let i = 0; i < FIR.length; ++i)
      await com.setDemodReg(1, 0x1c + i, FIR[i], 1);
    // Enable SDR mode, disable DAGC.
    await com.setDemodReg(0, 0x19, 0x05, 1);
    // Init the FSM state-holding registers.
    await com.setDemodReg(1, 0x93, 0xf0, 1);
    await com.setDemodReg(1, 0x94, 0x0f, 1);
    // Disable AGC, the RF/IF AGC loop and the PID filter.
    await com.setDemodReg(1, 0x11, 0x00, 1);
    await com.setDemodReg(1, 0x04, 0x00, 1);
    await com.setDemodReg(0, 0x61, 0x60, 1);
    // Default ADC_I/ADC_Q datapath.
    await com.setDemodReg(0, 0x06, 0x80, 1);
    // Zero-IF mode, DC cancellation, IQ estimation and compensation.
    await com.setDemodReg(1, 0xb1, 0x1b, 1);
    // Disable the 4.096 MHz clock output on pin TP_CK0.
    await com.setDemodReg(0, 0x0d, 0x83, 1);
  }

  _xtalFrequency() {
    return Math.floor(XTAL_FREQ * (1 + this.ppm / 1000000));
  }

  async setSampleRate(rate) {
    // The RTL2832U resamples by a 26-bit ratio off its crystal, so most rates
    // are not exactly achievable. Report what it will actually run at.
    let ratio = Math.floor((this._xtalFrequency() * (1 << 22)) / rate);
    ratio &= 0x0ffffffc;
    const realRate = Math.floor((this._xtalFrequency() * (1 << 22)) / ratio);
    await this.com.setDemodReg(1, 0x9f, (ratio >> 16) & 0xffff, 2);
    await this.com.setDemodReg(1, 0xa1, ratio & 0xffff, 2);
    await this._resetDemodulator();
    return realRate;
  }

  async _resetDemodulator() {
    await this.com.setDemodReg(1, 0x01, 0b00010100, 1);
    await this.com.setDemodReg(1, 0x01, 0b00010000, 1);
  }

  async setFrequencyCorrection(ppm) {
    this.ppm = ppm;
    const offset = -1 * Math.floor((ppm * (1 << 24)) / 1000000);
    await this.com.setDemodReg(1, 0x3e, (offset >> 8) & 0x3f, 1);
    await this.com.setDemodReg(1, 0x3f, offset & 0xff, 1);
    this.tuner.setXtalFrequency(this._xtalFrequency());
    const ifFreq = this.tuner.getIntermediateFrequency();
    if (ifFreq !== 0) await this._setIfFrequency(ifFreq);
    if (this.centerFrequency !== 0)
      await this.setCenterFrequency(this.centerFrequency);
  }

  async _setIfFrequency(ifFreq) {
    const xtal = this._xtalFrequency();
    const multiplier = -1 * Math.floor((ifFreq * (1 << 22)) / xtal);
    await this.com.setDemodReg(1, 0x19, (multiplier >> 16) & 0x3f, 1);
    await this.com.setDemodReg(1, 0x1a, (multiplier >> 8) & 0xff, 1);
    await this.com.setDemodReg(1, 0x1b, multiplier & 0xff, 1);
    return (multiplier * xtal) / (1 << 22);
  }

  // The tuner sits on an I2C bus the demodulator bridges, so every tuner access
  // has to be wrapped in the repeater -- writing with it closed is NAKed, and
  // surfaces as "control write failed for register 0x34 in block 0x600".
  // setCenterFrequency() opens it around its own tuner call; this needs its own.
  async setGain(gain) {
    this.gain = gain;
    await this.com.openI2C();
    try {
      // In direct sampling the tuner is powered down and there is nothing to
      // set a gain on: the RTL's own AGC is the only control left.
      if (this.directSampling) await this._enableRtlAgc(gain === null);
      else if (gain === null) await this.tuner.setAutoGain();
      else await this.tuner.setManualGain(gain);
    } finally {
      await this.com.closeI2C();
    }
  }

  async _enableRtlAgc(enable) {
    await this.com.setDemodReg(0, 0x19, enable ? 0x25 : 0x05, 1);
  }

  async setDirectSamplingMethod(method) {
    if (this.directSamplingMethod === method) return;
    this.directSamplingMethod = method;
    if (this.centerFrequency !== 0)
      await this.setCenterFrequency(this.centerFrequency);
  }

  async _maybeSetDirectSampling(frequency) {
    const low = frequency < this.tuner.getMinimumFrequency();
    const method = low ? this.directSamplingMethod : 0;
    if (this.directSampling === method) return;
    const tunerWasOn = this.directSampling === 0;
    this.directSampling = method;
    if (method !== 0) {
      if (tunerWasOn) {
        await this.com.openI2C();
        await this.tuner.close();
        await this.com.closeI2C();
      }
      await this.com.setDemodReg(1, 0xb1, 0b00011010, 1);
      await this.com.setDemodReg(1, 0x15, 0b00000000, 1);
      // Swap the ADC_I/ADC_Q datapath when the Q branch is selected.
      await this.com.setDemodReg(
        0, 0x06, method === 1 ? 0b10000000 : 0b10010000, 1);
      await this._enableRtlAgc(true);
    } else {
      await this.com.openI2C();
      await this.tuner.open();
      await this.com.closeI2C();
      const ifFreq = this.tuner.getIntermediateFrequency();
      if (ifFreq !== 0) await this._setIfFrequency(ifFreq);
      await this.com.setDemodReg(1, 0x15, 0b00000001, 1);
      await this.com.setDemodReg(0, 0x06, 0b10000000, 1);
      await this._enableRtlAgc(false);
      await this.setGain(this.gain);
    }
  }

  async setCenterFrequency(freq) {
    await this._maybeSetDirectSampling(freq);
    let actual;
    if (this.directSampling) {
      actual = await this._setIfFrequency(freq);
    } else {
      await this.com.openI2C();
      actual = await this.tuner.setFrequency(freq);
      await this.com.closeI2C();
    }
    this.centerFrequency = freq;
    return actual;
  }

  async enableBiasTee(enabled) {
    this.biasTee = enabled;
    await this.com.setGpioOutput(0);
    await this.com.setGpioBit(0, enabled ? 1 : 0);
  }

  /**
   * Stalls the bulk endpoint and resets its FIFO, which stops the device
   * streaming. USB_EPA_CTL: [4] stall endpoint, [9] FIFO reset -- the value
   * librtlsdr spells 0x1002 (it writes registers big-endian; this writes them
   * little-endian, so both put 10 02 on the wire).
   */
  async stopStream() {
    await this.com.setUsbReg(0x2148, 0b0000001000010000, 2);
  }

  /** Clears the stall, so the device streams again. */
  async startStream() {
    await this.com.setUsbReg(0x2148, 0x0000, 2);
  }

  /**
   * Applies `run` with the device's streaming stopped.
   *
   * The RTL2832U refuses writes to its demodulator and to the I2C repeater
   * while the endpoint DMA is running -- they fail as "A transfer error has
   * occurred" while *reads* of the very same registers succeed, and while
   * writes to the USB and SYS blocks succeed. Neither draining the host's
   * transfer queue nor re-claiming the interface helps, because neither stops
   * the device. Only the stall bit does. Getting this wrong is expensive to
   * diagnose: the retune fails on the I2C repeater write, which looks like a
   * tuner problem and is not.
   */
  async aroundCommands(run) {
    await this.stopStream();
    try {
      return await run();
    } finally {
      await this.startStream();
    }
  }

  /** Clears the endpoint FIFO. Required before the first bulk read. */
  async resetBuffer() {
    await this.stopStream();
    await this.startStream();
  }

  readSamples(byteLength) {
    return this.com.getSamples(byteLength);
  }

  async close() {
    try {
      await this.com.openI2C();
      await this.tuner.close();
      await this.com.closeI2C();
      await this.com.releaseInterface();
      // Without this the dongle stays claimed by the page until it unloads, so
      // stopping and re-running a flowgraph would fail on the second attempt.
      await this.com.close();
    } catch {
      // A dongle that has already been unplugged cannot be shut down tidily.
    }
  }
}

// ---- A device that needs no hardware ---------------------------------------

// Selected by a Device of 'fake' (optionally 'fake:<tone Hz>'). Produces a
// complex tone plus a little noise, paced at the configured sample rate, so the
// whole ring/futex/conversion path is exercised by test_smoke.mjs on a machine
// with nothing plugged in. See docs/rtlsdr.md.
class FakeRtl {
  constructor(toneHz) {
    this.toneHz = toneHz;
    this.rate = 2048000;
    this.phase = 0;
    this.nextDue = 0;
  }

  async setSampleRate(rate) {
    // Round the same way real hardware does, so a test sees a plausible rate.
    let ratio = Math.floor((XTAL_FREQ * (1 << 22)) / rate);
    ratio &= 0x0ffffffc;
    this.rate = Math.floor((XTAL_FREQ * (1 << 22)) / ratio);
    return this.rate;
  }

  async setFrequencyCorrection() {}
  async setCenterFrequency(freq) { return freq; }
  async setGain() {}
  async setDirectSamplingMethod() {}
  async enableBiasTee() {}
  async resetBuffer() { this.nextDue = 0; }
  async aroundCommands(run) { return run(); }   // no interface to retake
  async close() {}

  async readSamples(byteLength) {
    const pairs = byteLength >> 1;
    const now = performance.now();
    // Pace the generator: a source that returns instantly would spin the CPU
    // and let the flowgraph run at whatever rate the scheduler can manage,
    // which is not a useful stand-in for a radio.
    //
    // The deadline has to be claimed *before* the first await. TRANSFER_DEPTH
    // of these run concurrently; advancing nextDue after the await instead lets
    // all of them read the same deadline and wake together, which delivers the
    // right number of samples per second in bursts rather than spread out. The
    // long-run rate survives that, but the burstiness does not resemble a radio
    // and would mask a ring that is too shallow.
    if (!this.nextDue || this.nextDue < now - 1000) this.nextDue = now;
    const due = this.nextDue;
    this.nextDue = due + (pairs / this.rate) * 1000;
    const wait = due - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));

    const out = new Uint8Array(byteLength);
    const step = (2 * Math.PI * this.toneHz) / this.rate;
    for (let i = 0; i < pairs; ++i) {
      this.phase += step;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      out[2 * i] = Math.max(0, Math.min(255,
        Math.round(128 + 90 * Math.cos(this.phase) + 4 * (Math.random() - 0.5))));
      out[2 * i + 1] = Math.max(0, Math.min(255,
        Math.round(128 + 90 * Math.sin(this.phase) + 4 * (Math.random() - 0.5))));
    }
    return out;
  }
}

// ---- Device selection ------------------------------------------------------

// The USB IDs librtlsdr recognises. The overwhelmingly common one is the first.
const RTL_DEVICE_FILTERS = [
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

function matchesRtl(device) {
  return RTL_DEVICE_FILTERS.some(
    f => f.vendorId === device.vendorId && f.productId === device.productId);
}

async function pickDevice(serial) {
  if (!navigator.usb)
    throw new Error(
      'this browser has no WebUSB: use Chrome, Edge or Opera (Firefox and ' +
      'Safari do not implement it)');
  // The permission is granted per origin by the editor, on a user gesture, and
  // this worker only re-acquires it. requestDevice() is not callable here.
  const devices = (await navigator.usb.getDevices()).filter(matchesRtl);
  if (!devices.length)
    throw new Error(
      'no RTL-SDR has been shared with this site: open the block\'s ' +
      'properties and choose one, or check that the dongle is plugged in');
  if (!serial) return devices[0];
  const match = devices.find(d => d.serialNumber === serial);
  if (!match)
    throw new Error(
      `no RTL-SDR with serial "${serial}" is available (${devices.length} ` +
      `other dongle(s) shared with this site)`);
  return match;
}

// ---- Worker plumbing -------------------------------------------------------

function controlView(memory, pointer) {
  return new Int32Array(memory.buffer, pointer, CTRL_WORDS);
}

function fail(data, error) {
  const { memory, controlPointer, errorPointer, errorCapacity } = data;
  const message = String(error instanceof Error ? error.message : error);
  try {
    const encoded = new TextEncoder().encode(message);
    const length = Math.min(encoded.byteLength, errorCapacity - 1);
    new Uint8Array(memory.buffer, errorPointer, errorCapacity).fill(0);
    new Uint8Array(memory.buffer, errorPointer, length)
      .set(encoded.subarray(0, length));
    const control = controlView(memory, controlPointer);
    Atomics.store(control, CTRL.ERROR_LENGTH, length);
    Atomics.store(control, CTRL.STATE, ERROR);
    Atomics.notify(control, CTRL.WRITE_POS);
  } catch {
    // Memory may already be gone if the page is tearing down.
  }
  // The operation that reports a failure is often not the one that caused it,
  // so ship the run-up with the error rather than only the last line.
  postMessage({ type: 'error', message, recent: [...recent] });
  close();
}

/** Seqlock read of the command mailbox. Null if it could not be read cleanly. */
function readCommand(control) {
  for (let attempt = 0; attempt < 8; ++attempt) {
    const seq = Atomics.load(control, CTRL.CMD_SEQ);
    const command = {
      seq,
      freq: Atomics.load(control, CTRL.FREQ_HI) * 4294967296 +
            (Atomics.load(control, CTRL.FREQ_LO) >>> 0),
      gainTenths: Atomics.load(control, CTRL.GAIN_TENTHS),
      ppm: Atomics.load(control, CTRL.PPM),
      flags: Atomics.load(control, CTRL.FLAGS),
    };
    if (Atomics.load(control, CTRL.CMD_SEQ) === seq) return command;
  }
  return null;
}

onmessage = event => {
  void run(event.data).catch(error => fail(event.data, error));
};

async function run(data) {
  const {
    serial, memory, ringPointer, capacityPairs,
    controlPointer, sampleRate, directSampling, bufflen,
  } = data;
  if (!Number.isInteger(capacityPairs) || capacityPairs < 2)
    throw new Error('invalid RTL-SDR ring capacity');
  if (!Number.isInteger(bufflen) || bufflen <= 0 || bufflen % 512 !== 0)
    throw new Error('invalid RTL-SDR transfer size');

  const isFake = serial === 'fake' || serial.startsWith('fake:');
  let rtl;
  if (isFake) {
    const tone = Number(serial.slice(5)) || 100000;
    rtl = new FakeRtl(tone);
  } else {
    rtl = await RTL2832U.open(await pickDevice(serial));
  }

  let applied = null;
  try {
    const actualRate = await rtl.setSampleRate(sampleRate);
    await rtl.setDirectSamplingMethod(directSampling);

    // The opening configuration arrives through the same mailbox a later
    // retune does, so there is one code path rather than two.
    const control = controlView(memory, controlPointer);
    const initial = readCommand(control);
    if (initial) {
      await rtl.setFrequencyCorrection(initial.ppm);
      await rtl.setCenterFrequency(initial.freq);
      await rtl.setGain(
        initial.flags & FLAG_AGC ? null : initial.gainTenths / 10);
      await rtl.enableBiasTee((initial.flags & FLAG_BIAS_TEE) !== 0);
      applied = initial;
      Atomics.store(control, CTRL.CMD_ACK, initial.seq);
    }

    Atomics.store(control, CTRL.ACTUAL_RATE, Math.round(actualRate));
    Atomics.store(control, CTRL.STATE, RUNNING);
    Atomics.notify(control, CTRL.WRITE_POS);
    postMessage({ type: 'running', actualRate, fake: isFake });

    await rtl.resetBuffer();
    await stream(data, rtl, applied);
  } finally {
    await rtl.close();
  }
}

/** Whether the block has staged a command the worker has not applied yet. */
function commandWaiting(control, applied) {
  return !applied || Atomics.load(control, CTRL.CMD_SEQ) !== applied.seq;
}

async function applyCommands(rtl, control, applied) {
  const command = readCommand(control);
  if (!command || (applied && command.seq === applied.seq)) return applied;
  trace(`command seq=${command.seq} freq=${command.freq} gain=${command.gainTenths / 10}` +
        ` ppm=${command.ppm} flags=${hex(command.flags)}` +
        (applied ? ` (was seq=${applied.seq} freq=${applied.freq})` : ' (first)'));
  record(`--- applying command seq=${command.seq} freq=${command.freq} ---`);
  // Compare against what was applied before, throughout. Reassigning `applied`
  // part-way through makes every later comparison compare the new command with
  // itself, which silently skips the fields that changed alongside the first.
  const previous = applied;

  // Only issue the USB writes a changed field actually needs: retuning opens
  // the I2C repeater and walks the tuner's PLL, far too expensive to redo on
  // every poll. setFrequencyCorrection re-tunes internally, but off the centre
  // frequency the device already had, so a ppm change still needs the
  // frequency re-applied after it.
  const step = async (what, run) => {
    const started = performance.now();
    trace(`  ${what} ...`);
    try {
      const value = await run();
      trace(`  ${what} ok in ${(performance.now() - started).toFixed(1)}ms` +
            (value === undefined ? '' : ` -> ${value}`));
      return value;
    } catch (error) {
      trace(`  ${what} FAILED after ${(performance.now() - started).toFixed(1)}ms: ` +
            `${error.message || error}`);
      throw error;
    }
  };

  const ppmChanged = !previous || command.ppm !== previous.ppm;
  if (ppmChanged)
    await step(`setFrequencyCorrection(${command.ppm})`,
      () => rtl.setFrequencyCorrection(command.ppm));
  if (ppmChanged || command.freq !== previous.freq)
    await step(`setCenterFrequency(${command.freq})`,
      () => rtl.setCenterFrequency(command.freq));

  const agc = (command.flags & FLAG_AGC) !== 0;
  if (!previous || agc !== ((previous.flags & FLAG_AGC) !== 0) ||
      command.gainTenths !== previous.gainTenths)
    await step(`setGain(${agc ? 'auto' : command.gainTenths / 10})`,
      () => rtl.setGain(agc ? null : command.gainTenths / 10));

  const bias = (command.flags & FLAG_BIAS_TEE) !== 0;
  if (!previous || bias !== ((previous.flags & FLAG_BIAS_TEE) !== 0))
    await step(`enableBiasTee(${bias})`, () => rtl.enableBiasTee(bias));

  Atomics.store(control, CTRL.CMD_ACK, command.seq);
  return command;
}

async function stream(data, rtl, applied) {
  const { memory, ringPointer, capacityPairs, controlPointer, bufflen } = data;
  const pending = [];
  let carry = -1;        // odd trailing byte held over to keep I/Q aligned
  let bytesRead = 0;
  let overruns = 0;
  let droppedPairs = 0;

  const cancelled = () =>
    Atomics.load(controlView(memory, controlPointer), CTRL.STATE) === CANCELLED;
  const finish = type => {
    postMessage({ type, bytesRead, overruns, droppedPairs });
    close();
  };

  /** Files one completed bulk read into the ring. */
  const deliver = chunk => {
    if (!chunk.byteLength) return;
    bytesRead += chunk.byteLength;

    // A bulk read is always a whole number of 512-byte packets in practice,
    // but a truncated one must not shift I and Q for the rest of the session.
    if (carry >= 0) {
      const merged = new Uint8Array(chunk.byteLength + 1);
      merged[0] = carry;
      merged.set(chunk, 1);
      chunk = merged;
      carry = -1;
    }
    if (chunk.byteLength & 1) {
      carry = chunk[chunk.byteLength - 1];
      chunk = chunk.subarray(0, chunk.byteLength - 1);
    }
    const pairs = chunk.byteLength >> 1;
    if (!pairs) return;

    // ALLOW_MEMORY_GROWTH may have detached every view while the transfer was
    // in flight, so re-derive them before touching shared memory.
    const control = controlView(memory, controlPointer);
    const readPosition = Atomics.load(control, CTRL.READ_POS);
    const writePosition = Atomics.load(control, CTRL.WRITE_POS);
    const used = writePosition >= readPosition
      ? writePosition - readPosition
      : capacityPairs - (readPosition - writePosition);
    const free = capacityPairs - used - 1;

    // A radio cannot be told to wait. Dropping this transfer and counting it is
    // the only honest option; blocking here would just move the overflow into
    // the dongle's own FIFO, where it goes unreported.
    if (free < pairs) {
      ++overruns;
      droppedPairs += pairs;
      Atomics.store(control, CTRL.OVERRUNS, overruns);
      Atomics.store(control, CTRL.DROPPED_PAIRS, droppedPairs);
      if (overruns === 1 || overruns % 64 === 0)
        postMessage({ type: 'overrun', bytesRead, overruns, droppedPairs });
      return;
    }

    const ring = new Uint8Array(memory.buffer, ringPointer, capacityPairs * 2);
    const pairsBeforeWrap = Math.min(pairs, capacityPairs - writePosition);
    ring.set(chunk.subarray(0, pairsBeforeWrap * 2), writePosition * 2);
    if (pairsBeforeWrap < pairs)
      ring.set(chunk.subarray(pairsBeforeWrap * 2), 0);

    Atomics.store(
      control, CTRL.WRITE_POS, (writePosition + pairs) % capacityPairs);
    Atomics.notify(control, CTRL.WRITE_POS);

    if ((bytesRead & ((16 * 1024 * 1024) - 1)) < chunk.byteLength)
      postMessage({ type: 'progress', bytesRead, overruns, droppedPairs });
  };

  for (;;) {
    if (cancelled()) return finish('cancelled');

    // A command means stopping the *device*, not just pausing the reads: the
    // demodulator refuses register writes while its endpoint DMA is running.
    // So deliver what has already been requested, stall the endpoint, retune,
    // and clear the stall. See RTL2832U.aroundCommands().
    if (commandWaiting(controlView(memory, controlPointer), applied)) {
      const started = performance.now();
      const queued = pending.length;
      while (pending.length) deliver(await pending.shift());
      trace(`command pending: drained ${queued} transfer(s); ` +
            `bytesRead=${bytesRead} overruns=${overruns}`);
      record(`--- applying command after draining ${queued} transfers ---`);
      if (cancelled()) return finish('cancelled');
      const control = controlView(memory, controlPointer);
      applied = await rtl.aroundCommands(
        () => applyCommands(rtl, control, applied));
      carry = -1;   // the FIFO reset dropped this byte's partner
      trace(`command applied in ${(performance.now() - started).toFixed(1)}ms; ` +
            'stream resuming');
    }

    // Keep the endpoint queue full: the dongle streams continuously and a gap
    // between transfers is a gap in the samples.
    while (pending.length < TRANSFER_DEPTH)
      pending.push(rtl.readSamples(bufflen));
    const chunk = await pending.shift();

    if (cancelled()) return finish('cancelled');
    deliver(chunk);
  }
}
