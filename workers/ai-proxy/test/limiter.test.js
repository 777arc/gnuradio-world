import test from 'node:test';
import assert from 'node:assert/strict';

import { DAY_MS, MINUTE_MS, applyReserve, applySettle, rollWindow } from '../src/limiter.js';

const MINUTE = { limit: 1_000_000, windowMs: MINUTE_MS };

test('a first reservation opens a window', () => {
  const { state, result } = applyReserve(undefined, { now: 1000, estimate: 5000, ...MINUTE });
  assert.equal(state.windowStart, 1000);
  assert.equal(state.used, 5000);
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 995_000);
  assert.equal(result.resetIn, 60);
});

test('reservations accumulate inside one window', () => {
  let state;
  for (let i = 0; i < 3; i++) {
    ({ state } = applyReserve(state, { now: 1000 + i * 1000, estimate: 10_000, ...MINUTE }));
  }
  assert.equal(state.used, 30_000);
  assert.equal(state.windowStart, 1000, 'the window keeps its original start');
});

test('a used-up window refuses with a non-zero retry', () => {
  const state = { windowStart: 0, used: MINUTE.limit };
  const { result } = applyReserve(state, { now: 59_999, estimate: 10, ...MINUTE });
  assert.equal(result.ok, false);
  assert.equal(result.remaining, 0);
  assert.equal(result.retryAfter, 1, 'a client told to wait 0s would retry immediately');
});

test('admit-if-under-limit lets one request overshoot rather than refusing it', () => {
  const state = { windowStart: 0, used: MINUTE.limit - 1 };
  const { state: next, result } = applyReserve(state, { now: 1000, estimate: 500_000, ...MINUTE });
  assert.equal(result.ok, true, 'the window still had budget, so the turn runs');
  assert.ok(next.used > MINUTE.limit);
  // ... and the next one is refused.
  assert.equal(applyReserve(next, { now: 2000, estimate: 10, ...MINUTE }).result.ok, false);
});

test('the window rolls once it has expired', () => {
  const state = { windowStart: 0, used: MINUTE.limit };
  const { state: next, result } = applyReserve(state, { now: MINUTE_MS, estimate: 100, ...MINUTE });
  assert.equal(result.ok, true);
  assert.equal(next.windowStart, MINUTE_MS);
  assert.equal(next.used, 100, 'the previous minute is not carried over');
});

test('a clock moving backwards does not hold a window open', () => {
  const rolled = rollWindow({ windowStart: 10_000, used: 5 }, 1000, MINUTE_MS);
  assert.deepEqual(rolled, { windowStart: 1000, used: 0 });
});

test('settling charges the difference between estimate and truth', () => {
  const { state, result } = applyReserve(undefined, { now: 0, estimate: 12_000, ...MINUTE });
  // The completion actually spent 30,000 tokens.
  const settled = applySettle(state, {
    now: 5000, delta: 30_000 - 12_000, windowStart: result.windowStart, ...MINUTE,
  });
  assert.equal(settled.used, 30_000);
});

test('a generous estimate is refunded, never below zero', () => {
  const state = { windowStart: 0, used: 12_000 };
  const settled = applySettle(state, { now: 100, delta: -20_000, windowStart: 0, ...MINUTE });
  assert.equal(settled.used, 0);
});

test('a settle arriving after its window rolled leaves the new window alone', () => {
  const state = { windowStart: 0, used: 8000 };
  // The reservation belonged to the window that started at 0; this settle
  // lands two minutes later, against a window that has since rolled.
  const settled = applySettle(state, {
    now: 2 * MINUTE_MS, delta: 500_000, windowStart: 0, windowMs: MINUTE_MS,
  });
  assert.equal(settled.used, 0);
  assert.equal(settled.windowStart, 2 * MINUTE_MS);
});

test('the same arithmetic serves the global daily window', () => {
  const day = { limit: 5_000_000, windowMs: DAY_MS };
  const { state } = applyReserve(undefined, { now: 0, estimate: 4_999_999, ...day });
  assert.equal(applyReserve(state, { now: 1000, estimate: 1, ...day }).result.ok, true);
  const spent = applySettle(state, { now: 1000, delta: 2, windowStart: 0, ...day });
  const refused = applyReserve(spent, { now: 2000, estimate: 1, ...day }).result;
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfter, 86_398);
});
