// Bounded consumer for WebSocketSink, and the mirror image of
// websocket_reader.js. One instance of this worker owns one WebSocket
// connection and drains complete GNU Radio items out of a
// single-producer/single-consumer ring in shared WASM memory, sending them on
// as binary messages.
//
// Deliberately NOT Atomics.wait, unlike the block's own C++ work(): this loop
// has to keep the worker's event loop free so the WebSocket's own open/error/
// close events -- delivered the same way postMessage is -- can actually run.
// Blocking here would mean the socket could never even finish connecting.
// (browser_file_writer.js avoids Atomics.wait for the analogous reason: a
// 'finish' postMessage has to get through. Same mechanism, different event.)
const READ_POS = 0;
const WRITE_POS = 1;
const STATE = 2;
const ERROR_LENGTH = 3;

const INITIAL = 0;
const RUNNING = 1;
const FINISHING = 2;
const ERROR = 3;
const CANCELLED = 4;
const CLOSED = 5;

// One WebSocket message per drain, capped here. Small enough that the far end
// sees samples promptly, large enough not to spend all our time in send().
const MAX_CHUNK_BYTES = 256 * 1024;
// Above this many bytes still queued in the browser's own send buffer, hold
// off handing it more: bufferedAmount is what makes the block's work() block
// on ring space instead of memory growing without bound. See websocket_sink.hpp.
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const IDLE_POLL_MS = 2;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function controlView(memory, pointer) {
  return new Int32Array(memory.buffer, pointer, 4);
}

let started = false;

onmessage = event => {
  if (started) return;   // this worker takes exactly one message, ever
  started = true;
  const data = event.data;
  void run(data).catch(error => {
    reportError(data.memory, data.controlPointer, data.errorPointer,
                data.errorCapacity, error);
  });
};

function reportError(memory, controlPointer, errorPointer, errorCapacity, error) {
  const control = controlView(memory, controlPointer);
  if (Atomics.load(control, STATE) === ERROR) return;   // already reported
  const message = String(error instanceof Error ? error.message : error);
  const encoded = new TextEncoder().encode(message);
  const length = Math.min(encoded.byteLength, errorCapacity - 1);
  new Uint8Array(memory.buffer, errorPointer, errorCapacity).fill(0);
  new Uint8Array(memory.buffer, errorPointer, length).set(encoded.subarray(0, length));
  Atomics.store(control, ERROR_LENGTH, length);
  Atomics.store(control, STATE, ERROR);
  // Both, because the producer (the block's work()) may be parked on READ_POS
  // waiting for ring space, and stop() may be parked on STATE waiting for CLOSED.
  Atomics.notify(control, READ_POS);
  Atomics.notify(control, STATE);
  postMessage({ type: 'error', message });
}

async function run(data) {
  const {
    url, protocol, memory, ringPointer, capacityItems, itemSize,
    controlPointer, errorPointer, errorCapacity,
  } = data;
  if (typeof url !== 'string' || !url)
    throw new Error('invalid WebSocket Sink URL');
  if (!Number.isSafeInteger(capacityItems) || capacityItems < 2 ||
      !Number.isSafeInteger(itemSize) || itemSize <= 0)
    throw new Error('invalid WebSocket Sink ring geometry');

  const maxChunkItems = Math.max(1, Math.floor(MAX_CHUNK_BYTES / itemSize));
  let bytesWritten = 0;
  let opened = false;
  let remoteClosed = false;
  let remoteCloseCode = 0;
  let done = false;

  // `protocol` requests a WebSocket subprotocol (e.g. Tezuka Sink asks for
  // "iio-tx" against iio_ws_proxy so it claims only the TX half of a
  // full-duplex server -- see websocket_reader.js's identical parameter, which
  // a Tezuka Source uses for the RX half of the same server). undefined
  // behaves exactly like the 1-arg form.
  const ws = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { opened = true; postMessage({ type: 'open', bytesWritten }); };
  ws.onerror = () => {
    if (done) return;
    reportError(memory, controlPointer, errorPointer, errorCapacity,
                opened ? 'WebSocket error' : `could not connect to ${url}`);
  };
  ws.onclose = event => {
    if (done) return;
    remoteClosed = true;
    remoteCloseCode = event.code;
  };

  while (true) {
    const control = controlView(memory, controlPointer);
    const state = Atomics.load(control, STATE);

    if (state === CANCELLED) {
      done = true;
      try { ws.close(); } catch { /* already gone */ }
      postMessage({ type: 'cancelled', bytesWritten });
      close();
      return;
    }
    if (state === ERROR) {
      done = true;
      close();
      return;
    }
    // The remote end went away before stop() asked to finish: surfaced as an
    // error, same as any other write failure, rather than a silently
    // truncated stream.
    if (remoteClosed) {
      reportError(memory, controlPointer, errorPointer, errorCapacity,
                  `WebSocket closed by the remote end (code ${remoteCloseCode})`);
      continue;
    }

    const readPosition = Atomics.load(control, READ_POS);
    const writePosition = Atomics.load(control, WRITE_POS);
    const used = writePosition >= readPosition
      ? writePosition - readPosition
      : capacityItems - (readPosition - writePosition);

    if (used === 0) {
      if (state === FINISHING) {
        done = true;
        try { ws.close(); } catch { /* already gone */ }
        const finalControl = controlView(memory, controlPointer);
        Atomics.store(finalControl, STATE, CLOSED);
        Atomics.notify(finalControl, STATE);
        postMessage({ type: 'done', bytesWritten });
        close();
        return;
      }
      await sleep(IDLE_POLL_MS);
      continue;
    }

    if (!opened || ws.bufferedAmount > HIGH_WATER_BYTES) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    const takeItems = Math.min(used, maxChunkItems, capacityItems - readPosition);
    // A fresh view every time: ALLOW_MEMORY_GROWTH may have replaced
    // WebAssembly.Memory.buffer since the previous send.
    const ring = new Uint8Array(memory.buffer, ringPointer, capacityItems * itemSize);
    const byteStart = readPosition * itemSize;
    const chunk = ring.slice(byteStart, byteStart + takeItems * itemSize);

    // Release the space before send(), not after: the producer is very likely
    // parked on READ_POS, and holding it for the duration of the send would
    // halve throughput for nothing. The bytes are already copied out.
    const nextRead = (readPosition + takeItems) % capacityItems;
    const currentControl = controlView(memory, controlPointer);
    Atomics.store(currentControl, READ_POS, nextRead);
    Atomics.notify(currentControl, READ_POS);

    try {
      ws.send(chunk);
    } catch (error) {
      reportError(memory, controlPointer, errorPointer, errorCapacity, error);
      continue;
    }
    bytesWritten += chunk.byteLength;

    if ((bytesWritten & ((16 * 1024 * 1024) - 1)) < chunk.byteLength)
      postMessage({ type: 'progress', bytesWritten });
  }
}
