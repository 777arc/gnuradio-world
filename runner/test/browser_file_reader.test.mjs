// The recording reader worker, on plain Node in a second.
//
// runner/src/browser_file_reader.js fills the ring BrowserFileSource drains,
// from a local File or a remote URL in HTTP Range requests. What this covers is
// the behavior no browser test can pin down: that a slow link degrades into a
// slow flowgraph rather than a blank one. Bytes have to reach the ring as they
// arrive, not once a whole request has landed, and a response that stops
// arriving has to be abandoned and resumed from the last byte delivered. fetch
// is stubbed with a stream the test feeds by hand, against a SharedArrayBuffer
// standing in for the shared WASM heap and the control-block layout
// blocks/src/browser_file_source.hpp declares. The worker and the test share one
// thread here, so no case lets the ring fill: the worker's Atomics.wait for
// space would then block the very drain it is waiting on. See
// docs/recording-viewer.md.
//
//   node runner/test/browser_file_reader.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const READ_POS = 0, WRITE_POS = 1, STATE = 2, ERROR_LENGTH = 3;
const RUNNING = 1, EOF_REACHED = 2, ERROR = 3, CANCELLED = 4;

const source = await readFile(new URL('../src/browser_file_reader.js', import.meta.url), 'utf8');

// Each harness gets its own module instance and its own fetch. The stall
// timeout and the retry backoff are shortened so a "dead" response is decided
// in test time, and the request size so that a 256-byte file takes several
// requests without the ring ever filling.
const CHUNK_BYTES = 64;
async function startWorker({ fetch, stallMs = 60 } = {}) {
  const posted = [];
  let closed = false;
  const scope = {
    onmessage: null,
    postMessage: message => posted.push(message),
    close: () => { closed = true; },
    fetch,
    TextEncoder, AbortController, setTimeout, clearTimeout, Promise, Atomics,
    Uint8Array, Int32Array, Math, Number, String, Error, JSON, console,
  };
  let code = source.replace(/^onmessage =/m, 'self.onmessage =');
  code = code.replace(/^const STALL_TIMEOUT_MS = .*$/m, `const STALL_TIMEOUT_MS = ${stallMs};`);
  code = code.replace(/^const MAX_CHUNK_BYTES = .*$/m, `const MAX_CHUNK_BYTES = ${CHUNK_BYTES};`);
  code = code.replace(/^const MAX_BACKOFF_MS = .*$/m, 'const MAX_BACKOFF_MS = 20;');
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

// A ring and control block laid out as browser_file_source.cpp lays them out,
// plus the consumer half of its protocol.
function build({ capacityItems = 64, itemSize = 4 } = {}) {
  const controlPointer = 0;
  const errorPointer = 32;
  const ringPointer = 1024;
  const memory = { buffer: new SharedArrayBuffer(ringPointer + capacityItems * itemSize) };
  const control = new Int32Array(memory.buffer, controlPointer, 4);
  const ring = new Uint8Array(memory.buffer, ringPointer, capacityItems * itemSize);
  return {
    memory, control, ring, controlPointer, errorPointer, ringPointer,
    capacityItems, itemSize, errorCapacity: 512,
    available() {
      const read = Atomics.load(control, READ_POS);
      const write = Atomics.load(control, WRITE_POS);
      return write >= read ? write - read : capacityItems - (read - write);
    },
    // BrowserFileSource::work(), in miniature: take everything published.
    drain() {
      const out = [];
      let read = Atomics.load(control, READ_POS);
      const write = Atomics.load(control, WRITE_POS);
      while (read !== write) {
        out.push(...ring.subarray(read * itemSize, (read + 1) * itemSize));
        read = (read + 1) % capacityItems;
      }
      Atomics.store(control, READ_POS, read);
      Atomics.notify(control, READ_POS);
      return Uint8Array.from(out);
    },
    error() {
      const length = Atomics.load(control, ERROR_LENGTH);
      return new TextDecoder().decode(new Uint8Array(memory.buffer, errorPointer, length));
    },
    message(source, extra = {}) {
      return {
        source, memory, ringPointer, capacityItems, itemSize,
        controlPointer, errorPointer, errorCapacity: 512,
        offsetItems: 0, lengthItems: source.size / itemSize, repeat: false,
        ...extra,
      };
    },
  };
}

const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition, ms = 2000) {
  const started = Date.now();
  while (!condition() && Date.now() - started < ms) await settle(2);
  assert.ok(condition(), 'timed out waiting');
}

// A byte-range server whose responses are streams the test pushes into by hand,
// so what has reached the ring can be checked before a response is complete.
function rangeServer(file, { status = 206 } = {}) {
  const requests = [];
  const fetch = (url, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const request = { url, start: Number(start), end: Number(end) + 1, pushed: 0 };
    let controller;
    request.stream = new ReadableStream({ start(c) { controller = c; } });
    request.push = bytes => {
      controller.enqueue(file.subarray(request.start + request.pushed,
                                       request.start + request.pushed + bytes));
      request.pushed += bytes;
    };
    request.finish = () => controller.close();
    request.die = () => controller.error(new Error('connection reset'));
    requests.push(request);
    init.signal.addEventListener('abort', () => {
      request.aborted = true;
      try { controller.error(init.signal.reason); } catch { /* already closed */ }
    });
    const headers = new Map([['Content-Range',
      `bytes ${request.start}-${request.end - 1}/${file.length}`]]);
    return Promise.resolve({
      status,
      headers: { get: name => headers.get(name) ?? null },
      body: request.stream,
    });
  };
  return { fetch, requests };
}

const file = Uint8Array.from({ length: 256 }, (_, i) => (i * 7 + 3) & 0xff);

// --- bytes reach the ring as they arrive ------------------------------------
{
  const harness = build();
  const server = rangeServer(file);
  const worker = await startWorker({ fetch: server.fetch, stallMs: 10_000 });
  worker.post(harness.message({ kind: 'http', url: 'r2://rec', size: file.length }));
  await settle();
  assert.equal(Atomics.load(harness.control, STATE), RUNNING);
  assert.equal(server.requests.length, 1);
  const [request] = server.requests;
  assert.equal(request.start, 0);
  assert.equal(request.end, CHUNK_BYTES, 'one request is one chunk');

  request.push(10);   // two and a half items
  await settle();
  assert.equal(harness.available(), 2,
    'whole items are published before the response is complete');
  assert.deepEqual(harness.drain(), file.subarray(0, 8));

  request.push(6);    // the half item completes, plus one more
  await settle();
  assert.equal(harness.available(), 2, 'a piece that ended mid-item is carried over');
  assert.deepEqual(harness.drain(), file.subarray(8, 16));

  request.push(request.end - request.pushed);
  request.finish();
  await settle();
  assert.deepEqual(harness.drain(), file.subarray(16, request.end));
  assert.equal(server.requests.length, 2, 'the next range is requested once the first completes');
  assert.equal(server.requests[1].start, request.end);
  assert.ok(!worker.isClosed());
  console.log('ok: bytes are published as they arrive');
}

// --- a stalled response is abandoned and resumed from the last byte ---------
{
  const harness = build();
  const server = rangeServer(file);
  const worker = await startWorker({ fetch: server.fetch, stallMs: 40 });
  worker.post(harness.message({ kind: 'http', url: 'r2://rec', size: file.length }));
  await settle();
  const [first] = server.requests;
  first.push(20);
  await waitFor(() => server.requests.length === 2);
  assert.ok(first.aborted, 'a response that stops arriving is aborted, and retried');
  const [, second] = server.requests;
  assert.equal(second.start, 20, 'from the byte after the last one delivered');
  assert.equal(second.end, first.end);
  assert.deepEqual(harness.drain(), file.subarray(0, 20), 'nothing delivered twice');
  second.push(second.end - 20);
  second.finish();
  await settle();
  assert.deepEqual(harness.drain(), file.subarray(20, second.end));
  assert.notEqual(Atomics.load(harness.control, STATE), ERROR);
  console.log('ok: a stalled response resumes where it stopped');
}

// --- a connection that dies is retried, and one that never answers gives up -
{
  const harness = build();
  const server = rangeServer(file);
  const worker = await startWorker({ fetch: server.fetch, stallMs: 10_000 });
  worker.post(harness.message({ kind: 'http', url: 'r2://rec', size: file.length }));
  await settle();
  server.requests[0].push(12);
  server.requests[0].die();
  await waitFor(() => server.requests.length === 2);
  assert.equal(server.requests[1].start, 12);
  console.log('ok: a reset connection resumes');

  // Every attempt now dies without a byte: the source reports, rather than
  // waiting forever.
  const dead = build();
  const deadServer = rangeServer(file);
  const deadWorker = await startWorker({ fetch: deadServer.fetch, stallMs: 5 });
  deadWorker.post(dead.message({ kind: 'http', url: 'r2://rec', size: file.length }));
  const started = Date.now();
  while (!deadWorker.isClosed() && Date.now() - started < 30_000) await settle(50);
  assert.ok(deadWorker.isClosed(), 'a link that never delivers is given up on');
  assert.equal(Atomics.load(dead.control, STATE), ERROR);
  assert.match(dead.error(), /no data for/);
  assert.equal(deadServer.requests.length, 8, 'after the bounded number of attempts');
  assert.ok(deadServer.requests.every(request => request.start === 0));
  console.log('ok: a dead link is reported');
}

// --- the contract on the response itself is unchanged -----------------------
// A status the server will not answer differently next time fails at once; one
// it might (408, 425, 429, 5xx) is retried, and the read then proceeds.
for (const status of [200, 404]) {
  const harness = build();
  const server = rangeServer(file, { status });
  const worker = await startWorker({ fetch: server.fetch, stallMs: 5 });
  worker.post(harness.message({ kind: 'http', url: 'r2://rec', size: file.length }));
  await waitFor(() => worker.isClosed());
  assert.equal(Atomics.load(harness.control, STATE), ERROR);
  assert.match(harness.error(), new RegExp(`did not honor byte range.*HTTP ${status}`));
  assert.equal(server.requests.length, 1, `a ${status} is refused without a retry`);
  console.log(`ok: a ${status} is refused at once`);
}
{
  const harness = build();
  const server = rangeServer(file);
  let calls = 0;
  const fetch = (url, init) => {
    if (++calls < 3)
      return Promise.resolve({ status: 503, headers: { get: () => null },
                               body: { cancel: async () => {} } });
    return server.fetch(url, init);
  };
  const worker = await startWorker({ fetch, stallMs: 10_000 });
  worker.post(harness.message({ kind: 'http', url: 'r2://rec', size: file.length }));
  await waitFor(() => server.requests.length === 1);
  assert.equal(calls, 3, 'a 503 is retried');
  assert.equal(server.requests[0].start, 0);
  server.requests[0].push(server.requests[0].end);
  server.requests[0].finish();
  await settle();
  assert.deepEqual(harness.drain(), file.subarray(0, server.requests[0].end));
  console.log('ok: a 503 is retried');
}
{
  const harness = build();
  const server = rangeServer(file);
  const worker = await startWorker({ fetch: server.fetch, stallMs: 10_000 });
  worker.post(harness.message({ kind: 'http', url: 'r2://rec', size: file.length }));
  await settle();
  const [request] = server.requests;
  request.push(8);
  request.finish();   // short: the server closed early
  await waitFor(() => server.requests.length === 2);
  assert.equal(server.requests[1].start, 8);
  console.log('ok: a short response resumes');
}

// --- the local path and EOF are as before -----------------------------------
{
  const harness = build({ capacityItems: 128 });
  const worker = await startWorker({ fetch: () => { throw new Error('no fetch for a local file'); } });
  const local = { kind: 'local', size: file.length,
    file: { slice: (a, b) => ({ arrayBuffer: async () => file.slice(a, b).buffer }) } };
  worker.post(harness.message(local));
  const got = [];
  const started = Date.now();
  while (!worker.isClosed() && Date.now() - started < 5_000) {
    got.push(...harness.drain());
    await settle(5);
  }
  got.push(...harness.drain());
  assert.equal(Atomics.load(harness.control, STATE), EOF_REACHED, harness.error());
  assert.deepEqual(Uint8Array.from(got), file, 'a local file streams through the ring intact');
  assert.equal(worker.posted.at(-1).type, 'eof');
  assert.equal(worker.posted.at(-1).bytesRead, file.length);
  console.log('ok: local files and EOF');
}

// --- cancellation mid-response ----------------------------------------------
{
  const harness = build();
  const server = rangeServer(file);
  const worker = await startWorker({ fetch: server.fetch, stallMs: 10_000 });
  worker.post(harness.message({ kind: 'http', url: 'r2://rec', size: file.length }));
  await settle();
  server.requests[0].push(8);
  await settle();
  Atomics.store(harness.control, STATE, CANCELLED);
  server.requests[0].push(8);
  await settle();
  assert.ok(worker.isClosed(), 'a cancelled source stops inside a response');
  assert.equal(worker.posted.at(-1).type, 'cancelled');
  assert.equal(server.requests.length, 1);
  console.log('ok: cancel mid-response');
}

console.log('BROWSER_FILE_READER_OK');
// Responses the cases left open still hold stall timers; nothing else is pending.
process.exit(0);
