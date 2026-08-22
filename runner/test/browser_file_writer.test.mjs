// SigMF Sink's writer worker, on plain Node in a second.
//
// runner/src/browser_file_writer.js drains the ring BrowserFileSink fills and
// puts the bytes somewhere the reader can keep them. Neither of its two paths is
// reachable from a browser test here: streaming needs showDirectoryPicker(),
// which wants a user gesture headless Chromium will not supply, and the buffered
// path ends in a browser download the harness cannot observe. So the worker is
// driven directly, against a plain ArrayBuffer standing in for the shared WASM
// heap and the same control-block layout blocks/src/browser_file_sink.hpp
// declares. See docs/recording-viewer.md.
//
//   node runner/test/browser_file_writer.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const READ_POS = 0, WRITE_POS = 1, STATE = 2, ERROR_LENGTH = 3;
const RUNNING = 1, FINISHING = 2, ERROR = 3, CANCELLED = 4, CLOSED = 5;

const source = await readFile(new URL('../src/browser_file_writer.js', import.meta.url), 'utf8');

// The worker global scope, as much of it as the module touches. Each harness gets
// its own module instance, because the worker keeps its finish state in module
// scope -- which is correct there (one worker owns one file) and would otherwise
// leak between cases here.
async function startWorker({ maxDownloadBytes } = {}) {
  const posted = [];
  let closed = false;
  const scope = {
    onmessage: null,
    postMessage: message => posted.push(message),
    close: () => { closed = true; },
    // The worker recreates its views through `memory.buffer` every time, so a
    // plain object with a buffer is all it needs.
    TextEncoder, Blob, setTimeout, Promise, Atomics, Uint8Array, Int32Array,
    Math, Number, String, Error, JSON, console,
  };
  let code = source.replace(/^onmessage =/m, 'self.onmessage =');
  if (maxDownloadBytes !== undefined)
    code = code.replace(/^const MAX_DOWNLOAD_BYTES = .*$/m,
                        `const MAX_DOWNLOAD_BYTES = ${maxDownloadBytes};`);
  const factory = new Function('self', 'globalThis', `
    with (self) {
      ${code}
    }
  `);
  factory(scope, scope);
  return {
    post: data => scope.onmessage({ data }),
    posted,
    isClosed: () => closed,
  };
}

// A ring and control block laid out exactly as browser_file_sink.cpp lays them
// out in the WASM heap, plus the producer half of its protocol.
function build({ capacityItems = 8, itemSize = 4 } = {}) {
  const controlPointer = 0;
  const errorPointer = 32;
  const ringPointer = 1024;
  const memory = { buffer: new ArrayBuffer(ringPointer + capacityItems * itemSize) };
  const control = new Int32Array(memory.buffer, controlPointer, 4);
  const ring = new Uint8Array(memory.buffer, ringPointer, capacityItems * itemSize);
  return {
    memory, control, ring, controlPointer, errorPointer, ringPointer,
    capacityItems, itemSize, errorCapacity: 512,
    // BrowserFileSink::work(), in miniature: one slot is always left empty, so
    // write_pos == read_pos is unambiguously "empty".
    write(bytes) {
      let written = 0;
      while (written < bytes.length / itemSize) {
        const read = Atomics.load(control, READ_POS);
        const write = Atomics.load(control, WRITE_POS);
        const used = write >= read ? write - read : capacityItems - (read - write);
        const free = capacityItems - used - 1;
        if (!free) return written;   // the caller pumps the worker and retries
        const take = Math.min(free, bytes.length / itemSize - written, capacityItems - write);
        ring.set(bytes.subarray(written * itemSize, (written + take) * itemSize),
                 write * itemSize);
        Atomics.store(control, WRITE_POS, (write + take) % capacityItems);
        written += take;
      }
      return written;
    },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

// --- the buffered path: no File System Access API ---------------------------
// More bytes than the ring holds, so the drain has to wrap and the producer has
// to block -- which is exactly the case a ring smaller than the recording is for.
{
  const harness = build({ capacityItems: 8, itemSize: 4 });
  const worker = await startWorker();
  const payload = Uint8Array.from({ length: 100 }, (_, i) => i & 0xff);

  worker.post({
    sink: { kind: 'download', base: 'take', dir: null },
    memory: harness.memory,
    ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems,
    itemSize: harness.itemSize,
    controlPointer: harness.controlPointer,
    errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
  });
  await settle();
  assert.equal(Atomics.load(harness.control, STATE), RUNNING,
    'the worker announces itself before the first sample');

  let offset = 0;
  while (offset < payload.length / harness.itemSize) {
    offset += harness.write(payload.subarray(offset * harness.itemSize));
    await settle();
  }

  worker.post({ type: 'finish', payload: '{"global":{}}' });
  Atomics.store(harness.control, STATE, FINISHING);
  await settle();

  assert.equal(Atomics.load(harness.control, STATE), CLOSED,
    'the file is closed only once the ring is drained *and* the metadata has arrived');
  const done = worker.posted.find(message => message.type === 'done');
  assert.ok(done, 'the buffered recording comes back to the frame that started it');
  assert.equal(done.mode, 'download');
  assert.equal(done.base, 'take');
  assert.equal(done.meta, '{"global":{}}');
  assert.equal(done.bytesWritten, payload.length);
  assert.deepEqual(new Uint8Array(await done.data.arrayBuffer()), payload,
    'every byte survives the wrap, in order');
  assert.ok(worker.isClosed(), 'the worker shuts itself down when the file is written');
}

// The finish message and the FINISHING state are posted separately and either
// can land first, so the worker must wait for both.
{
  const harness = build();
  const worker = await startWorker();
  worker.post({
    sink: { kind: 'download', base: 'take', dir: null },
    memory: harness.memory, ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems, itemSize: harness.itemSize,
    controlPointer: harness.controlPointer, errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
  });
  await settle();

  Atomics.store(harness.control, STATE, FINISHING);
  await settle();
  assert.notEqual(Atomics.load(harness.control, STATE), CLOSED,
    'FINISHING alone is not enough: the .sigmf-meta has not arrived yet');

  worker.post({ type: 'finish', payload: '{}' });
  await settle();
  assert.equal(Atomics.load(harness.control, STATE), CLOSED,
    'the metadata arriving second still closes the file');
}

// --- the streaming path: a folder handle ------------------------------------
{
  const written = new Map();
  const fakeHandle = name => ({
    createWritable: async () => {
      const chunks = [];
      return {
        // FileSystemWritableFileStream.write() takes a string as well as a
        // buffer, and encodes it as UTF-8; the .sigmf-meta arrives as one.
        write: async chunk => chunks.push(typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : Uint8Array.from(chunk)),
        close: async () => {
          written.set(name, Buffer.concat(chunks.map(Buffer.from)));
        },
      };
    },
  });
  const dir = {
    name: 'captures',
    getFileHandle: async (name, options) => {
      assert.deepEqual(options, { create: true }, 'both files are created if absent');
      return fakeHandle(name);
    },
  };

  const harness = build({ capacityItems: 8, itemSize: 4 });
  const worker = await startWorker();
  const payload = Uint8Array.from({ length: 40 }, (_, i) => 255 - i);
  worker.post({
    sink: { kind: 'fsaccess', base: 'capture', dir },
    memory: harness.memory, ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems, itemSize: harness.itemSize,
    controlPointer: harness.controlPointer, errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
  });
  await settle();

  let offset = 0;
  while (offset < payload.length / harness.itemSize) {
    offset += harness.write(payload.subarray(offset * harness.itemSize));
    await settle();
  }
  worker.post({ type: 'finish', payload: '{"global":{"core:datatype":"cf32_le"}}' });
  Atomics.store(harness.control, STATE, FINISHING);
  await settle();

  assert.equal(Atomics.load(harness.control, STATE), CLOSED);
  assert.deepEqual(new Uint8Array(written.get('capture.sigmf-data')), payload,
    'the samples stream straight through to the .sigmf-data');
  assert.equal(String(written.get('capture.sigmf-meta')),
    '{"global":{"core:datatype":"cf32_le"}}',
    'the .sigmf-meta is written after the samples, from the finish payload');
  const done = worker.posted.find(message => message.type === 'done');
  assert.equal(done.mode, 'fsaccess');
  assert.equal(done.bytesWritten, payload.length);
  assert.ok(!done.data, 'a streamed recording is never carried back through memory');
}

// --- failures reach the producer through the ring's error channel -----------
// A worker that cannot open its destination has to say so where work() will see
// it, not only in the console: BrowserFileSink::work() throws on ERROR, which is
// what turns a failed write into a failed run rather than a silent one.
{
  const harness = build();
  const worker = await startWorker();
  worker.post({
    sink: { kind: 'fsaccess', base: 'capture', dir: null },
    memory: harness.memory, ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems, itemSize: harness.itemSize,
    controlPointer: harness.controlPointer, errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
  });
  await settle();

  assert.equal(Atomics.load(harness.control, STATE), ERROR);
  const length = Atomics.load(harness.control, ERROR_LENGTH);
  assert.ok(length > 0, 'the message is left in shared memory for reader_error()');
  const message = new TextDecoder().decode(
    new Uint8Array(harness.memory.buffer, harness.errorPointer, length));
  assert.match(message, /no output folder is bound/);
  assert.match(worker.posted.find(m => m.type === 'error').message, /no output folder is bound/);
}

// A buffered recording that outgrows memory fails the run rather than truncating
// it. Silent truncation is the worst outcome available here: the file looks fine
// and is missing its end. (The streaming path has no such limit.)
{
  const harness = build({ capacityItems: 8, itemSize: 4 });
  const worker = await startWorker({ maxDownloadBytes: 16 });
  worker.post({
    sink: { kind: 'download', base: 'take', dir: null },
    memory: harness.memory, ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems, itemSize: harness.itemSize,
    controlPointer: harness.controlPointer, errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
  });
  await settle();

  for (let i = 0; i < 4; ++i) {
    harness.write(Uint8Array.from({ length: 16 }, () => i));
    await settle();
    if (Atomics.load(harness.control, STATE) === ERROR) break;
  }
  assert.equal(Atomics.load(harness.control, STATE), ERROR,
    'work() throws on ERROR, so an over-long buffered recording fails the run');
  const length = Atomics.load(harness.control, ERROR_LENGTH);
  const message = new TextDecoder().decode(
    new Uint8Array(harness.memory.buffer, harness.errorPointer, length));
  assert.match(message, /File System Access API/,
    'and the message says which browser would not have this limit');
  assert.ok(!worker.posted.some(m => m.type === 'done'),
    'a truncated recording is never handed back as though it were whole');
}

// A cancelled run abandons the file rather than finishing it: nothing asked for
// this recording to exist.
{
  const harness = build();
  const worker = await startWorker();
  worker.post({
    sink: { kind: 'download', base: 'take', dir: null },
    memory: harness.memory, ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems, itemSize: harness.itemSize,
    controlPointer: harness.controlPointer, errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
  });
  await settle();
  Atomics.store(harness.control, STATE, CANCELLED);
  await settle();
  assert.ok(worker.posted.some(message => message.type === 'cancelled'));
  assert.ok(!worker.posted.some(message => message.type === 'done'),
    'a cancelled recording is not handed back');
}

console.log('browser_file_writer: buffered and streamed paths, finish handshake, failures — OK');
