/**
 * Token accounting for the shared-key proxy.
 *
 * Two instances of one Durable Object class do the whole job: one per client
 * IP over a 60-second window, and one named `global` over a 24-hour window.
 * The window length arrives with each request rather than being baked into the
 * class, so the same code serves both.
 *
 * The global instance additionally keeps the usage history behind `/stats`,
 * because every request already passes through it to be metered — the counters
 * are a free ride on calls that had to happen anyway. See "Usage stats" below
 * for how a visitor is counted without keeping anything that identifies them.
 *
 * A completion's token count is only known once its stream has finished, so a
 * request reserves an estimate up front and settles the difference afterwards.
 * The arithmetic is pure and exported so it can be tested without a Worker.
 */

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Fresh window state. */
const emptyWindow = (now) => ({ windowStart: now, used: 0 });

/**
 * Returns `state` if its window is still current, or a fresh window if it has
 * expired (or never existed).
 */
export function rollWindow(state, now, windowMs) {
  if (!state || !Number.isFinite(state.windowStart) || !Number.isFinite(state.used)) {
    return emptyWindow(now);
  }
  // A clock that moved backwards would otherwise hold a window open forever.
  if (now < state.windowStart) return emptyWindow(now);
  return now - state.windowStart >= windowMs ? emptyWindow(now) : state;
}

/**
 * Charges `estimate` against the window if it has any budget left.
 *
 * Deliberately admit-if-under-limit: a request is allowed whenever the window
 * is below its ceiling, even when its estimate would carry it past. A single
 * large turn can therefore overshoot rather than being refused outright, which
 * is the friendlier failure for a legitimate user and costs at most one
 * request's worth of tokens.
 */
export function applyReserve(state, { now, estimate, limit, windowMs }) {
  const rolled = rollWindow(state, now, windowMs);
  const resetIn = Math.max(0, Math.ceil((rolled.windowStart + windowMs - now) / 1000));
  if (rolled.used >= limit) {
    return {
      state: rolled,
      result: {
        ok: false,
        // Never zero: a client told to retry in 0 seconds retries immediately.
        retryAfter: Math.max(1, resetIn),
        limit,
        remaining: 0,
        resetIn,
        windowStart: rolled.windowStart,
      },
    };
  }
  const next = {
    windowStart: rolled.windowStart,
    used: rolled.used + Math.max(0, Math.round(estimate) || 0),
  };
  return {
    state: next,
    result: {
      ok: true,
      retryAfter: 0,
      limit,
      remaining: Math.max(0, limit - next.used),
      resetIn,
      windowStart: next.windowStart,
    },
  };
}

/**
 * Applies the difference between a reservation and what a completion actually
 * spent. `delta` is negative when the estimate was generous.
 *
 * The reservation's `windowStart` comes back with it: a settle that arrives
 * after its window has rolled belongs to a minute that is already over, and
 * must not be charged against — or refunded from — the new one.
 */
export function applySettle(state, { now, delta, windowStart, windowMs }) {
  const rolled = rollWindow(state, now, windowMs);
  if (rolled.windowStart !== windowStart) return rolled;
  return {
    windowStart: rolled.windowStart,
    used: Math.max(0, rolled.used + Math.round(delta || 0)),
  };
}

// ---------------------------------------------------------------------------
// Usage stats
// ---------------------------------------------------------------------------
//
// One record per UTC day, counting requests, turns, tokens, and how many
// distinct visitors there were.
//
// A visitor is counted as a **hash of their IP under a salt that is thrown away
// and regenerated every day**, so the day's distinct count is exact while the
// hashes are useless the moment the day is over: yesterday's cannot be matched
// against today's, and none of them can be walked back to an address, because
// the salt that produced them no longer exists anywhere. The raw IP is used to
// compute that hash and is never written to storage.

const DAY_PREFIX = 'day:';
const SALT_KEY = 'stats-salt';
/** Days of history to keep. Storage is cheap; unbounded key growth is not. */
const RETAIN_DAYS = 400;
/**
 * Ceiling on the hashes held for one day. Past it the day still counts every
 * request, and says its visitor count is a floor rather than silently lying.
 */
const MAX_VISITORS = 5000;

/** The UTC day a timestamp falls in, as `YYYY-MM-DD`. */
export const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

const hex = (bytes) =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Six bytes of a salted SHA-256. Enough that a collision within one day's
 * MAX_VISITORS is negligible, short enough that a busy day's set stays small.
 */
export async function visitorHash(ip, salt) {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hex(new Uint8Array(digest).slice(0, 6));
}

export const emptyDay = (day) => ({
  day,
  /** Upstream completions attempted. One turn is many of these. */
  requests: 0,
  /** Requests that began a turn — the closest thing to "things a human asked". */
  turns: 0,
  /** Requests refused by a rate limit. */
  refused: 0,
  /** Requests that reached no model, and were refunded. */
  failed: 0,
  /** Tokens charged, estimate included where no usage event arrived. */
  tokens: 0,
  visitors: [],
  /** True once `visitors` hit MAX_VISITORS, making the count a floor. */
  visitorsCapped: false,
});

/** Folds one request's contribution into a day record, in place. */
export function countRequest(record, { turn, refused, hash }) {
  record.requests += 1;
  if (turn) record.turns += 1;
  if (refused) record.refused += 1;
  if (hash && !record.visitors.includes(hash)) {
    if (record.visitors.length < MAX_VISITORS) record.visitors.push(hash);
    else record.visitorsCapped = true;
  }
  return record;
}

/** The shape `/stats` reports: counts only, never the hashes themselves. */
export const dayReport = (record) => ({
  day: record.day,
  requests: record.requests,
  turns: record.turns,
  refused: record.refused,
  failed: record.failed,
  tokens: record.tokens,
  visitors: record.visitors.length,
  visitors_capped: record.visitorsCapped,
});

const STATE_KEY = 'window';

/**
 * The Durable Object wrapper. Storage is the async API rather than the
 * SQLite-only synchronous one, so the class works on either backend; Durable
 * Object input gating already serializes concurrent requests to one instance,
 * so a read-modify-write across an await cannot interleave.
 */
export class TokenLimiter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /**
   * The day's salt, regenerated whenever the day turns over — which is also
   * when the retention window is pruned, so both happen once a day rather than
   * on every request.
   */
  async #saltFor(day) {
    const stored = await this.ctx.storage.get(SALT_KEY);
    if (stored && stored.day === day) return stored.value;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const value = hex(bytes);
    await this.ctx.storage.put(SALT_KEY, { day, value });
    await this.#prune(day);
    return value;
  }

  async #prune(day) {
    const cutoff = dayOf(Date.parse(`${day}T00:00:00Z`) - RETAIN_DAYS * DAY_MS);
    const stored = await this.ctx.storage.list({ prefix: DAY_PREFIX });
    const stale = [...stored.keys()].filter(key => key.slice(DAY_PREFIX.length) < cutoff);
    if (stale.length) await this.ctx.storage.delete(stale);
  }

  /** Folds one request into today's record, hashing the visitor under the day's salt. */
  async #count(now, payload, refused) {
    await this.#record(now, async (record, day) => {
      const hash = payload.ip
        ? await visitorHash(String(payload.ip), await this.#saltFor(day))
        : '';
      countRequest(record, { turn: !!payload.turn, refused, hash });
    });
  }

  /** Reads, folds and writes back one day record. */
  async #record(now, apply) {
    const day = dayOf(now);
    const key = DAY_PREFIX + day;
    const record = (await this.ctx.storage.get(key)) || emptyDay(day);
    await apply(record, day);
    await this.ctx.storage.put(key, record);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/stats') {
      const limit = Number(new URL(request.url).searchParams.get('days')) || 30;
      const stored = await this.ctx.storage.list({ prefix: DAY_PREFIX, reverse: true, limit });
      return Response.json({ days: [...stored.values()].map(dayReport) });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: 'invalid limiter payload' }, { status: 400 });
    }
    const now = Date.now();
    const windowMs = Number(payload.windowMs) || MINUTE_MS;
    const state = await this.ctx.storage.get(STATE_KEY);

    if (url.pathname === '/reserve') {
      const { state: next, result } = applyReserve(state, {
        now,
        estimate: Number(payload.estimate) || 0,
        limit: Number(payload.limit) || 0,
        windowMs,
      });
      await this.ctx.storage.put(STATE_KEY, next);
      // Only the global instance keeps the history; a per-IP one would hold a
      // near-duplicate copy of it for nothing.
      if (payload.stats) await this.#count(now, payload, !result.ok);
      return Response.json(result);
    }

    // Recording with no reservation, for a request refused by the *per-IP*
    // window — which never reaches the reserve above, and would otherwise be
    // the one outcome the history could not see.
    if (url.pathname === '/count') {
      await this.#count(now, payload, !!payload.refused);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/settle') {
      const next = applySettle(state, {
        now,
        delta: Number(payload.delta) || 0,
        windowStart: Number(payload.windowStart),
        windowMs,
      });
      await this.ctx.storage.put(STATE_KEY, next);
      if (payload.stats) {
        await this.#record(now, (record) => {
          record.tokens += Math.max(0, Math.round(Number(payload.spent) || 0));
          if (payload.failed) record.failed += 1;
        });
      }
      return Response.json({ ok: true, used: next.used });
    }

    return Response.json({ error: 'unknown limiter route' }, { status: 404 });
  }
}
