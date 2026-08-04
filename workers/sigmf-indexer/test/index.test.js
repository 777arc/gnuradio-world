import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { INDEX_KEY, rebuildIndex, sigmfBytesPerSample } from '../src/index.js';

class MockBucket {
  constructor(pages, metadata) {
    this.pages = pages;
    this.metadata = metadata;
    this.puts = [];
  }

  async list(options) {
    const pageIndex = options.cursor ? Number(options.cursor) : 0;
    const objects = this.pages[pageIndex];
    return {
      objects,
      truncated: pageIndex < this.pages.length - 1,
      ...(pageIndex < this.pages.length - 1 ? { cursor: String(pageIndex + 1) } : {}),
    };
  }

  async get(key) {
    if (!this.metadata.has(key)) return null;
    return { text: async () => this.metadata.get(key) };
  }

  async put(key, value, options) {
    this.puts.push({ key, value, options });
  }
}

const object = (key, size) => ({ key, size });

function captureLogger() {
  const entries = [];
  return {
    entries,
    log(message, details) { entries.push({ level: 'log', message, details }); },
    warn(message, details) { entries.push({ level: 'warn', message, details }); },
  };
}

test('calculates bytes per real and complex SigMF sample', () => {
  assert.equal(sigmfBytesPerSample('cf32_le'), 8);
  assert.equal(sigmfBytesPerSample('ci16_be'), 4);
  assert.equal(sigmfBytesPerSample('ru8'), 1);
  assert.equal(sigmfBytesPerSample('not-a-datatype'), null);
  assert.equal(sigmfBytesPerSample('ri12_le'), null);
});

test('paginates, pairs files, extracts metadata, sorts, and replaces index.json', async () => {
  const pages = [
    [
      object('zulu.sigmf-meta', 400),
      object('orphan.sigmf-meta', 200),
      object(INDEX_KEY, 100),
    ],
    [
      object('zulu.sigmf-data', 80),
      object('collection/alpha.sigmf-data', 12),
      object('collection/alpha.sigmf-meta', 500),
      object('unpaired.sigmf-data', 64),
    ],
  ];
  const metadata = new Map([
    ['zulu.sigmf-meta', JSON.stringify({
      global: {
        'core:datatype': 'cf32_le',
        'core:sample_rate': 250000,
        'core:author': 'Marc',
        'core:description': 'RDS burst',
      },
      captures: [{ 'core:sample_start': 0, 'core:frequency': 100000000 }],
      annotations: [{}, {}],
    })],
    ['collection/alpha.sigmf-meta', JSON.stringify({
      global: {
        'core:datatype': 'ri16_le',
        'core:sample_rate': 48000,
      },
      captures: [{ 'core:sample_start': 0 }],
    })],
  ]);
  const bucket = new MockBucket(pages, metadata);

  const result = await rebuildIndex(bucket);

  assert.deepEqual(result, [
    {
      base_filename: 'collection/alpha',
      datatype: 'ri16_le',
      sample_rate: 48000,
      author: null,
      description: null,
      frequency: null,
      byte_length: 12,
      number_of_samples: 6,
      number_of_annotations: 0,
    },
    {
      base_filename: 'zulu',
      datatype: 'cf32_le',
      sample_rate: 250000,
      author: 'Marc',
      description: 'RDS burst',
      frequency: 100000000,
      byte_length: 80,
      number_of_samples: 10,
      number_of_annotations: 2,
    },
  ]);
  assert.equal(bucket.puts.length, 1);
  assert.equal(bucket.puts[0].key, INDEX_KEY);
  assert.deepEqual(JSON.parse(bucket.puts[0].value), result);
  assert.equal(bucket.puts[0].options.httpMetadata.contentType, 'application/json; charset=utf-8');
});

test('does not replace the old index when matched metadata is malformed', async () => {
  const bucket = new MockBucket(
    [[object('bad.sigmf-meta', 20), object('bad.sigmf-data', 8)]],
    new Map([['bad.sigmf-meta', '{']]),
  );

  await assert.rejects(rebuildIndex(bucket), /Invalid JSON in bad\.sigmf-meta/);
  assert.equal(bucket.puts.length, 0);
});

test('uses null when sample size cannot be derived safely', async () => {
  const bucket = new MockBucket(
    [[object('odd.sigmf-meta', 20), object('odd.sigmf-data', 7)]],
    new Map([['odd.sigmf-meta', JSON.stringify({
      global: { 'core:datatype': 'ci16_le' },
      captures: [],
      annotations: [],
    })]]),
  );

  const [recording] = await rebuildIndex(bucket);
  assert.equal(recording.number_of_samples, null);
});

test('accepts case variants of the standard SigMF suffixes', async () => {
  const bucket = new MockBucket(
    [[object('upper.SIGMF-META', 20), object('upper.SIGMF-DATA', 8)]],
    new Map([['upper.SIGMF-META', JSON.stringify({
      global: { 'core:datatype': 'cf32_le' },
      captures: [],
      annotations: [],
    })]]),
  );

  const [recording] = await rebuildIndex(bucket);
  assert.equal(recording.base_filename, 'upper');
  assert.equal(recording.number_of_samples, 1);
});

test('logs unmatched SigMF keys and retains the old index when no pair exists', async () => {
  const bucket = new MockBucket(
    [[object('recordings/lonely.sigmf-data', 80), object(INDEX_KEY, 3)]],
    new Map(),
  );
  const logger = captureLogger();

  await assert.rejects(
    rebuildIndex(bucket, { logger }),
    /1 \.sigmf-data and 0 \.sigmf-meta objects, but no matching base filenames/,
  );
  assert.equal(bucket.puts.length, 0);
  assert.deepEqual(
    logger.entries.find(entry => entry.message === 'SigMF data objects without matching metadata'),
    {
      level: 'warn',
      message: 'SigMF data objects without matching metadata',
      details: { count: 1, sample_keys: ['recordings/lonely.sigmf-data'] },
    },
  );
});

test('rebuilds the index once for an entire R2 notification batch', async () => {
  const bucket = new MockBucket(
    [[object('queued.sigmf-meta', 20), object('queued.sigmf-data', 8)]],
    new Map([['queued.sigmf-meta', JSON.stringify({
      global: { 'core:datatype': 'cf32_le' },
      captures: [],
      annotations: [],
    })]]),
  );

  await worker.queue({
    messages: [
      { body: { object: { key: 'queued.sigmf-data' } } },
      { body: { object: { key: 'queued.sigmf-meta' } } },
    ],
  }, { RECORDINGS: bucket });

  assert.equal(bucket.puts.length, 1);
  assert.equal(bucket.puts[0].key, INDEX_KEY);
});

test('manual rebuild endpoint requires POST and the configured bearer token', async () => {
  const env = { REBUILD_TOKEN: 'test-secret', RECORDINGS: new MockBucket([[]], new Map()) };

  const wrongMethod = await worker.fetch(new Request('https://worker.example/rebuild'), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'POST');

  const unauthorized = await worker.fetch(new Request('https://worker.example/rebuild', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-secret' },
  }), env);
  assert.equal(unauthorized.status, 401);
  assert.equal(env.RECORDINGS.puts.length, 0);
});

test('authenticated manual rebuild replaces the index and reports its count', async () => {
  const bucket = new MockBucket(
    [[object('manual.sigmf-meta', 20), object('manual.sigmf-data', 8)]],
    new Map([['manual.sigmf-meta', JSON.stringify({
      global: { 'core:datatype': 'cf32_le' },
      captures: [],
      annotations: [],
    })]]),
  );
  const response = await worker.fetch(new Request('https://worker.example/rebuild', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret' },
  }), { REBUILD_TOKEN: 'test-secret', RECORDINGS: bucket });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    recordings: 1,
    index_key: INDEX_KEY,
  });
  assert.equal(bucket.puts.length, 1);
});
