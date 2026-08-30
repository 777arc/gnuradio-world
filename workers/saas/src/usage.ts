const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export class UsageQueryError extends Error {}

interface UsageCursor {
  createdAt: number;
  id: string | null;
}

function safeTimestamp(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseUsagePage(limitValue?: string, beforeValue?: string): {
  limit: number;
  cursor: UsageCursor | null;
} {
  let limit = DEFAULT_LIMIT;
  if (limitValue !== undefined) {
    if (!/^[1-9]\d*$/.test(limitValue) || !Number.isSafeInteger(Number(limitValue))) {
      throw new UsageQueryError('limit must be a positive integer');
    }
    limit = Math.min(MAX_LIMIT, Number(limitValue));
  }

  if (beforeValue === undefined) return { limit, cursor: null };
  const separator = beforeValue.indexOf(':');
  if (separator < 0) {
    const createdAt = safeTimestamp(beforeValue);
    if (createdAt === null) throw new UsageQueryError('before is not a valid cursor');
    // Accept the old timestamp-only cursor for compatibility. Responses use a
    // stable timestamp/id cursor, so subsequent pages cannot skip ties.
    return { limit, cursor: { createdAt, id: null } };
  }
  const createdAt = safeTimestamp(beforeValue.slice(0, separator));
  const id = beforeValue.slice(separator + 1);
  if (createdAt === null || !id) throw new UsageQueryError('before is not a valid cursor');
  return { limit, cursor: { createdAt, id } };
}

export function usageCursor(entry: Record<string, unknown>): string {
  const createdAt = Number(entry.created_at);
  const id = String(entry.id ?? '');
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !id) {
    throw new Error('ledger entry cannot be used as a cursor');
  }
  return `${createdAt}:${id}`;
}

export async function readUsagePage(db: D1Database, userId: string,
                                    limitValue?: string, beforeValue?: string): Promise<{
  entries: Record<string, unknown>[];
  next_before: string | null;
}> {
  const { limit, cursor } = parseUsagePage(limitValue, beforeValue);
  const columns = `id, kind, amount_micros, request_id, model, rate_version_id,
    input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
    exact, metadata, created_at`;
  let statement;
  if (!cursor) {
    statement = db.prepare(
      `SELECT ${columns} FROM ledger_entries WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(userId, limit + 1);
  } else if (cursor.id === null) {
    // A timestamp-only cursor can only have come from the old API. Include its
    // boundary once (possibly duplicating the last old page) so upgrading a
    // client in flight cannot permanently skip the rest of a tied timestamp.
    statement = db.prepare(
      `SELECT ${columns} FROM ledger_entries WHERE user_id = ? AND created_at <= ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(userId, cursor.createdAt, limit + 1);
  } else {
    statement = db.prepare(
      `SELECT ${columns} FROM ledger_entries
       WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(userId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1);
  }
  const rows = await statement.all<Record<string, unknown>>();
  const entries = rows.results.slice(0, limit);
  return {
    entries,
    next_before: rows.results.length > limit ? usageCursor(entries[entries.length - 1]) : null,
  };
}
