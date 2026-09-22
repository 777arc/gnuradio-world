import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const READ_POS = 0, WRITE_POS = 1, STATE = 2, ERROR_LENGTH = 3;
const EOF_REACHED = 2, ERROR = 3;

const source = await readFile(new URL('../src/browser_file_reader.js', import.meta.url), 'utf8');

async function startWorker(fetchImpl) {
  const posted = [];
  let closed = false;
  const scope = {
    onmessage: null,
    postMessage: message => posted.push(message),
    close: () => { closed = true; },
    fetch: fetchImpl,
    setTimeout: callback => {
      callback();
      return 0;
    },
    Promise, Atomics, Uint8Array, Int32Array,
    TextEncoder, TextDecoder, Math, Number, String, Error, console,
  };
  const factory = new Function('self', 'globalThis', `
    with (self) {
      ${source.replace(/^onmessage =/m, 'self.onmessage =')}
    }
  `);
  factory(scope, scope);
  return {
    post: data => scope.onmessage({ data }),
    posted,
    isClosed: () => closed,
  };
}

function buildHarness({ capacityItems, itemSize = 1 }) {
  const controlPointer = 0;
  const errorPointer = 32;
  const ringPointer = 1024;
  const memory = { buffer: new ArrayBuffer(ringPointer + capacityItems * itemSize) };
  const control = new Int32Array(memory.buffer, controlPointer, 4);
  return {
    memory,
    control,
    controlPointer,
    errorPointer,
    ringPointer,
    capacityItems,
    itemSize,
    errorCapacity: 512,
  };
}

function make206(start, end, total = '*') {
  return {
    status: 206,
    headers: { get: name => name.toLowerCase() === 'content-range' ? `bytes ${start}-${end - 1}/${total}` : null },
    body: { cancel: async () => {} },
    arrayBuffer: async () => new ArrayBuffer(end - start),
  };
}

function parseRange(rangeHeader) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader || '');
  if (!match) throw new Error(`unexpected Range header: ${rangeHeader}`);
  const start = Number(match[1]);
  const end = Number(match[2]) + 1;
  return { start, end };
}

async function waitForClosed(worker) {
  for (let i = 0; i < 50; ++i) {
    if (worker.isClosed()) return;
    await Promise.resolve();
  }
  throw new Error('worker did not close');
}

function readerErrorMessage(harness) {
  const length = Atomics.load(harness.control, ERROR_LENGTH);
  return new TextDecoder().decode(new Uint8Array(
    harness.memory.buffer, harness.errorPointer, Math.max(0, length)));
}

{
  const requests = [];
  const worker = await startWorker(async (_url, init) => {
    const { start, end } = parseRange(init?.headers?.Range);
    requests.push({ start, end, bytes: end - start });
    return make206(start, end, 600_000);
  });
  const harness = buildHarness({ capacityItems: 700_000, itemSize: 1 });
  worker.post({
    source: { kind: 'http', url: 'https://example.test/data.sigmf-data', size: 600_000 },
    memory: harness.memory,
    ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems,
    itemSize: harness.itemSize,
    controlPointer: harness.controlPointer,
    errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
    offsetItems: 0,
    lengthItems: 600_000,
    repeat: false,
  });
  await waitForClosed(worker);

  assert.equal(Atomics.load(harness.control, STATE), EOF_REACHED);
  assert.ok(requests.length >= 3, 'the transfer is split into multiple HTTP requests');
  assert.ok(requests.every(request => request.bytes <= 256 * 1024),
    'each HTTP range read is capped at 256 KiB');
}

{
  let calls = 0;
  const worker = await startWorker(async () => {
    calls += 1;
    return {
      status: 404,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
  const harness = buildHarness({ capacityItems: 64, itemSize: 1 });
  worker.post({
    source: { kind: 'http', url: 'https://example.test/missing.sigmf-data', size: 8 },
    memory: harness.memory,
    ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems,
    itemSize: harness.itemSize,
    controlPointer: harness.controlPointer,
    errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
    offsetItems: 0,
    lengthItems: 8,
    repeat: false,
  });
  await waitForClosed(worker);

  assert.equal(calls, 1, 'permanent HTTP protocol errors fail immediately');
  assert.equal(Atomics.load(harness.control, STATE), ERROR);
  assert.match(readerErrorMessage(harness), /HTTP 404/);
}

{
  let calls = 0;
  const worker = await startWorker(async (_url, init) => {
    calls += 1;
    const { start, end } = parseRange(init?.headers?.Range);
    if (calls < 3) {
      return {
        status: 503,
        headers: { get: () => null },
        body: { cancel: async () => {} },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return make206(start, end, 32);
  });
  const harness = buildHarness({ capacityItems: 128, itemSize: 1 });
  worker.post({
    source: { kind: 'http', url: 'https://example.test/transient.sigmf-data', size: 32 },
    memory: harness.memory,
    ringPointer: harness.ringPointer,
    capacityItems: harness.capacityItems,
    itemSize: harness.itemSize,
    controlPointer: harness.controlPointer,
    errorPointer: harness.errorPointer,
    errorCapacity: harness.errorCapacity,
    offsetItems: 0,
    lengthItems: 32,
    repeat: false,
  });
  await waitForClosed(worker);

  assert.equal(calls, 3, 'retryable HTTP status codes are retried');
  assert.equal(Atomics.load(harness.control, STATE), EOF_REACHED);
}

console.log('browser_file_reader: HTTP chunk cap and retry policy — OK');
