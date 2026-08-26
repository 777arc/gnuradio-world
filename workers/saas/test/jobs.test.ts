import assert from 'node:assert/strict';
import test from 'node:test';
import type { Env } from '../src/env';
import { sendLowBalanceEmails } from '../src/jobs';
import { env as baseEnv, seedUser, testDatabase } from './helpers';

test('native email sends the 20% and 5% low-balance notices once each', async () => {
  const { mf, db } = await testDatabase();
  try {
    await seedUser(db, 'user-1', 900_000);
    await db.prepare(
      'UPDATE wallets SET last_purchase_micros = 5000000 WHERE user_id = ?',
    ).bind('user-1').run();

    const messages: Array<Record<string, unknown>> = [];
    const email = {
      send: async (message: Record<string, unknown>) => {
        messages.push(message);
        return { messageId: `message-${messages.length}` };
      },
    } as unknown as SendEmail;
    const env: Env = {
      ...baseEnv(db), EMAIL: email,
      EMAIL_FROM: 'credits@gnuradioworld.com', SUPPORT_EMAIL: 'support@gnuradioworld.com',
    };

    assert.equal(await sendLowBalanceEmails(env, 1_000), 1);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].from, {
      name: 'GNU Radio World Credits', email: 'credits@gnuradioworld.com',
    });
    assert.equal(messages[0].to, 'user-1@example.com');
    assert.equal(messages[0].replyTo, 'support@gnuradioworld.com');
    assert.match(String(messages[0].text), /below 20%/);
    assert.match(String(messages[0].text), /\$0\.9/);
    assert.equal(await sendLowBalanceEmails(env, 1_001), 0);

    await db.prepare('UPDATE wallets SET balance_micros = 200000 WHERE user_id = ?')
      .bind('user-1').run();
    assert.equal(await sendLowBalanceEmails(env, 1_002), 1);
    assert.equal(messages.length, 2);
    assert.match(String(messages[1].text), /below 5%/);
    const wallet = await db.prepare('SELECT low_balance_notice FROM wallets WHERE user_id = ?')
      .bind('user-1').first<{ low_balance_notice: number }>();
    assert.equal(wallet?.low_balance_notice, 5);
  } finally {
    await mf.dispose();
  }
});
