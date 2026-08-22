/**
 * Token accounting for the shared-key proxy.
 *
 * Two instances of one Durable Object class do the whole job: one per client
 * IP over a 60-second window, and one named `global` over a 24-hour window.
 * The window length arrives with each request rather than being baked into the
 * class, so the same code serves both.
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

  async fetch(request) {
    const url = new URL(request.url);
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
      return Response.json(result);
    }

    if (url.pathname === '/settle') {
      const next = applySettle(state, {
        now,
        delta: Number(payload.delta) || 0,
        windowStart: Number(payload.windowStart),
        windowMs,
      });
      await this.ctx.storage.put(STATE_KEY, next);
      return Response.json({ ok: true, used: next.used });
    }

    return Response.json({ error: 'unknown limiter route' }, { status: 404 });
  }
}
