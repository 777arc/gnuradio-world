// WebUSB producer for the browser-only Signal Hound BB60 Source.
//
// The BB60's USB protocol is not published. Everything here was derived by
// differential capture of the vendor's own libbb_api against a BB60C, with the
// findings cross-checked against that library's (unstripped) symbol table.
// See docs/signalhound.md for the protocol and how it was established.
//
// WebUSB owns the asynchronous USB side; GNU Radio's synchronous scheduler
// sees only a shared-memory ring of REAL int16 samples at a fixed 70 MS/s and
// a seqlock command mailbox. All decimation happens on the GNU Radio side,
// because the device has no decimation to ask for.

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
  REF_LEVEL: 11,
  OFFSET_HZ: 12,
};
const CTRL_WORDS = 13;

const RUNNING = 1;
const ERROR = 2;
const CANCELLED = 3;

const BB60_FILTERS = [{ vendorId: 0x2817, productId: 0x0005 }];
const CMD_BYTES = 1024;          // every command is a fixed 1024-byte packet
const CMD_ENDPOINT = 1;          // EP1 OUT
const DATA_ENDPOINTS = [1, 2];   // EP 0x81 and 0x82 IN, block-interleaved
// 1 MiB per transfer, 32 blocks. At 140 MB/s a 256 KiB transfer is only 1.9 ms
// of slack, so ordinary event-loop jitter between a completion and its
// resubmission can starve the device -- and this device does not recover from
// being starved, it stops for good. Bigger transfers buy proportionally more
// slack for the same number of round trips through JS.
const TRANSFER_BYTES = 1048576;
const BLOCK_BYTES = 32768;
const BLOCK_WORDS = BLOCK_BYTES / 2;
const HEADER_WORDS = 16;         // magic, flags, then the seq counter x8
const SAMPLES_PER_BLOCK = BLOCK_WORDS - HEADER_WORDS;   // 16368
// The device pushes a constant 140 MB/s and does not throttle: if the host
// stops draining even briefly its FIFO overflows and it stops sending for
// good, rather than resuming. That needs far more in flight than a 20 MS/s
// HackRF does -- 8 transfers per endpoint, 2 MB of reads outstanding.
const TRANSFER_DEPTH = 8;
const BLOCKS_PER_TRANSFER = TRANSFER_BYTES / BLOCK_BYTES;
// The two endpoints are read independently, so their completions can drift by
// everything that is in flight -- TRANSFER_DEPTH x 8 blocks. Reassembly has to
// tolerate at least that much reordering before it may call a gap a real loss;
// too tight a window turns ordinary skew into permanent desynchronisation.
const REORDER_WINDOW = TRANSFER_DEPTH * BLOCKS_PER_TRANSFER * 2;
// Pacing of the open handshake, taken from the captured vendor sequence: a
// gap after the first command, then a block from each endpoint before each
// command that follows.
const OPEN_FIRST_GAP_MS = 85;
// The vendor's own cadence, measured from its command stream: 168 ms between
// the calibration polls, then a settle after the abort and again before the
// arm. Those last two are short but the device is changing state across them.
const OPEN_COMMAND_GAP_MS = 168;
const ABORT_SETTLE_MS = 25;
const SEQ_MODULO = 0x10000;
const SEQ_HALF = SEQ_MODULO / 2;

/** How far `seq` is ahead of `from`, modulo the 16-bit counter. */
function seqAhead(seq, from) {
  return (seq - from) & 0xffff;
}

// The 14-command device-open sequence, captured verbatim. It is byte-identical
// across every centre frequency, sample rate and gain setting tested, and
// across repeat runs, so it is replayed rather than synthesised. It ends with
// an abort (opcode 0x15) that leaves the device idle and ready to configure.
const OPEN_COMMANDS = [
  'AAQAAAEABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAAAgABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAAAkABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAAAoABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAAAsABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAAAwABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAAA0ABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAAA4ABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAAA8ABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAABAABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAABEABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAABIABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'EQQAABMABAAAAAAAAAAAAAEAAH4QAXIfMgABABoAAAABAAB+2ACGJDIAAQAgAAAAAQEAnsgBfjYyAAEANQAAAAECAL4AAthAMgABAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAgADUAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'FQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
];

// Band plan, measured at 10 MHz resolution from 9 kHz to 6.4 GHz.
// byte19 = (index << 5) | attenCode; b17 and u20 are band constants; the
// first IF alternates between two values by band.
const BANDS = [
  { maxMHz:   10, index: 0, b17: 64, u20:  32, ifHz:  160_400_000 },
  { maxMHz: 1880, index: 2, b17: 64, u20: 512, ifHz: 2_420_400_000 },
  { maxMHz: 2500, index: 3, b17: 64, u20: 272, ifHz: 1_220_400_000 },
  { maxMHz: 3140, index: 3, b17: 64, u20: 216, ifHz: 1_220_400_000 },
  { maxMHz: 4200, index: 4, b17: 65, u20: 456, ifHz: 2_420_400_000 },
  { maxMHz: 5100, index: 5, b17: 66, u20: 512, ifHz: 2_420_400_000 },
  { maxMHz: 5500, index: 6, b17: 66, u20: 216, ifHz: 1_220_400_000 },
  { maxMHz: 6400, index: 7, b17: 67, u20: 216, ifHz: 1_220_400_000 },
];

// The LO tunes on a 0.8 MHz grid: the word counts in 0.4 MHz units but is
// always even. It saturates here, a little above 6.39 GHz.
const LO_STEP_HZ = 800_000;
const LO_UNIT_HZ = 400_000;
const LO_MAX_WORD = 19026;

// Where the tuned centre lands inside the 70 MS/s stream once both analogue
// downconversions are done. Measured at 13.4 MHz for the 2420.4 MHz bands
// (three FM stations, agreeing to 0.03 MHz) and assumed to be the same second
// IF for the others, which have not been checked against a known signal.
const DIGITAL_IF_HZ = 13_400_000;

// Reference level, exactly as the vendor library resolves it. Measured by
// sweeping bbConfigureRefLevel from -90 to +20 dBm and reading the command it
// produced. Byte 19's low five bits are the RF attenuation in ~5 dB steps;
// byte 529 switches path above -10 dBm and the attenuation restarts there.
//
// Guessing these was the single biggest source of lost sensitivity: byte 529
// set to 128 at a low reference level buries the signal in the noise floor.
const REF_LEVELS = [
  { dbm: -45, code:  1, byte529:  56 },
  { dbm: -40, code:  5, byte529:  56 },
  { dbm: -35, code: 10, byte529:  56 },
  { dbm: -30, code: 15, byte529:  56 },
  { dbm: -25, code: 20, byte529:  56 },
  { dbm: -20, code: 25, byte529:  56 },
  { dbm: -15, code: 30, byte529:  56 },
  { dbm: -10, code:  1, byte529: 128 },
  { dbm:  -5, code: 10, byte529: 128 },
  { dbm:   0, code: 15, byte529: 128 },
  { dbm:   5, code: 20, byte529: 128 },
  { dbm:  10, code: 25, byte529: 128 },
  { dbm:  15, code: 30, byte529: 128 },
];

/** The first setting that can take a signal this strong without overloading. */
function refLevelSetting(dbm) {
  for (const entry of REF_LEVELS) if (dbm <= entry.dbm) return entry;
  return REF_LEVELS[REF_LEVELS.length - 1];
}

function bandFor(mhz) {
  for (const band of BANDS) if (mhz <= band.maxMHz) return band;
  return BANDS[BANDS.length - 1];
}

// Everything is done in integer hertz. Floating point genuinely gets this
// wrong: (1690 + 2420.4) / 0.8 evaluates to 5137.999999999999 in doubles, so a
// floor of it puts the LO a whole 0.8 MHz step low. Verified against 1046
// captured tuning commands, where integer arithmetic misses none of them.
function loWord(hz, band) {
  const word = 2 * Math.floor((hz + band.ifHz) / LO_STEP_HZ);
  return Math.max(0, Math.min(LO_MAX_WORD, word));
}

function tuning(hz, refLevelDbm) {
  const band = bandFor(hz / 1e6);
  const word = loWord(hz, band);
  const gain = refLevelSetting(refLevelDbm);
  // The LO lands up to one grid step off the request, and past 6.39 GHz it
  // stops moving altogether; either way the residual is the NCO's problem.
  const offsetHz = band.ifHz + DIGITAL_IF_HZ - word * LO_UNIT_HZ + hz;
  return {
    band,
    word,
    byte19: ((band.index << 5) | gain.code) & 0xff,
    byte529: gain.byte529,
    offsetHz: Math.round(offsetHz),
  };
}

// The IQ configuration packet. Only thirteen bytes of the 1024 are non-zero.
//
// Byte 16 is a STOP flag, not a start one: 0 begins streaming with this
// tuning, 1 halts it. This reads backwards from a capture, because a short
// test program initiates and aborts within a few tens of milliseconds and the
// two packets then look like a configure/arm pair. In a three-second capture
// they are three seconds apart. Sending the byte-16=1 packet at startup tells
// the device to stop: it emits the little already in flight and then goes
// quiet forever, which looks exactly like a throughput problem and is not one.
function configCommand(tune, stop) {
  const packet = new Uint8Array(CMD_BYTES);
  packet[0] = 0x00;              // opcode: configure
  packet[1] = 0x04;
  packet[4] = 0x02;              // IQ configuration, as opposed to the open path
  packet[6] = 0x01;
  packet[16] = stop ? 1 : 0;
  packet[17] = tune.band.b17;
  packet[19] = tune.byte19;
  packet[20] = tune.band.u20 & 0xff;
  packet[21] = (tune.band.u20 >> 8) & 0xff;
  packet[22] = tune.word & 0xff;
  packet[23] = (tune.word >> 8) & 0xff;
  packet[24] = 0xc8;
  packet[26] = 0x10;
  packet[29] = 0x10;
  packet[528] = 0x01;
  packet[529] = tune.byte529;
  return packet;
}


/**
 * Reassembles the block stream. Blocks arrive on two endpoints that alternate
 * by sequence number, and the endpoints are read independently, so completions
 * drift apart by however much is in flight. This buffers out that skew, emits
 * blocks strictly in order, and only calls a hole a loss once it is further
 * behind than any legitimate skew could explain.
 *
 * Kept at the top level, and free of USB and shared memory, so that
 * runner/test/bb60_reassembly.test.mjs can drive it directly.
 */
function createReassembler(emit) {
  const pending = new Map();
  let nextSeq = -1;
  const stats = { delivered: 0, gaps: 0, stale: 0, lost: 0, peakPending: 0 };

  return {
    stats,
    get pendingSize() { return pending.size; },
    get cursor() { return nextSeq; },

    /** Forgets everything buffered, for the switch from cal sweep to IQ. */
    reset() {
      pending.clear();
      nextSeq = -1;
    },

    /** Takes one transfer's worth of 16-bit words. */
    push(words) {
      for (let off = 0; off + BLOCK_WORDS <= words.length; off += BLOCK_WORDS) {
        const seq = words[off + 8] & 0xffff;
        // At or behind the cursor: already emitted or already skipped. Keeping
        // these would grow `pending` without bound and force a resynchronise
        // on every call, which is a permanent stall rather than a lost block.
        if (nextSeq >= 0 && seqAhead(seq, nextSeq) >= SEQ_HALF) {
          stats.stale += 1;
          continue;
        }
        pending.set(seq, words.subarray(off + HEADER_WORDS, off + BLOCK_WORDS));
      }
      if (nextSeq < 0) {
        let first = -1;
        for (const seq of pending.keys()) if (first < 0 || seq < first) first = seq;
        nextSeq = first;
      }
      if (pending.size > stats.peakPending) stats.peakPending = pending.size;

      for (;;) {
        const block = pending.get(nextSeq);
        if (block) {
          pending.delete(nextSeq);
          emit(block);
          stats.delivered += 1;
          nextSeq = (nextSeq + 1) & 0xffff;
          continue;
        }
        // A hole inside the window is just skew: the other endpoint has not
        // reported yet, so wait rather than declaring a loss.
        if (pending.size < REORDER_WINDOW) break;

        let target = -1;
        let nearest = SEQ_MODULO;
        for (const seq of pending.keys()) {
          const ahead = seqAhead(seq, nextSeq);
          if (ahead < SEQ_HALF && ahead < nearest) { nearest = ahead; target = seq; }
        }
        if (target < 0) { pending.clear(); break; }
        for (const seq of [...pending.keys()])
          if (seqAhead(seq, target) >= SEQ_HALF) pending.delete(seq);
        stats.gaps += 1;
        stats.lost += nearest * SAMPLES_PER_BLOCK;
        nextSeq = target;
      }
    },
  };
}

const encoder = new TextEncoder();
const recent = [];
const startedAt = performance.now();
let debugTrace = false;
let activeUsb = null;
let activeTune = null;   // the live tuning, so a stop can be addressed to it

// Milestones only -- opening, tuning, arming -- so this is not a hot path.
// Always reported: when this block fails it produces silence, and silence with
// no log is indistinguishable from a flowgraph that never started.
function record(text) {
  const line = `${(performance.now() - startedAt).toFixed(1).padStart(8)}ms ${text}`;
  recent.push(line);
  if (recent.length > 64) recent.shift();
  postMessage({ type: 'trace', text: line });
}

function control(data) {
  return (data.controlView ??=
    new Int32Array(data.memory.buffer, data.controlPointer, CTRL_WORDS));
}

function ring(data) {
  return (data.ringView ??=
    new Int16Array(data.memory.buffer, data.ringPointer, data.capacitySamples));
}

function usedSamples(data) {
  const read = Atomics.load(control(data), CTRL.READ_POS);
  const write = Atomics.load(control(data), CTRL.WRITE_POS);
  return write >= read ? write - read : data.capacitySamples - (read - write);
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

class Bb60Usb {
  constructor(device) {
    this.device = device;
    this.interfaceNumber = 0;
    this.closed = false;
  }

  static async open(device) {
    const bb60 = new Bb60Usb(device);
    try {
      await bb60.open();
      return bb60;
    } catch (error) {
      await bb60.close();
      throw error;
    }
  }

  async open() {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const iface = this.device.configuration.interfaces[0];
    this.interfaceNumber = iface.interfaceNumber;
    await this.device.claimInterface(this.interfaceNumber);
    record(`opened BB60 interface ${this.interfaceNumber}`);
  }

  async command(packet) {
    const result = await this.device.transferOut(CMD_ENDPOINT, packet);
    if (result.status !== 'ok')
      throw new Error(`BB60 command failed (${result.status})`);
  }

  /**
   * Replays the captured device-open sequence.
   *
   * The commands are paced, not sent back to back. The vendor spreads them
   * over about two seconds while continuously reading, because the device runs
   * a band-zero calibration sweep of its own during this window and has to be
   * drained throughout it. Here the streaming pumps are already running and
   * discarding, which is what does the draining; this only has to keep the
   * cadence. Firing the commands as fast as USB allows leaves the device
   * wedged: it accepts them, then sends two transfers after arming and stops.
   */
  async initialise() {
    const packets = OPEN_COMMANDS.map(encoded => {
      const prefix = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const packet = new Uint8Array(CMD_BYTES);
      packet.set(prefix);
      return packet;
    });
    await this.command(packets[0]);
    await new Promise(resolve => setTimeout(resolve, OPEN_FIRST_GAP_MS));
    await this.command(packets[1]);
    for (let i = 2; i < packets.length; ++i) {
      await new Promise(resolve => setTimeout(resolve, OPEN_COMMAND_GAP_MS));
      await this.command(packets[i]);
    }
    record(`replayed ${packets.length} open commands over ` +
      `${(OPEN_FIRST_GAP_MS + (packets.length - 2) * OPEN_COMMAND_GAP_MS) / 1000}s`);
  }

  /**
   * Applies a tuning and starts streaming. The device begins pushing
   * 140 MB/s the moment this lands, so transfers must already be in flight.
   */
  async startStream(tune) {
    await this.command(configCommand(tune, false));
    record(`streaming: band ${tune.band.index}, LO word ${tune.word} ` +
      `(${(tune.word * 0.4).toFixed(1)} MHz), offset ` +
      `${(tune.offsetHz / 1e6).toFixed(3)} MHz, ` +
      `rf byte19 0x${tune.byte19.toString(16)} / 529 ${tune.byte529}`);
  }

  /** Halts streaming. Retuning is a stop followed by a fresh start. */
  async stopStream(tune) {
    await this.command(configCommand(tune, true));
  }

  async close(tune) {
    if (this.closed) return;
    this.closed = true;
    // Leave the device idle; otherwise it keeps pushing 140 MB/s at a host
    // that has stopped reading, and the next open finds it mid-stream.
    if (tune) { try { await this.stopStream(tune); } catch {} }
    try { await this.device.releaseInterface(this.interfaceNumber); } catch {}
    try { await this.device.close(); } catch {}
  }
}

async function pickDevice(serial) {
  const devices = await navigator.usb.getDevices();
  const matching = devices.filter(device => BB60_FILTERS.some(
    filter => filter.vendorId === device.vendorId &&
              filter.productId === device.productId));
  if (!matching.length)
    throw new Error('no Signal Hound BB60 is shared with this site');
  if (!serial) return matching[0];
  const found = matching.find(device => device.serialNumber === serial);
  if (!found)
    throw new Error(
      `no Signal Hound BB60 with serial "${serial}" is shared with this site`);
  return found;
}

function currentTuning(data) {
  const slots = control(data);
  const hi = Atomics.load(slots, CTRL.FREQ_HI);
  const lo = Atomics.load(slots, CTRL.FREQ_LO) >>> 0;
  const hz = hi * 4294967296 + lo;
  return tuning(hz, Atomics.load(slots, CTRL.REF_LEVEL));
}

async function run(data) {
  const usb = await Bb60Usb.open(await pickDevice(data.serial));
  activeUsb = usb;
  postMessage({ type: 'device', serial: usb.device.serialNumber || '' });

  let armed = false;
  let sweepBytes = 0;
  let iqBytes = 0;
  let seenCommand = Atomics.load(control(data), CTRL.CMD_SEQ);
  let tune = currentTuning(data);
  Atomics.store(control(data), CTRL.OFFSET_HZ, tune.offsetHz);

  Atomics.store(control(data), CTRL.STATE, RUNNING);
  record(`ring holds ${data.capacitySamples} samples ` +
    `(${(data.capacitySamples / 70e6 * 1000).toFixed(0)} ms), ` +
    `${TRANSFER_DEPTH} transfers of ${TRANSFER_BYTES} bytes in flight`);


  // Blocks arrive on two endpoints and alternate strictly by sequence number,
  // so they are reassembled by seq rather than by arrival order.
  const pending = new Map();
  let nextSeq = -1;
  let bytes = 0;
  let lost = 0;
  let ringLost = 0;     // dropped because the flowgraph was not draining
  let gapLost = 0;      // missing from the USB stream itself
  let ringDrops = 0;    // the block did not drain fast enough
  let gaps = 0;         // blocks genuinely missing from the USB stream
  let rateBase = performance.now();
  let rateSamples = 0;

  const deliver = block => {
    const view = ring(data);
    const capacity = data.capacitySamples;
    const free = capacity - 1 - usedSamples(data);
    if (free < block.length) {
      ringDrops += 1;
      ringLost += block.length;
      lost = ringLost + gapLost;
      Atomics.store(control(data), CTRL.EVENTS, ringDrops + gaps);
      Atomics.store(control(data), CTRL.LOST_SAMPLES, lost);
      return;
    }
    let write = Atomics.load(control(data), CTRL.WRITE_POS);
    const first = Math.min(block.length, capacity - write);
    view.set(block.subarray(0, first), write);
    if (first < block.length) view.set(block.subarray(first), 0);
    write = (write + block.length) % capacity;
    Atomics.store(control(data), CTRL.WRITE_POS, write);
    Atomics.notify(control(data), CTRL.WRITE_POS);
    rateSamples += block.length;
  };

  const reassembler = createReassembler(deliver);
  const consume = buffer => {
    reassembler.push(new Int16Array(
      buffer.buffer, buffer.byteOffset, buffer.byteLength >> 1));
    const s = reassembler.stats;
    if (s.gaps !== gaps || s.lost !== gapLost) {
      gaps = s.gaps;
      gapLost = s.lost;
      lost = ringLost + gapLost;
      Atomics.store(control(data), CTRL.EVENTS, ringDrops + gaps);
      Atomics.store(control(data), CTRL.LOST_SAMPLES, lost);
    }
  };

  let inFlight = 0;
  let completions = 0;
  const pump = async endpoint => {
    while (!cancelled(data)) {
      let result;
      inFlight += 1;
      try {
        result = await usb.device.transferIn(endpoint, TRANSFER_BYTES);
      } catch (error) {
        // A rejected transfer used to take the whole Promise.all down with no
        // trace of which endpoint failed or why.
        record(`ep ${endpoint} transferIn rejected after ${completions} ` +
          `completions: ${error && error.message ? error.message : error}`);
        throw error;
      } finally {
        inFlight -= 1;
      }
      completions += 1;
      if (cancelled(data)) return;
      if (result.status !== 'ok') {
        record(`ep ${endpoint} status ${result.status} ` +
          `after ${completions} completions`);
        if (result.status === 'stall') {
          await usb.device.clearHalt('in', endpoint);
          continue;
        }
        throw new Error(`BB60 stream failed (${result.status})`);
      }
      const buffer = new Uint8Array(
        result.data.buffer, result.data.byteOffset, result.data.byteLength);
      bytes += buffer.byteLength;
      // Everything before the arm is the device's own calibration sweep. It
      // has to be read -- that is the point of running the pumps this early --
      // but it is not IQ and must not seed the reassembler's cursor.
      if (!armed) { sweepBytes += buffer.byteLength; continue; }
      if (!iqBytes) record(`first IQ transfer: ${buffer.byteLength} bytes on ep ${endpoint}`);
      iqBytes += buffer.byteLength;
      consume(buffer);

      const seq = Atomics.load(control(data), CTRL.CMD_SEQ);
      if (seq !== seenCommand) {
        seenCommand = seq;
        tune = currentTuning(data);
        Atomics.store(control(data), CTRL.OFFSET_HZ, tune.offsetHz);
        await usb.stopStream(activeTune || tune);
        reassembler.reset();
        activeTune = tune;
        await usb.startStream(tune);
        Atomics.store(control(data), CTRL.CMD_ACK, seq);
      }
    }
  };

  // Several transfers per endpoint stay in flight so the device never stalls.
  // Calling pump() runs it up to its first transferIn, so every read is posted
  // before the device is told to start.
  // Reported on a timer rather than per transfer: a stalled device completes
  // no transfers, which is exactly when the numbers are worth seeing.
  const reporter = setInterval(() => {
    const seconds = (performance.now() - rateBase) / 1000;
    const rate = Math.round(rateSamples / seconds);
    Atomics.store(control(data), CTRL.ACTUAL_RATE, rate);
    postMessage({ type: 'rate', actualRate: rate, bytes,
                  events: ringDrops + gaps, lost });
    postMessage({ type: 'trace', text:
      `${(rate / 1e6).toFixed(1)} MS/s in, ` +
      `${(usedSamples(data) / data.capacitySamples * 100).toFixed(0)}% ring, ` +
      `${reassembler.stats.delivered} blocks, ` +
      `pending ${reassembler.pendingSize} (peak ${reassembler.stats.peakPending}), ` +
      `ringDrops ${ringDrops}, seqGaps ${gaps}, ` +
      `stale ${reassembler.stats.stale}, ${(bytes / 1e6).toFixed(1)} MB, ` +
      `${completions} completions, ${inFlight} in flight` });
    rateBase = performance.now();
    rateSamples = 0;
    reassembler.stats.peakPending = 0;
  }, 1000);

  // Reads first, and running for the whole open sequence. The device
  // calibrates itself during open and streams while it does so; the vendor has
  // transfers outstanding from before its first command for exactly this
  // reason. Everything read before the arm is discarded.
  const pumps = [];
  for (const endpoint of DATA_ENDPOINTS)
    for (let i = 0; i < TRANSFER_DEPTH / DATA_ENDPOINTS.length; ++i)
      pumps.push(pump(endpoint));

  try {
    await usb.initialise();
    record(`calibration sweep drained: ${(sweepBytes / 1e6).toFixed(1)} MB`);
    await new Promise(resolve => setTimeout(resolve, ABORT_SETTLE_MS));
    reassembler.reset();
    armed = true;
    activeTune = tune;
    await usb.startStream(tune);
    postMessage({ type: 'running' });

    // If the device is going to stream it starts immediately. Saying so
    // explicitly separates "never started" from "started and then stopped",
    // which look identical in the per-second counters.
    setTimeout(() => {
      if (!iqBytes) record('WARNING: no IQ data within 500 ms of arming');
    }, 500);
    await Promise.all(pumps);
  } finally {
    clearInterval(reporter);
  }
}

onmessage = async event => {
  const message = event.data || {};
  if (message.type === 'stop') {
    if (activeUsb) await activeUsb.close(activeTune);
    return;
  }
  if (message.type === 'trace') { debugTrace = true; return; }
  const data = message;
  try {
    await run(data);
    Atomics.store(control(data), CTRL.STATE, CANCELLED);
    Atomics.notify(control(data), CTRL.WRITE_POS);
    postMessage({ type: 'cancelled' });
  } catch (error) {
    fail(data, error);
  } finally {
    if (activeUsb) await activeUsb.close(activeTune);
  }
};
