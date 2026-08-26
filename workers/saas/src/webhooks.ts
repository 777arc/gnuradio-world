import { Polar } from '@polar-sh/sdk';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import type { Env, RuntimeConfig } from './env';

const monthsFrom = (date: Date, months: number): number => {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return Math.floor(copy.getTime() / 1000);
};

const eventId = (headers: Headers): string =>
  headers.get('webhook-id') || headers.get('Webhook-Id') || '';

const alreadyProcessed = async (db: D1Database, id: string): Promise<boolean> =>
  !!(await db.prepare('SELECT 1 AS yes FROM processed_webhooks WHERE event_id = ?')
    .bind(id).first());

const duplicateWebhook = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: processed_webhooks/i.test(error.message);

export async function grantOrder(db: D1Database, id: string, event: any,
  cfg: RuntimeConfig): Promise<void> {
  const order = event.data;
  const userId = order.customer?.externalId;
  const productId = order.productId;
  const credits = productId ? cfg.productCredits.get(productId) : undefined;
  if (!userId || !credits || !order.paid) throw new Error('Paid order has no mapped product or external customer');
  const now = Math.floor(event.timestamp.getTime() / 1000);
  await db.batch([
    db.prepare('INSERT INTO processed_webhooks(event_id, event_type, processed_at) VALUES (?, ?, ?)')
      .bind(id, event.type, now),
    db.prepare(
      `INSERT OR IGNORE INTO wallets
         (user_id, polar_customer_id, balance_micros, held_micros, frozen, created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)`,
    ).bind(userId, order.customer.id, now, now),
    db.prepare(
      `INSERT INTO ledger_entries
         (id, user_id, kind, amount_micros, idempotency_key, metadata, created_at)
       VALUES (?, ?, 'purchase', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, credits, `purchase:${order.id}`,
      JSON.stringify({ order_id: order.id, product_id: productId, paid_cents: order.netAmount }), now),
    db.prepare(
      `UPDATE wallets SET balance_micros = balance_micros + ?, polar_customer_id = ?,
         last_purchase_micros = ?, low_balance_notice = 0, updated_at = ? WHERE user_id = ?`,
    ).bind(credits, order.customer.id, credits, now, userId),
    db.prepare(
      `INSERT INTO credit_lots
         (id, user_id, order_id, original_micros, remaining_micros, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, order.id, credits, credits,
      monthsFrom(event.timestamp, 12), now),
  ]);
}

async function reverseRefund(db: D1Database, polarClient: Polar, id: string,
  event: any, cfg: RuntimeConfig): Promise<void> {
  const refund = event.data;
  const order = await polarClient.orders.get({ id: refund.orderId });
  const userId = order.customer?.externalId;
  const productCredits = order.productId ? cfg.productCredits.get(order.productId) : undefined;
  if (!userId || !productCredits) throw new Error('Refund has no mapped order or external customer');
  const lot = await db.prepare(
    'SELECT remaining_micros FROM credit_lots WHERE order_id = ? AND user_id = ?',
  ).bind(order.id, userId).first<{ remaining_micros: number }>();
  const wallet = await db.prepare('SELECT balance_micros FROM wallets WHERE user_id = ?')
    .bind(userId).first<{ balance_micros: number }>();
  const proportional = order.netAmount > 0
    ? Number((BigInt(productCredits) * BigInt(refund.amount)) / BigInt(order.netAmount))
    : productCredits;
  const reversal = Math.min(proportional, lot?.remaining_micros || 0, wallet?.balance_micros || 0);
  const isDispute = !!refund.dispute || refund.reason === 'dispute_prevention' || refund.reason === 'fraudulent';
  const now = Math.floor(event.timestamp.getTime() / 1000);
  const statements: D1PreparedStatement[] = [
    db.prepare('INSERT INTO processed_webhooks(event_id, event_type, processed_at) VALUES (?, ?, ?)')
      .bind(id, event.type, now),
  ];
  if (reversal > 0) {
    statements.push(
      db.prepare(
        `INSERT INTO ledger_entries
           (id, user_id, kind, amount_micros, idempotency_key, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), userId, isDispute ? 'dispute' : 'refund', -reversal,
        `refund:${refund.id}`, JSON.stringify({ refund_id: refund.id, order_id: order.id,
          requested_micros: proportional, clamped: reversal !== proportional }), now),
      db.prepare(
        `UPDATE wallets SET balance_micros = balance_micros - ?, frozen = CASE WHEN ? THEN 1 ELSE frozen END,
           updated_at = ? WHERE user_id = ?`,
      ).bind(reversal, isDispute ? 1 : 0, now, userId),
      db.prepare(
        'UPDATE credit_lots SET remaining_micros = remaining_micros - ? WHERE order_id = ? AND remaining_micros >= ?',
      ).bind(reversal, order.id, reversal),
    );
  } else if (isDispute) {
    statements.push(db.prepare('UPDATE wallets SET frozen = 1, updated_at = ? WHERE user_id = ?')
      .bind(now, userId));
  }
  await db.batch(statements);
}

export async function polarWebhook(request: Request, env: Env, cfg: RuntimeConfig): Promise<Response> {
  const raw = await request.text();
  let event: ReturnType<typeof validateEvent>;
  try {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { headers[name] = value; });
    event = validateEvent(raw, headers, env.POLAR_WEBHOOK_SECRET);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response('Invalid signature', { status: 403 });
    return new Response('Invalid webhook', { status: 400 });
  }
  const id = eventId(request.headers);
  if (!id) return new Response('Missing webhook id', { status: 400 });
  const polarClient = new Polar({ accessToken: env.POLAR_ACCESS_TOKEN, server: cfg.polarServer });
  const duplicate = await processVerifiedPolarEvent(env.DB, polarClient, id, event, cfg);
  return Response.json({ received: true, ...(duplicate ? { duplicate: true } : {}) });
}

export async function processVerifiedPolarEvent(db: D1Database, polarClient: Polar, id: string,
  event: any, cfg: RuntimeConfig): Promise<boolean> {
  if (await alreadyProcessed(db, id)) return true;
  try {
    if (event.type === 'order.paid') await grantOrder(db, id, event, cfg);
    else if (event.type === 'refund.created') await reverseRefund(db, polarClient, id, event, cfg);
    else {
      await db.prepare(
        'INSERT INTO processed_webhooks(event_id, event_type, processed_at) VALUES (?, ?, unixepoch())',
      ).bind(id, event.type).run();
    }
  } catch (error) {
    if (duplicateWebhook(error)) return true;
    throw error;
  }
  return false;
}
