import type { Charge, ModelRate, TokenUsage } from './pricing';
import { estimateHold, priceUsage, rateFromRow } from './pricing';

export interface Hold {
  id: string;
  requestId: string;
  userId: string;
  model: string;
  rate: ModelRate;
  amountMicros: number;
  inputTokens: number;
  maxOutputTokens: number;
  expiresAt: number;
}

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient credits');
    this.name = 'InsufficientFundsError';
  }
}

export class FrozenWalletError extends Error {
  constructor() {
    super('This account is frozen');
    this.name = 'FrozenWalletError';
  }
}

export async function activeRate(db: D1Database, model: string, now = Math.floor(Date.now() / 1000)):
Promise<ModelRate | null> {
  const row = await db.prepare(
    `SELECT * FROM model_rates
     WHERE model = ? AND effective_at <= ? AND (ends_at IS NULL OR ends_at > ?)
     ORDER BY effective_at DESC LIMIT 1`,
  ).bind(model, now, now).first<Record<string, unknown>>();
  return row ? rateFromRow(row) : null;
}

/**
 * Race-free reservation. The balance decision is the conditional UPDATE; no
 * SELECT-then-branch can admit two requests against the same available funds.
 */
export async function reserve(db: D1Database, options: {
  userId: string;
  requestId: string;
  model: string;
  rate: ModelRate;
  inputTokens: number;
  maxOutputTokens: number;
  holdTtlSeconds: number;
  now?: number;
}): Promise<Hold> {
  const amountMicros = estimateHold(options.rate, options.inputTokens, options.maxOutputTokens);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const hold: Hold = {
    id: crypto.randomUUID(),
    requestId: options.requestId,
    userId: options.userId,
    model: options.model,
    rate: options.rate,
    amountMicros,
    inputTokens: options.inputTokens,
    maxOutputTokens: options.maxOutputTokens,
    expiresAt: now + options.holdTtlSeconds,
  };

  // Both statements are one D1 transaction. The insert only materializes when
  // the wallet can afford the reservation; the single conditional UPDATE then
  // increments held money only when that exact hold exists. An isolate cannot
  // die between the two and strand a wallet-only reservation.
  const [inserted, updated] = await db.batch([
    db.prepare(
      `INSERT INTO holds
         (id, user_id, request_id, model, rate_version_id, amount_micros,
          input_tokens, max_output_tokens, status, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM wallets WHERE user_id = ? AND frozen = 0
           AND balance_micros - held_micros >= ?
       )`,
    ).bind(hold.id, hold.userId, hold.requestId, hold.model, hold.rate.id,
      hold.amountMicros, hold.inputTokens, hold.maxOutputTokens, hold.expiresAt,
      now, hold.userId, hold.amountMicros),
    db.prepare(
      `UPDATE wallets SET held_micros = held_micros + ?, updated_at = ?
       WHERE user_id = ? AND frozen = 0 AND balance_micros - held_micros >= ?
         AND EXISTS (SELECT 1 FROM holds WHERE id = ? AND status = 'active')`,
    ).bind(amountMicros, now, options.userId, amountMicros, hold.id),
  ]);
  if (inserted.meta.changes !== 1 || updated.meta.changes !== 1) {
    const wallet = await db.prepare('SELECT frozen FROM wallets WHERE user_id = ?')
      .bind(options.userId).first<{ frozen: number }>();
    if (wallet?.frozen) throw new FrozenWalletError();
    throw new InsufficientFundsError();
  }
  return hold;
}

const consumeLots = (hold: Hold, debitMicros: number) => ({
  sql: `WITH ordered AS (
          SELECT id, remaining_micros,
            COALESCE(SUM(remaining_micros) OVER (
              ORDER BY expires_at, created_at, id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior
          FROM credit_lots WHERE user_id = ? AND remaining_micros > 0
        )
        UPDATE credit_lots SET remaining_micros = CASE
          WHEN ? <= (SELECT prior FROM ordered WHERE ordered.id = credit_lots.id)
            THEN remaining_micros
          WHEN ? >= (SELECT prior + remaining_micros FROM ordered WHERE ordered.id = credit_lots.id)
            THEN 0
          ELSE (SELECT prior + remaining_micros FROM ordered WHERE ordered.id = credit_lots.id) - ?
        END
        WHERE id IN (SELECT id FROM ordered)
          AND EXISTS (SELECT 1 FROM holds WHERE id = ? AND status = 'active')`,
  values: [hold.userId, debitMicros, debitMicros, debitMicros, hold.id],
});

/** One atomic and retry-safe settlement batch. */
export async function settle(db: D1Database, hold: Hold, usage: TokenUsage, exact = true): Promise<void> {
  const charge = priceUsage(hold.rate, usage);
  const lots = consumeLots(hold, charge.retailMicros);
  const now = Math.floor(Date.now() / 1000);
  const metadata = JSON.stringify({
    hold_micros: hold.amountMicros,
    max_output_tokens: hold.maxOutputTokens,
  });
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO ledger_entries
         (id, user_id, kind, amount_micros, idempotency_key, request_id, model,
          rate_version_id, input_tokens, cached_input_tokens, output_tokens,
          cache_write_tokens, wholesale_micros, exact, metadata, created_at)
       SELECT ?, ?, 'usage', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM holds WHERE id = ? AND status = 'active')`,
    ).bind(crypto.randomUUID(), hold.userId, -charge.retailMicros,
      `usage:${hold.requestId}`, hold.requestId, hold.model, hold.rate.id,
      usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.cacheWriteTokens,
      charge.wholesaleMicros, exact ? 1 : 0, metadata, now, hold.id),
    db.prepare(lots.sql).bind(...lots.values),
    // low_balance_notice is deliberately NOT cleared here. It records which
    // threshold a user has already been emailed about, and only a purchase
    // (webhooks.ts) makes that stale. Clearing it on spend re-armed the notice
    // on every settled request, so a user sitting below the threshold was
    // emailed again on every run of the daily job instead of once.
    db.prepare(
      `UPDATE wallets
       SET balance_micros = balance_micros - ?, held_micros = held_micros - ?,
           updated_at = ?
       WHERE user_id = ? AND EXISTS
         (SELECT 1 FROM holds WHERE id = ? AND status = 'active')`,
    ).bind(charge.retailMicros, hold.amountMicros, now, hold.userId, hold.id),
    db.prepare(
      `UPDATE holds SET status = 'settled', settled_at = ?
       WHERE id = ? AND status = 'active'`,
    ).bind(now, hold.id),
  ]);
}

/** Release before any generation occurred; there is deliberately no absorption. */
export async function releaseUnused(db: D1Database, hold: Hold): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare(
      `UPDATE wallets SET held_micros = held_micros - ?, updated_at = ?
       WHERE user_id = ? AND EXISTS
         (SELECT 1 FROM holds WHERE id = ? AND status = 'active')`,
    ).bind(hold.amountMicros, now, hold.userId, hold.id),
    db.prepare("UPDATE holds SET status = 'released', settled_at = ? WHERE id = ? AND status = 'active'")
      .bind(now, hold.id),
  ]);
}

export type AbsorbedReason = 'upstream_error' | 'client_abort' | 'settle_failed' | 'reaped_unknown';

/** Record operator-paid inference and release the user's complete hold atomically. */
export async function absorbAndRelease(db: D1Database, hold: Hold, options: {
  reason: AbsorbedReason;
  usage?: TokenUsage;
  charge?: Charge;
  exact: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const charge = options.charge || (options.usage ? priceUsage(hold.rate, options.usage) : {
    wholesaleMicros: 0,
    retailMicros: 0,
  });
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO absorbed_costs
         (id, user_id, request_id, model, provider, rate_version_id,
          wholesale_micros, forgone_retail_micros, reason, exact,
          input_tokens, cached_input_tokens, output_tokens, cache_write_tokens, metadata, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM holds WHERE id = ? AND status = 'active')`,
    ).bind(crypto.randomUUID(), hold.userId, hold.requestId, hold.model,
      hold.rate.provider, hold.rate.id, charge.wholesaleMicros, charge.retailMicros,
      options.reason, options.exact ? 1 : 0, options.usage?.inputTokens ?? null,
      options.usage?.cachedInputTokens ?? null, options.usage?.outputTokens ?? null,
      options.usage?.cacheWriteTokens ?? null,
      JSON.stringify(options.metadata || {}), now, hold.id),
    db.prepare(
      `UPDATE wallets SET held_micros = held_micros - ?, updated_at = ?
       WHERE user_id = ? AND EXISTS
         (SELECT 1 FROM holds WHERE id = ? AND status = 'active')`,
    ).bind(hold.amountMicros, now, hold.userId, hold.id),
    db.prepare("UPDATE holds SET status = 'released', settled_at = ? WHERE id = ? AND status = 'active'")
      .bind(now, hold.id),
  ]);
}

export async function holdFromRow(db: D1Database, row: Record<string, unknown>): Promise<Hold> {
  const rate = await db.prepare('SELECT * FROM model_rates WHERE id = ?')
    .bind(String(row.rate_version_id)).first<Record<string, unknown>>();
  if (!rate) throw new Error(`Missing rate version ${String(row.rate_version_id)}`);
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    userId: String(row.user_id),
    model: String(row.model),
    rate: rateFromRow(rate),
    amountMicros: Number(row.amount_micros),
    inputTokens: Number(row.input_tokens),
    maxOutputTokens: Number(row.max_output_tokens),
    expiresAt: Number(row.expires_at),
  };
}
