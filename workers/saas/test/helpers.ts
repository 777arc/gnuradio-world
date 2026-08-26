import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { Env, RuntimeConfig } from '../src/env';

export interface TestDatabase {
  mf: Miniflare;
  db: D1Database;
}

export async function testDatabase(): Promise<TestDatabase> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  });
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const root = new URL('../', import.meta.url);
  for (const file of [
    'migrations/0001_better_auth.sql',
    'migrations/0002_billing.sql',
    'migrations/0003_direct_openai.sql',
    'migrations/0004_gpt56_pricing.sql',
  ]) {
    const sql = (await readFile(fileURLToPath(new URL(file, root)), 'utf8'))
      .replace(/^\s*--.*$/gm, '')
      .replace(/^\s*PRAGMA foreign_keys\s*=\s*ON;\s*$/gmi, '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  return { mf, db };
}

export async function seedUser(db: D1Database, userId = 'user-1', balanceMicros = 0): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    ).bind(userId, 'Test User', `${userId}@example.com`, 1, now, now),
    db.prepare(
      `INSERT INTO wallets(user_id,balance_micros,held_micros,frozen,created_at,updated_at)
       VALUES (?, ?, 0, 0, ?, ?)`,
    ).bind(userId, balanceMicros, now, now),
  ]);
  if (balanceMicros > 0) {
    await db.batch([
      db.prepare(
        `INSERT INTO ledger_entries(id,user_id,kind,amount_micros,idempotency_key,metadata,created_at)
         VALUES (?,?,'adjustment',?,'seed','{}',?)`,
      ).bind(crypto.randomUUID(), userId, balanceMicros, now),
      db.prepare(
        `INSERT INTO credit_lots(id,user_id,order_id,original_micros,remaining_micros,expires_at,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), userId, `seed-${userId}`, balanceMicros, balanceMicros,
        now + 31_536_000, now),
    ]);
  }
}

export async function seedRate(db: D1Database, model = 'test/model'): Promise<void> {
  await db.prepare(
    `INSERT INTO model_rates
       (id,model,provider,input_micros_per_million,cached_input_micros_per_million,
        cache_write_micros_per_million,output_micros_per_million,markup_bps,
        minimum_charge_micros,effective_at)
     VALUES ('rate-1',?,'openai',1000000,100000,1250000,2000000,5000,100,0)`,
  ).bind(model).run();
}

export const cfg = (creditsMicros = 5_000_000): RuntimeConfig => ({
  appUrl: 'https://gnuradioworld.com',
  trustedOrigins: ['https://gnuradioworld.com'],
  polarServer: 'sandbox',
  products: { five: { productId: 'product-five', creditsMicros } },
  productCredits: new Map([['product-five', creditsMicros]]),
  maxChatBodyBytes: 1_048_576,
  maxCompletionTokens: 16_384,
  holdTtlSeconds: 900,
  purchaseRateLimitPerHour: 10,
  absorbedAlertBps: 200,
});

export const env = (db: D1Database): Env => ({
  DB: db,
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long',
  BETTER_AUTH_URL: 'https://credits.gnuradioworld.com',
  GOOGLE_CLIENT_ID: 'google-id', GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-id', GITHUB_CLIENT_SECRET: 'github-secret',
  POLAR_ACCESS_TOKEN: 'polar-secret-token', POLAR_WEBHOOK_SECRET: 'webhook-secret',
  OPENAI_API_KEY: 'openai-secret-key',
  POLAR_SERVER: 'sandbox', CREDIT_PRODUCTS: '{}',
});

export const sse = (...events: unknown[]): Response => {
  const text = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
};
