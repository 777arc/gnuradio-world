import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { absorbAndRelease, activeRate, InsufficientFundsError, reserve, settle } from '../src/ledger';
import { seedRate, seedUser, testDatabase, type TestDatabase } from './helpers';

const databases: TestDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(item => item.mf.dispose())); });

test('two concurrent reservations against one affordable balance admit exactly one', async () => {
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'race', 586);
  await seedRate(t.db);
  const rate = (await activeRate(t.db, 'test/model'))!;
  const attempt = (requestId: string) => reserve(t.db, {
    userId: 'race', requestId, model: 'test/model', rate,
    inputTokens: 100, maxOutputTokens: 100, holdTtlSeconds: 900,
  });
  const results = await Promise.allSettled([attempt('request-a'), attempt('request-b')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof InsufficientFundsError);
  const wallet = await t.db.prepare('SELECT held_micros FROM wallets WHERE user_id = ?')
    .bind('race').first<{ held_micros: number }>();
  assert.equal(wallet?.held_micros, 586);
});

test('settlement is atomic and retry-safe, and keeps cache-aware real usage', async () => {
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'settle', 586);
  await seedRate(t.db);
  const rate = (await activeRate(t.db, 'test/model'))!;
  const hold = await reserve(t.db, {
    userId: 'settle', requestId: 'request-settle', model: 'test/model', rate,
    inputTokens: 100, maxOutputTokens: 100, holdTtlSeconds: 900,
  });
  const usage = { inputTokens: 90, cachedInputTokens: 10, cacheWriteTokens: 5, outputTokens: 50 };
  await settle(t.db, hold, usage);
  await settle(t.db, hold, usage);
  const wallet = await t.db.prepare('SELECT balance_micros, held_micros FROM wallets WHERE user_id = ?')
    .bind('settle').first<{ balance_micros: number; held_micros: number }>();
  assert.deepEqual(wallet, { balance_micros: 311, held_micros: 0 });
  const entries = await t.db.prepare("SELECT * FROM ledger_entries WHERE kind = 'usage'").all();
  assert.equal(entries.results.length, 1);
  assert.equal((entries.results[0] as any).amount_micros, -275);
  assert.equal((entries.results[0] as any).cached_input_tokens, 10);
  assert.equal((entries.results[0] as any).cache_write_tokens, 5);
  assert.equal((entries.results[0] as any).rate_version_id, 'rate-1');
  const lot = await t.db.prepare('SELECT remaining_micros FROM credit_lots WHERE user_id = ?')
    .bind('settle').first<{ remaining_micros: number }>();
  assert.equal(lot?.remaining_micros, 311);
});

test('an upstream failure after output records one nonzero absorption and charges nothing', async () => {
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'absorb', 1_000);
  await seedRate(t.db);
  const rate = (await activeRate(t.db, 'test/model'))!;
  const hold = await reserve(t.db, {
    userId: 'absorb', requestId: 'request-absorb', model: 'test/model', rate,
    inputTokens: 100, maxOutputTokens: 100, holdTtlSeconds: 900,
  });
  await absorbAndRelease(t.db, hold, {
    reason: 'upstream_error', exact: false,
    usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 25 },
  });
  await absorbAndRelease(t.db, hold, {
    reason: 'upstream_error', exact: false,
    usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 25 },
  });
  const wallet = await t.db.prepare('SELECT balance_micros, held_micros FROM wallets WHERE user_id = ?')
    .bind('absorb').first<{ balance_micros: number; held_micros: number }>();
  assert.deepEqual(wallet, { balance_micros: 1_000, held_micros: 0 });
  const absorbed = await t.db.prepare('SELECT * FROM absorbed_costs').all();
  assert.equal(absorbed.results.length, 1);
  assert.equal((absorbed.results[0] as any).reason, 'upstream_error');
  assert.equal((absorbed.results[0] as any).exact, 0);
  assert.ok(Number((absorbed.results[0] as any).wholesale_micros) > 0);
});
