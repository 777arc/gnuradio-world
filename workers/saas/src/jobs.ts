import { Polar } from '@polar-sh/sdk';
import type { Env, RuntimeConfig } from './env';
import { absorbAndRelease, holdFromRow } from './ledger';
import { priceUsage } from './pricing';

type JsonRecord = Record<string, unknown>;

async function emit(url: string | undefined, payload: JsonRecord): Promise<void> {
  if (!url) return;
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Notification endpoint failed (${response.status})`);
}

export async function reapExpiredHolds(env: Env, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT * FROM holds WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at LIMIT 500",
  ).bind(now).all<Record<string, unknown>>();
  let count = 0;
  for (const row of rows.results) {
    const hold = await holdFromRow(env.DB, row);
    const estimatedCharge = priceUsage(hold.rate, {
      inputTokens: hold.inputTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: hold.inputTokens,
      outputTokens: hold.maxOutputTokens,
    });
    await absorbAndRelease(env.DB, hold, {
      reason: 'reaped_unknown', exact: false, charge: estimatedCharge,
      metadata: { expired_at: hold.expiresAt, reaped_at: now },
    });
    count++;
  }
  console.log(JSON.stringify({ metric: 'holds_reaped', count, at: now }));
  return count;
}

async function expireCredits(env: Env, now: number): Promise<number> {
  // Do not expire a lot underneath an active request; it will be picked up on
  // the next daily run after its hold settles or the minute reaper releases it.
  const rows = await env.DB.prepare(
    `SELECT l.id, l.user_id, l.remaining_micros
     FROM credit_lots l JOIN wallets w ON w.user_id = l.user_id
     WHERE l.remaining_micros > 0 AND l.expires_at <= ? AND w.held_micros = 0
     ORDER BY l.expires_at LIMIT 1000`,
  ).bind(now).all<{ id: string; user_id: string; remaining_micros: number }>();
  let count = 0;
  for (const lot of rows.results) {
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ledger_entries
             (id, user_id, kind, amount_micros, idempotency_key, metadata, created_at)
           SELECT ?, ?, 'expiry', -remaining_micros, ?, ?, ? FROM credit_lots
           WHERE id = ? AND remaining_micros > 0`,
        ).bind(crypto.randomUUID(), lot.user_id, `expiry:${lot.id}`,
          JSON.stringify({ credit_lot_id: lot.id }), now, lot.id),
        env.DB.prepare(
          `UPDATE wallets SET balance_micros = balance_micros -
             (SELECT remaining_micros FROM credit_lots WHERE id = ?), updated_at = ?
           WHERE user_id = ?`,
        ).bind(lot.id, now, lot.user_id),
        env.DB.prepare('UPDATE credit_lots SET remaining_micros = 0 WHERE id = ?')
          .bind(lot.id),
      ]);
      count++;
    } catch (error) {
      if (!(error instanceof Error && /idempotency_key/i.test(error.message))) throw error;
    }
  }
  return count;
}

async function sendLowBalanceEmails(env: Env, now: number): Promise<number> {
  if (!env.EMAIL_WEBHOOK_URL) return 0;
  const rows = await env.DB.prepare(
    `SELECT w.user_id, u.email, w.balance_micros - w.held_micros AS available,
            w.last_purchase_micros, w.low_balance_notice
     FROM wallets w JOIN "user" u ON u.id = w.user_id
     WHERE w.last_purchase_micros IS NOT NULL AND w.frozen = 0
       AND (w.balance_micros - w.held_micros) * 100 <= w.last_purchase_micros * 20`,
  ).all<{ user_id: string; email: string; available: number;
    last_purchase_micros: number; low_balance_notice: number }>();
  let sent = 0;
  for (const row of rows.results) {
    const threshold = row.available * 100 <= row.last_purchase_micros * 5 ? 5 : 20;
    if (row.low_balance_notice !== 0 && row.low_balance_notice <= threshold) continue;
    await emit(env.EMAIL_WEBHOOK_URL, {
      type: 'low_balance', email: row.email, user_id: row.user_id,
      threshold_percent: threshold, available_micros: row.available,
    });
    await env.DB.prepare('UPDATE wallets SET low_balance_notice = ?, updated_at = ? WHERE user_id = ?')
      .bind(threshold, now, row.user_id).run();
    sent++;
  }
  return sent;
}

async function polarPaidOrderIds(env: Env, cfg: RuntimeConfig, start: number, end: number): Promise<Set<string>> {
  const polar = new Polar({ accessToken: env.POLAR_ACCESS_TOKEN, server: cfg.polarServer });
  const ids = new Set<string>();
  // Polar's list API has no date filter. Walk newest-first and stop once the
  // page is older than the reconciliation window.
  const pages = await polar.orders.list({ limit: 100, sorting: ['-created_at'] });
  for await (const page of pages) {
    let older = false;
    for (const order of page.result.items) {
      const created = Math.floor(order.createdAt.getTime() / 1000);
      if (created < start) { older = true; continue; }
      if (created < end && order.paid && order.productId && cfg.productCredits.has(order.productId)) {
        ids.add(order.id);
      }
    }
    if (older) break;
  }
  return ids;
}

export async function reconcile(env: Env, cfg: RuntimeConfig,
  now = Math.floor(Date.now() / 1000)): Promise<JsonRecord> {
  const end = Math.floor(now / 86_400) * 86_400;
  const start = end - 86_400;
  const [balance, held, localOrders, absorbed, settled, revenue] = await Promise.all([
    env.DB.prepare(
      `SELECT w.user_id, w.balance_micros, COALESCE(SUM(l.amount_micros), 0) ledger_balance
       FROM wallets w LEFT JOIN ledger_entries l ON l.user_id = w.user_id
       GROUP BY w.user_id HAVING w.balance_micros != ledger_balance`,
    ).all(),
    env.DB.prepare(
      `SELECT w.user_id, w.held_micros, COALESCE(SUM(h.amount_micros), 0) active_holds
       FROM wallets w LEFT JOIN holds h ON h.user_id = w.user_id AND h.status = 'active'
       GROUP BY w.user_id HAVING w.held_micros != active_holds`,
    ).all(),
    env.DB.prepare(
      `SELECT json_extract(metadata, '$.order_id') order_id FROM ledger_entries
       WHERE kind = 'purchase' AND created_at >= ? AND created_at < ?`,
    ).bind(start, end).all<{ order_id: string }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(wholesale_micros), 0) total,
              COALESCE(SUM(CASE WHEN exact = 1 THEN wholesale_micros ELSE 0 END), 0) exact,
              COALESCE(SUM(CASE WHEN exact = 0 THEN wholesale_micros ELSE 0 END), 0) estimated,
              COALESCE(SUM(forgone_retail_micros), 0) forgone
       FROM absorbed_costs WHERE created_at >= ? AND created_at < ?`,
    ).bind(start, end).first<Record<string, number>>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(wholesale_micros), 0) wholesale
       FROM ledger_entries WHERE kind = 'usage' AND created_at >= ? AND created_at < ?`,
    ).bind(start, end).first<{ wholesale: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(-SUM(amount_micros), 0) retail
       FROM ledger_entries WHERE kind = 'usage' AND created_at >= ? AND created_at < ?`,
    ).bind(start, end).first<{ retail: number }>(),
  ]);

  let polarMismatch: JsonRecord = { skipped: false, missing_local: [], missing_polar: [] };
  try {
    const polarIds = await polarPaidOrderIds(env, cfg, start, end);
    const localIds = new Set(localOrders.results.map(row => row.order_id).filter(Boolean));
    polarMismatch = {
      skipped: false,
      missing_local: [...polarIds].filter(id => !localIds.has(id)),
      missing_polar: [...localIds].filter(id => !polarIds.has(id)),
    };
  } catch (error) {
    polarMismatch = { skipped: true, error: error instanceof Error ? error.name : 'unknown' };
  }

  let providerSpend: number | null = null;
  if (env.PROVIDER_SPEND_URL && env.PROVIDER_SPEND_TOKEN) {
    const response = await fetch(`${env.PROVIDER_SPEND_URL}?start=${start}&end=${end}`, {
      headers: { Authorization: `Bearer ${env.PROVIDER_SPEND_TOKEN}` },
    });
    if (response.ok) {
      const payload = await response.json<{ spend_micros?: unknown }>();
      const value = Number(payload.spend_micros);
      if (Number.isSafeInteger(value) && value >= 0) providerSpend = value;
    }
  }
  const absorbedTotal = Number(absorbed?.total || 0);
  const settledWholesale = Number(settled?.wholesale || 0);
  const residual = providerSpend === null ? null : providerSpend - settledWholesale - absorbedTotal;
  const retail = Number(revenue?.retail || 0);
  const absorbedBps = retail > 0 ? Number((BigInt(absorbedTotal) * 10_000n) / BigInt(retail)) : 0;

  const topUsers = await env.DB.prepare(
    `SELECT a.user_id, SUM(a.wholesale_micros) absorbed_micros,
       COALESCE((SELECT -SUM(l.amount_micros) FROM ledger_entries l
                 WHERE l.user_id = a.user_id AND l.kind = 'usage'
                   AND l.created_at >= ? AND l.created_at < ?), 0) billed_micros
     FROM absorbed_costs a WHERE a.created_at >= ? AND a.created_at < ?
     GROUP BY a.user_id ORDER BY absorbed_micros DESC LIMIT 20`,
  ).bind(start, end, start, end).all();
  const breakdown = await env.DB.prepare(
    `SELECT reason, model, provider, exact, COUNT(*) requests,
            SUM(wholesale_micros) wholesale_micros, SUM(forgone_retail_micros) forgone_retail_micros
     FROM absorbed_costs WHERE created_at >= ? AND created_at < ?
     GROUP BY reason, model, provider, exact ORDER BY wholesale_micros DESC`,
  ).bind(start, end).all();

  const report: JsonRecord = {
    type: 'daily_reconciliation', start, end,
    balance_mismatches: balance.results,
    hold_mismatches: held.results,
    polar_orders: polarMismatch,
    absorbed: {
      wholesale_micros: absorbedTotal,
      forgone_retail_micros: Number(absorbed?.forgone || 0),
      exact_micros: Number(absorbed?.exact || 0),
      estimated_micros: Number(absorbed?.estimated || 0),
      percent_of_revenue_bps: absorbedBps,
      breakdown: breakdown.results,
      top_users: topUsers.results,
    },
    absorbed_identity: {
      provider_spend_micros: providerSpend,
      settled_wholesale_micros: settledWholesale,
      absorbed_wholesale_micros: absorbedTotal,
      residual_micros: residual,
      skipped: providerSpend === null,
    },
  };
  const loud = balance.results.length > 0 || held.results.length > 0 ||
    (Array.isArray(polarMismatch.missing_local) && polarMismatch.missing_local.length > 0) ||
    (Array.isArray(polarMismatch.missing_polar) && polarMismatch.missing_polar.length > 0) ||
    (residual !== null && Math.abs(residual) > 10) || absorbedBps >= cfg.absorbedAlertBps;
  console[loud ? 'error' : 'log'](JSON.stringify(report));
  if (loud) await emit(env.ALERT_WEBHOOK_URL, report);
  return report;
}

export async function dailyJobs(env: Env, cfg: RuntimeConfig,
  now = Math.floor(Date.now() / 1000)): Promise<void> {
  const expired = await expireCredits(env, now);
  const lowBalanceEmails = await sendLowBalanceEmails(env, now);
  const report = await reconcile(env, cfg, now);
  console.log(JSON.stringify({ metric: 'daily_jobs', expired, low_balance_emails: lowBalanceEmails,
    reconciliation_type: report.type }));
}
