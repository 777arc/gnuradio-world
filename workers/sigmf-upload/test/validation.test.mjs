import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DATA_LIMIT,
  META_LIMIT,
  SUBMISSION_LIMIT,
  parseSigmfMetadata,
  sigmfBytesPerSample,
  validateManifest,
} from '../src/index.js';

const meta = (datatype = 'ci16_le') => JSON.stringify({
  global: { 'core:datatype': datatype, 'core:sample_rate': 2_000_000 },
  captures: [{ 'core:sample_start': 0, 'core:frequency': 100_000_000 }],
  annotations: [],
});

test('parses the SigMF fields used by triage', () => {
  const parsed = parseSigmfMetadata(meta());
  assert.equal(parsed.summary.datatype, 'ci16_le');
  assert.equal(parsed.summary.sampleRate, 2_000_000);
  assert.equal(parsed.summary.frequency, 100_000_000);
  assert.equal(sigmfBytesPerSample('ci16_le'), 4);
  assert.equal(sigmfBytesPerSample('rf32_le'), 4);
  assert.equal(sigmfBytesPerSample('not-a-type'), null);
});

test('rejects invalid JSON and malformed SigMF metadata', () => {
  assert.throws(() => parseSigmfMetadata('{'), /not valid JSON/);
  assert.throws(() => parseSigmfMetadata('{}'), /no global object/);
  assert.throws(() => parseSigmfMetadata(meta('wrong')), /invalid core:datatype/);
});

test('accepts exact file limits and keeps contact separate from public fields', () => {
  const value = validateManifest({
    recordings: [{ base: 'capture', dataSize: DATA_LIMIT, metaSize: META_LIMIT }],
    publicNotes: 'public',
    contact: { email: 'radio@example.test' },
  });
  assert.equal(value.total, DATA_LIMIT + META_LIMIT);
  assert.equal(value.contactEmail, 'radio@example.test');
  assert.equal(value.publicNotes, 'public');
});

test('rejects oversized, duplicate, and over-total manifests', () => {
  assert.throws(() => validateManifest({
    recordings: [{ base: 'x', dataSize: DATA_LIMIT + 1, metaSize: 1 }],
  }), /sigmf-data/);
  assert.throws(() => validateManifest({ recordings: [
    { base: 'Capture', dataSize: 1, metaSize: 1 },
    { base: 'capture', dataSize: 1, metaSize: 1 },
  ] }), /Duplicate/);
  assert.throws(() => validateManifest({
    recordings: [{ base: 'x', dataSize: 1, metaSize: 1 }],
    sourceUrl: 'javascript:alert(1)',
  }), /HTTP or HTTPS/);
  assert.throws(() => validateManifest({ recordings: Array.from({ length: 7 }, (_, index) => ({
    base: `capture-${index}`, dataSize: DATA_LIMIT, metaSize: 1,
  })) }), new RegExp(String(SUBMISSION_LIMIT)));
});
