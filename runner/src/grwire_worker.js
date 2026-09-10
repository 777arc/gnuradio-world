// GRWire reader worker: one WebSocket to a grwire daemon, into a shared ring.
//
// This is runner/src/rtlsdr_reader.js with the transport swapped. The producer
// is push rather than pull -- frames arrive on a socket instead of being asked
// for over USB -- so there is no transfer queue, but everything downstream of
// that is deliberately identical: drop when the ring is full and count it,
// re-derive every typed-array view after every await, and use
// Atomics.notify on WRITE_POS as the only wakeup.
//
// See docs/grwire.md. The frame layout is specified in grwire/proto/wire.json
// and duplicated here because a worker cannot import from Rust or C++.

// Index order must match struct Control in blocks/src/grwire_source.hpp.
const CTRL = {
  READ_POS: 0,
  WRITE_POS: 1,
  STATE: 2,
  ERROR_LENGTH: 3,
  OVERRUNS: 4,
  LOST_SAMPLES: 5,
  ACTUAL_RATE: 6,
  CMD_SEQ: 7,
  CMD_ACK: 8,
  FREQ_HI: 9,
  FREQ_LO: 10,
  OFFSET_HI: 11,
  OFFSET_LO: 12,
  GAIN_TENTHS: 13,
  BANDWIDTH: 14,
  FLAGS: 15,
  NET_DROP: 16,
  CLIENT_DROP: 17,
  STAGE1: 18,
  STAGE2: 19,
  STAGE3: 20,
};
const CTRL_WORDS = 21;

// A stage the flowgraph is not driving. Zero cannot mean this, because 0 dB is
// a real gain and forcing it would deafen the radio.
const STAGE_UNSET = -2147483648;

const INITIAL = 0;
const RUNNING = 1;
const ERROR = 2;
const CANCELLED = 3;

const FLAG_AGC = 1 << 0;

// grwire.v1 binary frame header.
const MAGIC = 0x31575247; // 'GRW1' little-endian
const HEADER_BYTES = 32;
const FLAG_DISCONTINUITY = 1;
const WIRE_BYTES = { 1: 2, 2: 4, 3: 8 };
const WIRE_NAMES = { 1: 'ci8', 2: 'ci16', 3: 'cf32' };

// How often to acknowledge frames. The daemon runs at most a quarter second
// ahead of the last ack before it starts dropping, so this must be well inside
// that -- but every ack is a packet, so not every frame either.
const ACK_EVERY_FRAMES = 8;

let socket = null;
let closing = false;
// The daemon re-sends its applied configuration on `start` as well as on
// `configure`, so the same warning arrives more than once. Showing it twice
// reads as two separate faults.
const warned = new Set();

onmessage = (event) => {
  void run(event.data).catch((error) => fail(event.data, error));
};

function controlView(memory, pointer) {
  return new Int32Array(memory.buffer, pointer, CTRL_WORDS);
}

/// Read the command mailbox under the seqlock the block writes it with: read
/// the counter, read the slots, read the counter again, retry if it moved.
function readCommand(control) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const seq = Atomics.load(control, CTRL.CMD_SEQ);
    const command = {
      seq,
      freq:
        Atomics.load(control, CTRL.FREQ_HI) * 4294967296 +
        (Atomics.load(control, CTRL.FREQ_LO) >>> 0),
      offset:
        Atomics.load(control, CTRL.OFFSET_HI) * 4294967296 +
        (Atomics.load(control, CTRL.OFFSET_LO) >>> 0),
      gainTenths: Atomics.load(control, CTRL.GAIN_TENTHS),
      bandwidth: Atomics.load(control, CTRL.BANDWIDTH),
      flags: Atomics.load(control, CTRL.FLAGS),
      stages: [
        Atomics.load(control, CTRL.STAGE1),
        Atomics.load(control, CTRL.STAGE2),
        Atomics.load(control, CTRL.STAGE3),
      ],
    };
    if (Atomics.load(control, CTRL.CMD_SEQ) === seq) return command;
  }
  return null;
}

function commandChanged(command, applied) {
  if (!applied) return true;
  return (
    command.freq !== applied.freq ||
    command.offset !== applied.offset ||
    command.gainTenths !== applied.gainTenths ||
    command.bandwidth !== applied.bandwidth ||
    command.flags !== applied.flags ||
    command.stages.some((value, index) => value !== applied.stages[index])
  );
}

/// Only the fields that actually changed, so a slider nudge does not re-send
/// the whole configuration and make the daemon re-plan its rates.
function configureFrom(command, applied, gainElements) {
  const message = { op: 'configure' };
  // Positional stages resolved to the radio's own names. A slot beyond what
  // this radio has is dropped rather than sent: the daemon would only warn
  // about an element that does not exist, once per configure, forever.
  const stages = {};
  let anyStage = false;
  (command.stages || []).forEach((value, index) => {
    if (value === STAGE_UNSET) return;
    const name = (gainElements || [])[index];
    if (!name) return;
    if (applied && applied.stages && applied.stages[index] === value) return;
    stages[name] = value / 10;
    anyStage = true;
  });
  if (anyStage) message.gains = stages;
  if (!applied || command.freq !== applied.freq) message.freq = command.freq;
  if (!applied || command.offset !== applied.offset) message.offset = command.offset;
  if (!applied || command.gainTenths !== applied.gainTenths) {
    message.gain = command.gainTenths / 10;
  }
  if (!applied || command.bandwidth !== applied.bandwidth) {
    if (command.bandwidth > 0) message.bandwidth = command.bandwidth;
  }
  if (!applied || command.flags !== applied.flags) {
    message.agc = (command.flags & FLAG_AGC) !== 0;
  }
  return message;
}

async function run(data) {
  const {
    server,
    device,
    memory,
    controlPointer,
    sampleRate,
    decim,
    wire,
  } = data;

  const control = controlView(memory, controlPointer);

  socket = new WebSocket(server, ['grwire.v1']);
  socket.binaryType = 'arraybuffer';

  let applied = null;
  // What the radio calls its gain stages, in its own order. The block addresses
  // them by position, so this is the only place the names exist.
  let gainElements = [];
  let framesSinceAck = 0;
  let lastSeq = 0;
  let started = false;

  const send = (message) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  await new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    // A failed WebSocket gives script no reason, by design -- the browser will
    // not say whether it was DNS, a refused connection or an untrusted
    // certificate. Naming the likely causes is the most this layer can do; the
    // editor probes before the run for exactly that reason.
    socket.onerror = () =>
      reject(
        new Error(
          `could not reach the GRWire daemon at ${redact(server)} -- check that it is ` +
            `running, that the URL and token are right, and (for wss://) that this ` +
            `browser has accepted its certificate`
        )
      );
  });

  socket.onerror = null;
  socket.onclose = (event) => {
    if (closing) return;
    fail(data, new Error(
      event.reason
        ? `the GRWire daemon closed the connection: ${event.reason}`
        : `the GRWire daemon closed the connection (code ${event.code})`
    ));
  };

  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      onControl(JSON.parse(event.data));
      return;
    }
    onFrame(new Uint8Array(event.data));
  };

  function onControl(message) {
    switch (message.ev) {
      case 'hello':
        postMessage({ type: 'hello', host: message.host, version: message.version });
        send({ op: 'open', device, direction: 'rx', channel: 0 });
        break;

      case 'opened': {
        gainElements = (message.info && message.info.gain_elements) || [];
        const initial = readCommand(control);
        const request = {
          op: 'configure',
          rate: sampleRate,
          format: WIRE_NAMES[wire] || 'ci8',
        };
        // Absent, not zero: the daemon plans the decimation only when the
        // client does not pin one, and a pinned 1 means "do not decimate".
        if (decim > 0) request.decim = decim;
        if (initial) Object.assign(request, configureFrom(initial, null, gainElements));
        applied = initial;
        if (initial) Atomics.store(control, CTRL.CMD_ACK, initial.seq);
        send(request);
        break;
      }

      case 'config':
        // The daemon's out_rate is authoritative: it snaps the request to what
        // the radio can do, and the block reports this to the console.
        Atomics.store(control, CTRL.ACTUAL_RATE, Math.round(message.applied.out_rate));
        for (const warning of message.applied.warnings || []) {
          if (warned.has(warning)) continue;
          warned.add(warning);
          postMessage({ type: 'warning', text: warning });
        }
        if (!started) {
          started = true;
          Atomics.store(control, CTRL.STATE, RUNNING);
          Atomics.notify(control, CTRL.WRITE_POS);
          postMessage({
            type: 'running',
            actualRate: message.applied.out_rate,
            hwRate: message.applied.hw_rate,
            decim: message.applied.decim,
          });
          send({ op: 'start' });
        }
        break;

      case 'stats':
        // Mirror the daemon's own accounting into the control block so the
        // flowgraph can say which layer lost samples, not merely that some went
        // missing.
        Atomics.store(control, CTRL.NET_DROP, message.net_drops | 0);
        Atomics.store(control, CTRL.CLIENT_DROP, message.client_drops | 0);
        postMessage({ type: 'stats', stats: message });
        break;

      case 'error':
        fail(data, new Error(`${message.code}: ${message.message}`));
        break;

      default:
        break;
    }
  }

  function onFrame(bytes) {
    if (cancelled(control)) {
      finish(data, 'cancelled');
      return;
    }

    if (bytes.byteLength < HEADER_BYTES) return;
    const header = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
    if (header.getUint32(0, true) !== MAGIC) {
      fail(data, new Error('the daemon sent a frame that is not grwire.v1'));
      return;
    }

    const format = header.getUint8(5);
    const flags = header.getUint16(6, true);
    const count = header.getUint32(12, true);
    lastSeq = Number(header.getBigUint64(16, true));

    const stride = WIRE_BYTES[format];
    if (!stride) {
      fail(data, new Error(`the daemon sent an unknown sample format (${format})`));
      return;
    }
    if (flags & FLAG_DISCONTINUITY) {
      postMessage({ type: 'discontinuity', seq: lastSeq });
    }

    deliver(data, control, bytes.subarray(HEADER_BYTES), count, stride);

    framesSinceAck += 1;
    if (framesSinceAck >= ACK_EVERY_FRAMES) {
      framesSinceAck = 0;
      send({ op: 'flow', ack_seq: lastSeq, ring_used: ringUsed(control, data.capacitySamples) });
    }

    // Commands are checked here rather than on a timer: this is the only place
    // that runs regularly, and a retune between frames is soon enough.
    const command = readCommand(control);
    if (command && commandChanged(command, applied)) {
      send(configureFrom(command, applied, gainElements));
      applied = command;
      Atomics.store(control, CTRL.CMD_ACK, command.seq);
    }
  }
}

function ringUsed(control, capacity) {
  const read = Atomics.load(control, CTRL.READ_POS);
  const write = Atomics.load(control, CTRL.WRITE_POS);
  const used = write >= read ? write - read : capacity - (read - write);
  return capacity ? used / capacity : 0;
}

function cancelled(control) {
  return Atomics.load(control, CTRL.STATE) === CANCELLED;
}

/// Copy one frame's payload into the ring, or drop it.
///
/// Every view is re-derived here rather than cached: ALLOW_MEMORY_GROWTH can
/// leave a stale view unable to address memory allocated after the growth, and
/// the failure is a silent out-of-range write rather than a crash.
function deliver(data, control, payload, count, stride) {
  const { memory, ringPointer, capacitySamples } = data;

  const readPosition = Atomics.load(control, CTRL.READ_POS);
  const writePosition = Atomics.load(control, CTRL.WRITE_POS);
  const used =
    writePosition >= readPosition
      ? writePosition - readPosition
      : capacitySamples - (readPosition - writePosition);
  // One slot reserved so a full ring is distinguishable from an empty one.
  const free = capacitySamples - used - 1;

  if (free < count) {
    // A network source cannot be told to wait any more than a dongle can. Drop,
    // count, and let the flowgraph report it.
    const overruns = Atomics.add(control, CTRL.OVERRUNS, 1) + 1;
    Atomics.add(control, CTRL.LOST_SAMPLES, count);
    if (overruns === 1 || overruns % 64 === 0) {
      postMessage({ type: 'overrun', overruns });
    }
    return;
  }

  const ring = new Uint8Array(memory.buffer, ringPointer, capacitySamples * stride);
  const beforeWrap = Math.min(count, capacitySamples - writePosition);
  ring.set(payload.subarray(0, beforeWrap * stride), writePosition * stride);
  if (beforeWrap < count) {
    ring.set(payload.subarray(beforeWrap * stride, count * stride), 0);
  }

  Atomics.store(control, CTRL.WRITE_POS, (writePosition + count) % capacitySamples);
  // This is the whole handoff: the same address the block's work() is blocked
  // on with emscripten_futex_wait.
  Atomics.notify(control, CTRL.WRITE_POS);
}

/// Never let a token reach the console pane, which users paste into bug reports.
function redact(url) {
  return String(url).replace(/token=[^&]*/, 'token=***');
}

function finish(data, reason) {
  closing = true;
  const control = controlView(data.memory, data.controlPointer);
  Atomics.store(control, CTRL.STATE, CANCELLED);
  Atomics.notify(control, CTRL.WRITE_POS);
  if (socket) socket.close();
  postMessage({ type: reason });
  close();
}

function fail(data, error) {
  closing = true;
  try {
    const control = controlView(data.memory, data.controlPointer);
    const text = new TextEncoder().encode(redact(error && error.message ? error.message : String(error)));
    const limit = Math.min(text.length, data.errorCapacity - 1);
    new Uint8Array(data.memory.buffer, data.errorPointer, data.errorCapacity).set(
      text.subarray(0, limit)
    );
    Atomics.store(control, CTRL.ERROR_LENGTH, limit);
    Atomics.store(control, CTRL.STATE, ERROR);
    Atomics.notify(control, CTRL.WRITE_POS);
  } catch (nested) {
    console.error('GRWire worker could not report an error:', nested);
  }
  if (socket) {
    try {
      socket.close();
    } catch (nested) {
      /* already gone */
    }
  }
  postMessage({ type: 'error', message: redact(String((error && error.message) || error)) });
  close();
}
