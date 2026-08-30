// Bounded consumer for BrowserFileSink, and the mirror image of
// browser_file_reader.js. One instance of this worker owns one output file and
// drains complete GNU Radio items out of a single-producer/single-consumer ring
// in shared WASM memory.
//
// Two modes, decided by what the browser can do:
//
//   fsaccess  a FileSystemDirectoryHandle the reader chose. Samples stream
//             straight to disk, so a recording is bounded only by the disk.
//   download  no File System Access API (Firefox, Safari). Samples accumulate
//             here and both files are handed back as blobs at the end, which
//             bounds a recording by memory -- hence MAX_DOWNLOAD_BYTES.
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

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
// What a buffered recording may reach before the run is failed. Chosen to be
// large enough to be useful and small enough to fail before the tab dies: an
// out-of-memory crash loses the recording *and* the flowgraph with no message.
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
// How long to idle between polls of an empty ring. The producer blocks on
// READ_POS when the ring is full and is woken from here, so this only bounds how
// quickly the tail of a run is noticed. Deliberately not Atomics.wait: that
// blocks the worker's event loop, and the finish message has to get through.
const IDLE_POLL_MS = 2;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function controlView(memory, pointer) {
  return new Int32Array(memory.buffer, pointer, 4);
}

function fail(memory, controlPointer, errorPointer, errorCapacity, error) {
  const control = controlView(memory, controlPointer);
  const message = String(error instanceof Error ? error.message : error);
  const encoded = new TextEncoder().encode(message);
  const length = Math.min(encoded.byteLength, errorCapacity - 1);
  new Uint8Array(memory.buffer, errorPointer, errorCapacity).fill(0);
  new Uint8Array(memory.buffer, errorPointer, length).set(encoded.subarray(0, length));
  Atomics.store(control, ERROR_LENGTH, length);
  Atomics.store(control, STATE, ERROR);
  // Both, because the producer may be parked on either: on READ_POS waiting for
  // ring space, or on STATE waiting for the close that will now never come.
  Atomics.notify(control, READ_POS);
  Atomics.notify(control, STATE);
  postMessage({ type: 'error', message });
  close();
}

// The destination, resolved once so the drain loop is the same in both modes.
async function openDestination(sink) {
  if (sink.kind === 'fsaccess') {
    if (!sink.dir || typeof sink.dir.getFileHandle !== 'function')
      throw new Error('no output folder is bound in this session');
    const handle = await sink.dir.getFileHandle(sink.base + '.sigmf-data', { create: true });
    const writable = await handle.createWritable();
    return {
      bytesWritten: 0,
      async write(chunk) {
        await writable.write(chunk);
        this.bytesWritten += chunk.byteLength;
      },
      async finish(payload) {
        await writable.close();
        const metaHandle =
          await sink.dir.getFileHandle(sink.base + '.sigmf-meta', { create: true });
        const metaWritable = await metaHandle.createWritable();
        await metaWritable.write(payload);
        await metaWritable.close();
        postMessage({
          type: 'done', mode: 'fsaccess',
          bytesWritten: this.bytesWritten, base: sink.base,
        });
      },
      async abort() { try { await writable.abort(); } catch { /* already gone */ } },
    };
  }

  if (sink.kind === 'download') {
    const chunks = [];
    return {
      bytesWritten: 0,
      async write(chunk) {
        if (this.bytesWritten + chunk.byteLength > MAX_DOWNLOAD_BYTES)
          throw new Error(
            `recording exceeded ${Math.round(MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB, ` +
            `the limit for a browser without the File System Access API. ` +
            `Use a Chromium browser to stream a longer recording to disk.`);
        // The ring is reused the moment READ_POS advances, so what is kept has
        // to be a copy rather than a view onto shared memory.
        chunks.push(chunk);
        this.bytesWritten += chunk.byteLength;
      },
      async finish(payload) {
        postMessage({
          type: 'done', mode: 'download', bytesWritten: this.bytesWritten,
          base: sink.base,
          data: new Blob(chunks, { type: 'application/octet-stream' }),
          meta: payload,
        });
      },
      async abort() { chunks.length = 0; },
    };
  }

  throw new Error(`unknown output kind: ${sink.kind}`);
}

let finishPayload = null;
let finishRequested = false;
let started = false;

onmessage = event => {
  const data = event.data || {};
  if (data.type === 'finish') {
    finishPayload = typeof data.payload === 'string' ? data.payload : '';
    finishRequested = true;
    return;
  }
  if (started) return;
  started = true;
  void run(data).catch(error => {
    fail(data.memory, data.controlPointer, data.errorPointer, data.errorCapacity, error);
  });
};

async function run(data) {
  const {
    sink, memory, ringPointer, capacityItems, itemSize,
    controlPointer, errorPointer, errorCapacity,
  } = data;
  if (!sink || typeof sink.base !== 'string' || !sink.base)
    throw new Error('invalid browser output descriptor');
  if (!Number.isSafeInteger(capacityItems) || capacityItems < 2 ||
      !Number.isSafeInteger(itemSize) || itemSize <= 0)
    throw new Error('invalid File Sink ring geometry');

  const destination = await openDestination(sink);
  const maxChunkItems = Math.max(1, Math.floor(MAX_CHUNK_BYTES / itemSize));
  Atomics.store(controlView(memory, controlPointer), STATE, RUNNING);

  while (true) {
    const control = controlView(memory, controlPointer);
    const state = Atomics.load(control, STATE);
    if (state === CANCELLED) {
      await destination.abort();
      postMessage({ type: 'cancelled', bytesWritten: destination.bytesWritten });
      close();
      return;
    }

    const readPosition = Atomics.load(control, READ_POS);
    const writePosition = Atomics.load(control, WRITE_POS);
    const used = writePosition >= readPosition
      ? writePosition - readPosition
      : capacityItems - (readPosition - writePosition);

    if (used === 0) {
      // Drained. Finish only once the producer has said it is done *and* the
      // trailing metadata has arrived; the two are posted separately and either
      // can land first.
      if (state === FINISHING && finishRequested) {
        await destination.finish(finishPayload || '');
        const done = controlView(memory, controlPointer);
        Atomics.store(done, STATE, CLOSED);
        Atomics.notify(done, STATE);
        close();
        return;
      }
      await sleep(IDLE_POLL_MS);
      continue;
    }

    const takeItems = Math.min(used, maxChunkItems, capacityItems - readPosition);
    // A fresh view every time: ALLOW_MEMORY_GROWTH may have replaced
    // WebAssembly.Memory.buffer while the previous write was in flight.
    const ring = new Uint8Array(memory.buffer, ringPointer, capacityItems * itemSize);
    const byteStart = readPosition * itemSize;
    const chunk = ring.slice(byteStart, byteStart + takeItems * itemSize);

    // Release the space before the write, not after: the producer is very likely
    // parked on READ_POS, and holding it for the duration of a disk write would
    // halve throughput for nothing. The bytes are already copied out.
    const nextRead = (readPosition + takeItems) % capacityItems;
    const currentControl = controlView(memory, controlPointer);
    Atomics.store(currentControl, READ_POS, nextRead);
    Atomics.notify(currentControl, READ_POS);

    await destination.write(chunk);

    if ((destination.bytesWritten & ((16 * 1024 * 1024) - 1)) < chunk.byteLength)
      postMessage({ type: 'progress', bytesWritten: destination.bytesWritten });
  }
}
