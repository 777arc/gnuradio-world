// Bounded producer for BrowserFileSource. One instance of this worker owns one
// local File or remote URL and writes complete GNU Radio items into a
// single-producer/single-consumer ring in shared WASM memory.
const READ_POS = 0;
const WRITE_POS = 1;
const STATE = 2;
const ERROR_LENGTH = 3;

const INITIAL = 0;
const RUNNING = 1;
const EOF_REACHED = 2;
const ERROR = 3;
const CANCELLED = 4;

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_RETRIES = 3;

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
  Atomics.notify(control, WRITE_POS);
  postMessage({ type: 'error', message });
  close();
}

async function readLocal(source, start, end) {
  return await source.file.slice(start, end).arrayBuffer();
}

async function readHttp(source, start, end) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; ++attempt) {
    try {
      const response = await fetch(source.url, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        cache: 'no-store',
      });
      if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(
          `server did not honor byte range ${start}-${end - 1} (HTTP ${response.status})`);
      }
      const contentRange = response.headers.get('Content-Range') || '';
      const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
      if (!match || Number(match[1]) !== start || Number(match[2]) !== end - 1) {
        await response.body?.cancel();
        throw new Error(`invalid Content-Range "${contentRange}"`);
      }
      const data = await response.arrayBuffer();
      if (data.byteLength !== end - start)
        throw new Error(`short range response (${data.byteLength} of ${end - start} bytes)`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < MAX_RETRIES) await sleep(100 * (1 << attempt));
    }
  }
  throw lastError;
}

onmessage = event => {
  void run(event.data).catch(error => {
    const data = event.data;
    fail(data.memory, data.controlPointer, data.errorPointer, data.errorCapacity, error);
  });
};

async function run(data) {
  const {
    source, memory, ringPointer, capacityItems, itemSize,
    controlPointer, errorPointer, errorCapacity,
    offsetItems, lengthItems, repeat,
  } = data;
  if (!source || !Number.isSafeInteger(source.size))
    throw new Error('invalid browser input descriptor');
  if (!Number.isSafeInteger(offsetItems) || !Number.isSafeInteger(lengthItems) ||
      offsetItems < 0 || lengthItems <= 0)
    throw new Error('invalid File Source range');

  let positionItems = offsetItems;
  let remainingItems = lengthItems;
  let bytesRead = 0;
  let maxChunkBytes = 0;
  const maxChunkItems = Math.max(1, Math.floor(MAX_CHUNK_BYTES / itemSize));
  Atomics.store(controlView(memory, controlPointer), STATE, RUNNING);
  Atomics.notify(controlView(memory, controlPointer), WRITE_POS);

  while (true) {
    const control = controlView(memory, controlPointer);
    if (Atomics.load(control, STATE) === CANCELLED) {
      postMessage({ type: 'cancelled', bytesRead, maxChunkBytes });
      close();
      return;
    }

    const readPosition = Atomics.load(control, READ_POS);
    const writePosition = Atomics.load(control, WRITE_POS);
    const used = writePosition >= readPosition
      ? writePosition - readPosition
      : capacityItems - (readPosition - writePosition);
    const free = capacityItems - used - 1;
    if (free === 0) {
      Atomics.wait(control, READ_POS, readPosition, 1000);
      continue;
    }

    const requestItems = Math.min(free, maxChunkItems, remainingItems);
    const byteStart = positionItems * itemSize;
    const byteEnd = byteStart + requestItems * itemSize;
    const chunk = source.kind === 'local'
      ? await readLocal(source, byteStart, byteEnd)
      : await readHttp(source, byteStart, byteEnd);
    const input = new Uint8Array(chunk);
    maxChunkBytes = Math.max(maxChunkBytes, input.byteLength);
    bytesRead += input.byteLength;

    // Recreate views after every await: ALLOW_MEMORY_GROWTH may have changed
    // WebAssembly.Memory.buffer while the file/range request was in flight.
    const ring = new Uint8Array(memory.buffer, ringPointer, capacityItems * itemSize);
    const itemsBeforeWrap = Math.min(requestItems, capacityItems - writePosition);
    const bytesBeforeWrap = itemsBeforeWrap * itemSize;
    ring.set(input.subarray(0, bytesBeforeWrap), writePosition * itemSize);
    if (itemsBeforeWrap < requestItems)
      ring.set(input.subarray(bytesBeforeWrap), 0);

    const nextWrite = (writePosition + requestItems) % capacityItems;
    const currentControl = controlView(memory, controlPointer);
    if (Atomics.load(currentControl, STATE) === CANCELLED) {
      postMessage({ type: 'cancelled', bytesRead, maxChunkBytes });
      close();
      return;
    }
    Atomics.store(currentControl, WRITE_POS, nextWrite);
    Atomics.notify(currentControl, WRITE_POS);

    positionItems += requestItems;
    remainingItems -= requestItems;
    if (remainingItems === 0) {
      if (repeat) {
        positionItems = offsetItems;
        remainingItems = lengthItems;
      } else {
        Atomics.store(currentControl, STATE, EOF_REACHED);
        Atomics.notify(currentControl, WRITE_POS);
        postMessage({ type: 'eof', bytesRead, maxChunkBytes });
        close();
        return;
      }
    }

    if ((bytesRead & ((16 * 1024 * 1024) - 1)) < input.byteLength)
      postMessage({ type: 'progress', bytesRead, maxChunkBytes });
  }
}
