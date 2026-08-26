import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateHold, priceUsage } from '../src/pricing';

const rate = {
  id: 'v1', model: 'test/model', provider: 'openai',
  inputMicrosPerMillion: 1_000_000,
  cachedInputMicrosPerMillion: 100_000,
  cacheWriteMicrosPerMillion: 1_250_000,
  outputMicrosPerMillion: 2_000_000,
  markupBps: 5_000,
  minimumChargeMicros: 100,
};

test('pricing uses integer micro-dollars, cache reads/writes, ceil rounding, markup, and minimum', () => {
  assert.deepEqual(priceUsage(rate, {
    inputTokens: 90, cachedInputTokens: 10, cacheWriteTokens: 10, outputTokens: 50,
  }), { wholesaleMicros: 184, retailMicros: 276 });
  assert.deepEqual(priceUsage(rate, {
    inputTokens: 1, cachedInputTokens: 1, cacheWriteTokens: 0, outputTokens: 0,
  }), { wholesaleMicros: 1, retailMicros: 100 });
  assert.equal(estimateHold(rate, 100, 100), 586);
});

test('pricing rejects fractional money-path inputs', () => {
  assert.throws(() => priceUsage(rate, {
    inputTokens: 1.5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1,
  }), /safe integer/);
});

test('pricing rejects overlapping input token classes', () => {
  assert.throws(() => priceUsage(rate, {
    inputTokens: 10, cachedInputTokens: 6, cacheWriteTokens: 5, outputTokens: 0,
  }), /cannot exceed inputTokens/);
});
