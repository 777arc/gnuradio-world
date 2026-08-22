import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_MS,
  MINUTE_MS,
  TokenLimiter,
  applyReserve,
  applySettle,
  countRequest,
  dayOf,
  dayReport,
  emptyDay,
  rollWindow,
  visitorHash,
} from '../src/limiter.js';
import { fakeStorage } from './storage.js';

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

// ---------------------------------------------------------------------------
// Usage stats
// ---------------------------------------------------------------------------

test('a repeat visitor is counted once, and the cap is honest about it', () => {
  const record = emptyDay('2026-08-22');
  countRequest(record, { turn: true, hash: 'aaa' });
  countRequest(record, { turn: false, hash: 'aaa' });
  countRequest(record, { turn: true, hash: 'bbb' });
  countRequest(record, { turn: false, refused: true, hash: 'bbb' });
  assert.equal(record.requests, 4);
  assert.equal(record.turns, 2);
  assert.equal(record.refused, 1);
  assert.equal(record.visitors.length, 2);
  assert.equal(record.visitorsCapped, false);

  for (let i = 0; i < 6000; i++) countRequest(record, { hash: `v${i}` });
  assert.equal(record.visitors.length, 5000, 'the set stops growing');
  assert.equal(record.visitorsCapped, true, 'and says the count is now a floor');
});

test('a report carries counts, never the hashes themselves', () => {
  const record = emptyDay('2026-08-22');
  countRequest(record, { hash: 'secret-hash' });
  const report = dayReport(record);
  assert.equal(report.visitors, 1);
  assert.doesNotMatch(JSON.stringify(report), /secret-hash/);
});

test('the same visitor hashes differently under a different day salt', async () => {
  const monday = await visitorHash('203.0.113.7', 'salt-one');
  const tuesday = await visitorHash('203.0.113.7', 'salt-two');
  assert.equal(monday, await visitorHash('203.0.113.7', 'salt-one'), 'stable within a day');
  assert.notEqual(monday, tuesday, 'and unmatchable across days once the salt is gone');
  assert.match(monday, /^[0-9a-f]{12}$/);
});

test('yesterday\'s hashes cannot be matched against today\'s', async () => {
  const limiter = new TokenLimiter({ storage: fakeStorage() });
  const call = (path, payload) => limiter.fetch(new Request(`https://limiter${path}`, {
    method: 'POST', body: JSON.stringify(payload),
  }));
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-08-22T12:00:00Z');
    await call('/count', { ip: '198.51.100.4' });
    Date.now = () => Date.parse('2026-08-23T12:00:00Z');
    await call('/count', { ip: '198.51.100.4' });
  } finally {
    Date.now = realNow;
  }
  const first = await limiter.ctx.storage.get('day:2026-08-22');
  const second = await limiter.ctx.storage.get('day:2026-08-23');
  assert.equal(first.visitors.length, 1);
  assert.equal(second.visitors.length, 1);
  assert.notEqual(first.visitors[0], second.visitors[0],
    'the salt rotated, so the same visitor leaves no trail between days');
});

test('the history is pruned to its retention window', async () => {
  const limiter = new TokenLimiter({ storage: fakeStorage() });
  await limiter.ctx.storage.put('day:2020-01-01', emptyDay('2020-01-01'));
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-08-22T12:00:00Z');
    await limiter.fetch(new Request('https://limiter/count', {
      method: 'POST', body: JSON.stringify({ ip: '1.2.3.4' }),
    }));
  } finally {
    Date.now = realNow;
  }
  assert.equal(await limiter.ctx.storage.get('day:2020-01-01'), undefined);
  assert.ok(await limiter.ctx.storage.get('day:2026-08-22'));
});

test('a day is a UTC day', () => {
  assert.equal(dayOf(Date.parse('2026-08-22T23:59:59Z')), '2026-08-22');
  assert.equal(dayOf(Date.parse('2026-08-23T00:00:01Z')), '2026-08-23');
});
