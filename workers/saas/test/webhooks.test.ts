import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Polar } from '@polar-sh/sdk';
import { cfg, env, seedUser, testDatabase, type TestDatabase } from './helpers';
import { polarWebhook, processVerifiedPolarEvent } from '../src/webhooks';

const databases: TestDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(item => item.mf.dispose())); });

test('forged raw webhook body is rejected and grants nothing', async () => {
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'buyer', 0);
  const response = await polarWebhook(new Request('https://credits.example/api/webhooks/polar', {
    method: 'POST', body: JSON.stringify({ type: 'order.paid', data: { product_id: 'product-five' } }),
    headers: { 'Content-Type': 'application/json', 'webhook-id': 'forged' },
  }), env(t.db), cfg());
  assert.equal(response.status, 403);
  const wallet = await t.db.prepare('SELECT balance_micros FROM wallets WHERE user_id = ?')
    .bind('buyer').first<{ balance_micros: number }>();
  assert.equal(wallet?.balance_micros, 0);
});

test('verified paid order maps credits only from product id and replay grants once', async () => {
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'buyer', 0);
  const event = {
    type: 'order.paid', timestamp: new Date(),
    data: {
      id: 'order-1', paid: true, productId: 'product-five', netAmount: 500,
      customer: { id: 'polar-customer', externalId: 'buyer' },
      metadata: { creditsMicros: 999_999_999 },
    },
  };
  const polar = new Polar({ accessToken: 'unused', server: 'sandbox' });
  assert.equal(await processVerifiedPolarEvent(t.db, polar, 'event-1', event, cfg(5_000_000)), false);
  assert.equal(await processVerifiedPolarEvent(t.db, polar, 'event-1', event, cfg(5_000_000)), true);
  const wallet = await t.db.prepare('SELECT balance_micros, polar_customer_id FROM wallets WHERE user_id = ?')
    .bind('buyer').first<{ balance_micros: number; polar_customer_id: string }>();
  assert.deepEqual(wallet, { balance_micros: 5_000_000, polar_customer_id: 'polar-customer' });
  const entries = await t.db.prepare("SELECT * FROM ledger_entries WHERE kind = 'purchase'").all();
  assert.equal(entries.results.length, 1);
  assert.equal((entries.results[0] as any).amount_micros, 5_000_000);
});
