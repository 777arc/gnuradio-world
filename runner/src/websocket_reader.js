// Live producer for WebSocketSource. One instance of this worker owns one
// WebSocket connection and writes complete GNU Radio items into a
// single-producer/single-consumer ring in shared WASM memory.
//
// Unlike browser_file_reader.js this worker is event-driven rather than a pull
// loop: a socket delivers whole messages through onmessage, not bytes on
// request, so there is no "ask for the next chunk" step. What is identical is
// everything about the ring itself -- see docs/rtlsdr.md for why the control
// block is a futex on shared memory rather than a condition variable.

// ---- Shared control block --------------------------------------------------
// Index order must match struct Control in blocks/src/websocket_source.hpp.
const READ_POS = 0;
const WRITE_POS = 1;
const STATE = 2;
const ERROR_LENGTH = 3;
const OVERRUNS = 4;
const DROPPED_ITEMS = 5;

const INITIAL = 0;
const RUNNING = 1;
const EOF_REACHED = 2;
const ERROR = 3;
const CANCELLED = 4;

function controlView(memory, pointer) {
  return new Int32Array(memory.buffer, pointer, 6);
}

let finished = false;

function reportError(memory, controlPointer, errorPointer, errorCapacity, message) {
  const control = controlView(memory, controlPointer);
  // A connection that never opened is more useful reported as an error than as
  // an empty stream: EOF implies a stream that ran and ended cleanly.
  if (Atomics.load(control, STATE) === ERROR) return;   // already reported
  const encoded = new TextEncoder().encode(String(message));
  const length = Math.min(encoded.byteLength, errorCapacity - 1);
  new Uint8Array(memory.buffer, errorPointer, errorCapacity).fill(0);
  new Uint8Array(memory.buffer, errorPointer, length).set(encoded.subarray(0, length));
  Atomics.store(control, ERROR_LENGTH, length);
  Atomics.store(control, STATE, ERROR);
  Atomics.notify(control, WRITE_POS);
  postMessage({ type: 'error', message: String(message) });
}

onmessage = event => {
  try {
    run(event.data);
  } catch (error) {
    reportError(event.data.memory, event.data.controlPointer,
                event.data.errorPointer, event.data.errorCapacity, error);
    close();
  }
};

function run(data) {
  const {
    url, protocol, memory, ringPointer, capacityItems, itemSize,
    controlPointer, errorPointer, errorCapacity,
  } = data;
  if (typeof url !== 'string' || !url)
    throw new Error('invalid WebSocket Source URL');
  if (!Number.isSafeInteger(capacityItems) || capacityItems < 2 ||
      !Number.isSafeInteger(itemSize) || itemSize <= 0)
    throw new Error('invalid WebSocket Source ring geometry');

  let opened = false;
  let overruns = 0;
  let droppedItems = 0;
  let bytesRead = 0;
  // Bytes carried over from one message to the next because they did not fill
  // a whole item. Reset (i.e. sync is lost) whenever a batch is dropped -- see
  // the drop branch of deliver() below.
  let pending = new Uint8Array(0);

  // `protocol` requests a WebSocket subprotocol (e.g. Tezuka Source asks for
  // "iio-rx" against iio_ws_proxy so it claims only the RX half of a
  // full-duplex server -- a bare connection falls back to that server's
  // default protocol, which can claim both halves and collide with a Sink
  // connecting separately). undefined behaves exactly like the 1-arg form.
  const ws = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  const finish = (type, extra) => {
    if (finished) return;
    finished = true;
    postMessage({ type, bytesRead, overruns, droppedItems, ...extra });
    close();
  };

  const deliver = bytes => {
    if (finished || !bytes.byteLength) return;
    bytesRead += bytes.byteLength;

    let merged = bytes;
    if (pending.byteLength) {
      merged = new Uint8Array(pending.byteLength + bytes.byteLength);
      merged.set(pending, 0);
      merged.set(bytes, pending.byteLength);
    }
    const wholeItems = Math.floor(merged.byteLength / itemSize);
    pending = merged.subarray(wholeItems * itemSize);
    if (!wholeItems) return;

    // A fresh view every message: ALLOW_MEMORY_GROWTH may have replaced
    // WebAssembly.Memory.buffer since the last one.
    const control = controlView(memory, controlPointer);
    const readPosition = Atomics.load(control, READ_POS);
    const writePosition = Atomics.load(control, WRITE_POS);
    const used = writePosition >= readPosition
      ? writePosition - readPosition
      : capacityItems - (readPosition - writePosition);
    const free = capacityItems - used - 1;

    // The remote end cannot be told to slow down. Dropping this whole batch and
    // counting it is the only honest option -- the same choice rtlsdr_reader.js
    // makes for a bulk transfer that would overrun the ring. Item alignment is
    // not preserved across a drop: pending is already the (correct) leftover
    // for the *next* message, and what would have gone to the ring is simply
    // discarded rather than partially written.
    if (free < wholeItems) {
      ++overruns;
      droppedItems += wholeItems;
      Atomics.store(control, OVERRUNS, overruns);
      Atomics.store(control, DROPPED_ITEMS, droppedItems);
      if (overruns === 1 || overruns % 64 === 0)
        postMessage({ type: 'overrun', bytesRead, overruns, droppedItems });
      return;
    }

    const ring = new Uint8Array(memory.buffer, ringPointer, capacityItems * itemSize);
    const itemsBeforeWrap = Math.min(wholeItems, capacityItems - writePosition);
    const bytesBeforeWrap = itemsBeforeWrap * itemSize;
    ring.set(merged.subarray(0, bytesBeforeWrap), writePosition * itemSize);
    if (itemsBeforeWrap < wholeItems)
      ring.set(merged.subarray(bytesBeforeWrap, wholeItems * itemSize), 0);

    Atomics.store(control, WRITE_POS, (writePosition + wholeItems) % capacityItems);
    Atomics.notify(control, WRITE_POS);

    if ((bytesRead & ((16 * 1024 * 1024) - 1)) < bytes.byteLength)
      postMessage({ type: 'progress', bytesRead, overruns, droppedItems });
  };

  ws.onopen = () => {
    opened = true;
    Atomics.store(controlView(memory, controlPointer), STATE, RUNNING);
    Atomics.notify(controlView(memory, controlPointer), WRITE_POS);
    postMessage({ type: 'open', bytesRead, overruns, droppedItems });
  };

  ws.onmessage = event => {
    if (typeof event.data === 'string') {
      deliver(new TextEncoder().encode(event.data));
    } else {
      deliver(new Uint8Array(event.data));
    }
  };

  ws.onerror = () => {
    reportError(memory, controlPointer, errorPointer, errorCapacity,
                opened ? 'WebSocket error' : `could not connect to ${url}`);
  };

  ws.onclose = event => {
    const control = controlView(memory, controlPointer);
    if (Atomics.load(control, STATE) === ERROR) {
      // onerror already reported this; onclose just follows it. Nothing more
      // to publish, but still tell the launcher this worker is done.
      finish('error', { bytesRead, overruns, droppedItems });
      return;
    }
    if (opened) {
      Atomics.store(control, STATE, EOF_REACHED);
      Atomics.notify(control, WRITE_POS);
      finish('eof', { code: event.code });
    } else {
      reportError(memory, controlPointer, errorPointer, errorCapacity,
                  `connection closed before it opened (code ${event.code})`);
      finish('error', { code: event.code });
    }
  };
}
