import { Hono } from 'hono';
import type { Auth } from './auth';
import { createAuth } from './auth';
import { chat } from './chat';
import type { Env, RuntimeConfig } from './env';
import { assertSecrets, runtimeConfig } from './env';
import { dailyJobs, reapExpiredHolds } from './jobs';
import { priceUsage, rateFromRow } from './pricing';
import { polarWebhook } from './webhooks';
import { readUsagePage, UsageQueryError } from './usage';

type Session = Awaited<ReturnType<Auth['api']['getSession']>>;
type Variables = { auth: Auth; cfg: RuntimeConfig; session: NonNullable<Session> };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function originAllowed(origin: string, cfg: RuntimeConfig): boolean {
  if (cfg.trustedOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') ||
      url.protocol === 'https:' && url.hostname.endsWith('.gnuradio-world-previews.pages.dev');
  } catch { return false; }
}

function withCors(response: Response, origin: string | null, cfg: RuntimeConfig): Response {
  if (!origin || !originAllowed(origin, cfg)) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

app.use('*', async (c, next) => {
  assertSecrets(c.env);
  const cfg = runtimeConfig(c.env);
  // Exactly one auth instance and one D1 binding are shared for this request.
  c.set('cfg', cfg);
  c.set('auth', createAuth(c.env));
  if (c.req.method === 'OPTIONS') {
    const origin = c.req.header('origin') || '';
    if (!originAllowed(origin, cfg)) return c.body(null, 403);
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
  }
  await next();
  c.res = withCors(c.res, c.req.header('origin') || null, cfg);
});

const requireSession = async (c: any, next: () => Promise<void>) => {
  const session = await c.get('auth').api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    c.res = Response.json({ error: { type: 'authentication_required', message: 'Sign in to continue' } },
      { status: 401 });
    return;
  }
  c.set('session', session);
  await next();
};

async function hashIp(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Checkout is plugin-owned, but this narrow guard ensures only configured
// slugs enter it and rate-limits purchase attempts by both user and IP.
app.post('/api/auth/checkout', async c => {
  const auth = c.get('auth');
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: { message: 'Sign in before checkout' } }, 401);
  let body: { slug?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: { message: 'Invalid checkout request' } }, 400); }
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!c.get('cfg').products[slug]) return c.json({ error: { message: 'Unknown credit pack' } }, 400);
  const now = Math.floor(Date.now() / 1000);
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const ipHash = await hashIp(ip, c.env.BETTER_AUTH_SECRET);
  const limits = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM purchase_attempts WHERE user_id = ? AND created_at > ?) user_count,
       (SELECT COUNT(*) FROM purchase_attempts WHERE ip_hash = ? AND created_at > ?) ip_count`,
  ).bind(session.user.id, now - 3600, ipHash, now - 3600)
    .first<{ user_count: number; ip_count: number }>();
  if ((limits?.user_count || 0) >= c.get('cfg').purchaseRateLimitPerHour ||
      (limits?.ip_count || 0) >= c.get('cfg').purchaseRateLimitPerHour) {
    return c.json({ error: { message: 'Too many purchase attempts; try again later' } }, 429);
  }
  await c.env.DB.prepare(
    'INSERT INTO purchase_attempts(id, user_id, ip_hash, created_at) VALUES (?, ?, ?, ?)',
  ).bind(crypto.randomUUID(), session.user.id, ipHash, now).run();
  const checkoutHeaders = new Headers(c.req.raw.headers);
  checkoutHeaders.delete('content-length');
  const rewritten = new Request(c.req.raw.url, {
    method: 'POST', headers: checkoutHeaders,
    body: JSON.stringify({ slug, redirect: true }),
  });
  return auth.handler(rewritten);
});

app.post('/api/webhooks/polar', c => polarWebhook(c.req.raw, c.env, c.get('cfg')));
app.on(['GET', 'POST'], '/api/auth/*', c => c.get('auth').handler(c.req.raw));

app.use('/api/me', requireSession);
app.use('/api/usage', requireSession);
app.use('/api/chat', requireSession);
app.use('/api/models', requireSession);
app.use('/api/account/anonymize', requireSession);

app.get('/api/me', async c => {
  const session = c.get('session');
  const wallet = await c.env.DB.prepare(
    `SELECT user_id, polar_customer_id, balance_micros, held_micros,
            balance_micros - held_micros available_micros, frozen
     FROM wallets WHERE user_id = ?`,
  ).bind(session.user.id).first();
  if (!wallet) return c.json({ error: { message: 'Wallet setup is incomplete' } }, 503);
  return c.json({ user: session.user, wallet });
});

app.get('/api/usage', async c => {
  try {
    return c.json(await readUsagePage(c.env.DB, c.get('session').user.id,
      c.req.query('limit'), c.req.query('before')));
  } catch (error) {
    if (error instanceof UsageQueryError) {
      return c.json({ error: { type: 'invalid_request_error', message: error.message } }, 400);
    }
    throw error;
  }
});

app.get('/api/models', async c => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM model_rates WHERE effective_at <= unixepoch()
       AND (ends_at IS NULL OR ends_at > unixepoch()) ORDER BY model`,
  ).all<Record<string, any>>();
  return c.json({ data: rows.results.map(row => {
    const rate = rateFromRow(row);
    const oneMillionInput = priceUsage(rate, {
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    });
    const oneMillionCached = priceUsage(rate, {
      inputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0,
    });
    const oneMillionCacheWrite = priceUsage(rate, {
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 0,
    });
    const oneMillionOutput = priceUsage(rate, {
      inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000,
    });
    return {
      id: row.model, name: row.model,
      pricing_micros_per_million: {
        input: oneMillionInput.retailMicros,
        cached_input: oneMillionCached.retailMicros,
        cache_write: oneMillionCacheWrite.retailMicros,
        output: oneMillionOutput.retailMicros,
      },
      minimum_charge_micros: row.minimum_charge_micros,
    };
  }) });
});

app.post('/api/chat', c => chat(c.req.raw, c.env, c.get('cfg'),
  c.get('session').user.id, promise => c.executionCtx.waitUntil(promise)));

app.post('/api/account/anonymize', async c => {
  const userId = c.get('session').user.id;
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM session WHERE userId = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM account WHERE userId = ?').bind(userId),
    c.env.DB.prepare(
      `UPDATE "user" SET name = 'Deleted user', email = ?, emailVerified = 0,
       image = NULL, updatedAt = ? WHERE id = ?`,
    ).bind(`deleted+${userId}@invalid.gnuradioworld.com`, now, userId),
    c.env.DB.prepare('UPDATE wallets SET frozen = 1, polar_customer_id = NULL, updated_at = ? WHERE user_id = ?')
      .bind(now, userId),
  ]);
  return c.json({ anonymized: true });
});

app.get('/health', c => c.json({ ok: true, environment: c.env.ENVIRONMENT || 'sandbox' }));

app.onError((error, c) => {
  // Never serialize arbitrary upstream/SDK errors: they can contain account
  // metadata or a credential. Logs carry only the error class.
  console.error(JSON.stringify({ error: error.name, path: c.req.path }));
  return c.json({ error: { type: 'internal_error', message: 'The request could not be completed' } }, 500);
});

const worker: ExportedHandler<Env> = {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    assertSecrets(env);
    const cfg = runtimeConfig(env);
    if (controller.cron === '* * * * *') ctx.waitUntil(reapExpiredHolds(env));
    else ctx.waitUntil(dailyJobs(env, cfg));
  },
};

export default worker;
