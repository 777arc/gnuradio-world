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
// A remote read that makes no progress for this long is abandoned and resumed
// from the last byte that did arrive. A stalled TCP connection on a bad wifi
// link otherwise leaves fetch() pending forever, and with it the source: the
// flowgraph then never gets its first sample and every plot stays blank.
const STALL_TIMEOUT_MS = 20 * 1000;
// Consecutive attempts without a single byte before the source gives up. Every
// resume is exact (a Range from the last byte received), so a retry costs
// nothing but the wait, and the backoff below caps at MAX_BACKOFF_MS.
const MAX_RETRIES = 8;
const MAX_BACKOFF_MS = 5 * 1000;

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

// Only a status the server may answer differently next time is worth another
// attempt; a 404 or 403 is the same tomorrow, and a 416 says the range itself
// was wrong.
function shouldRetryHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function protocolError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

function shouldRetryError(error) {
  return !(error && error.retryable === false);
}

// Stream one byte range into the ring as it arrives. The alternative -- waiting
// for the whole response with arrayBuffer() -- meant the flowgraph saw nothing
// until the entire request had landed, so on a link slower than the recording's
// own rate (a 2 MS/s complex-short recording needs 8 MB/s) it ran in bursts:
// a quarter second of signal, then ten seconds of frozen plots, and on the
// first request nothing at all until the plots were given up on as broken.
// Delivering every piece the moment it lands lets a slow link degrade into a
// slow flowgraph instead. `deliver` is handed whole bytes in order and must
// publish them before it returns; a request that dies part-way resumes from
// the byte after the last one delivered, so nothing is ever delivered twice.
async function streamHttp(source, start, end, deliver, isCancelled) {
  let position = start;
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; ++attempt) {
    if (isCancelled()) return;
    const controller = new AbortController();
    let stallTimer = 0;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => controller.abort(new Error(`no data for ${STALL_TIMEOUT_MS / 1000} s`)),
        STALL_TIMEOUT_MS);
    };
    let progressed = false;
    try {
      armStall();
      const response = await fetch(source.url, {
        headers: { Range: `bytes=${position}-${end - 1}` },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status !== 206) {
        await response.body?.cancel();
        const message =
          `server did not honor byte range ${position}-${end - 1} (HTTP ${response.status})`;
        throw shouldRetryHttpStatus(response.status) ? new Error(message) : protocolError(message);
      }
      const contentRange = response.headers.get('Content-Range') || '';
      const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
      // Content-Range is not CORS-safelisted. Some otherwise valid public
      // range servers (notably raw.githubusercontent.com) return it on the
      // wire without exposing it to browser JavaScript. Validate it whenever
      // it is visible; HTTP 206 plus the exact byte count below still guards
      // the request when CORS hides it.
      if (contentRange &&
          (!match || Number(match[1]) !== position || Number(match[2]) !== end - 1)) {
        await response.body?.cancel();
        throw protocolError(`invalid Content-Range "${contentRange}"`);
      }
      const reader = response.body.getReader();
      while (position < end) {
        armStall();
        const { value, done } = await reader.read();
        if (done) break;
        if (!value.byteLength) continue;
        if (position + value.byteLength > end) {
          await reader.cancel();
          throw protocolError(
            `long range response (more than ${end - position} bytes left of ${end - start})`);
        }
        if (isCancelled()) { await reader.cancel(); return; }
        await deliver(value);
        position += value.byteLength;
        progressed = true;
      }
      if (position !== end)
        throw new Error(`short range response (${position - start} of ${end - start} bytes)`);
      return;
    } catch (error) {
      lastError = error;
      if (isCancelled()) return;
      if (!shouldRetryError(error)) break;
      // Bytes that arrived reset the count: a link that keeps delivering, however
      // haltingly, is one to keep reading, and only a dead one is given up on. A
      // short body is in that class too -- the server or the link closed early,
      // and the Range picks up exactly where it stopped.
      if (progressed) attempt = -1;
      if (attempt + 1 < MAX_RETRIES)
        await sleep(Math.min(MAX_BACKOFF_MS, 100 * (1 << Math.max(0, attempt))));
    } finally {
      clearTimeout(stallTimer);
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
    maxChunkBytes = Math.max(maxChunkBytes, byteEnd - byteStart);

    // The ring range [writePosition, writePosition + requestItems) is ours: only
    // the consumer moves READ_POS, so the space counted free above only grows
    // while the request is in flight. Whole items are published as they land,
    // with the tail of a piece that ends mid-item held back for the next one.
    let ringWrite = writePosition;
    let carry = new Uint8Array(0);
    const publish = bytes => {
      // Recreate views after every await: ALLOW_MEMORY_GROWTH may have changed
      // WebAssembly.Memory.buffer while the file/range request was in flight.
      let input = bytes;
      if (carry.byteLength) {
        input = new Uint8Array(carry.byteLength + bytes.byteLength);
        input.set(carry, 0);
        input.set(bytes, carry.byteLength);
      }
      const items = Math.floor(input.byteLength / itemSize);
      carry = input.slice(items * itemSize);
      if (!items) return;
      const whole = input.subarray(0, items * itemSize);
      const ring = new Uint8Array(memory.buffer, ringPointer, capacityItems * itemSize);
      const itemsBeforeWrap = Math.min(items, capacityItems - ringWrite);
      const bytesBeforeWrap = itemsBeforeWrap * itemSize;
      ring.set(whole.subarray(0, bytesBeforeWrap), ringWrite * itemSize);
      if (itemsBeforeWrap < items)
        ring.set(whole.subarray(bytesBeforeWrap), 0);
      ringWrite = (ringWrite + items) % capacityItems;
      bytesRead += whole.byteLength;
      const currentControl = controlView(memory, controlPointer);
      Atomics.store(currentControl, WRITE_POS, ringWrite);
      Atomics.notify(currentControl, WRITE_POS);
    };
    const cancelled = () => Atomics.load(controlView(memory, controlPointer), STATE) === CANCELLED;

    if (source.kind === 'local') {
      publish(new Uint8Array(await readLocal(source, byteStart, byteEnd)));
    } else {
      await streamHttp(source, byteStart, byteEnd, publish, cancelled);
    }
    if (cancelled()) {
      postMessage({ type: 'cancelled', bytesRead, maxChunkBytes });
      close();
      return;
    }
    if (carry.byteLength || ringWrite !== (writePosition + requestItems) % capacityItems)
      throw new Error(`browser input delivered ${bytesRead} bytes, not a whole number of items`);

    positionItems += requestItems;
    remainingItems -= requestItems;
    if (remainingItems === 0) {
      if (repeat) {
        positionItems = offsetItems;
        remainingItems = lengthItems;
      } else {
        const currentControl = controlView(memory, controlPointer);
        Atomics.store(currentControl, STATE, EOF_REACHED);
        Atomics.notify(currentControl, WRITE_POS);
        postMessage({ type: 'eof', bytesRead, maxChunkBytes });
        close();
        return;
      }
    }

    if ((bytesRead & ((16 * 1024 * 1024) - 1)) < requestItems * itemSize)
      postMessage({ type: 'progress', bytesRead, maxChunkBytes });
  }
}
