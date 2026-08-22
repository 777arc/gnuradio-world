/**
 * Flowgraph Copilot's shared-key proxy.
 *
 * The editor's third AI provider ("GNU Radio World") has no API key of its own.
 * It talks to this Worker, which holds one OpenAI key for everybody and meters
 * it: 1,000,000 tokens per minute per client IP, under a global daily ceiling.
 *
 * Nothing here is a passthrough. The upstream request body is rebuilt from a
 * whitelist, so a caller cannot select a different model, suppress the usage
 * reporting the metering depends on, or attach account-level fields. The key
 * never leaves the Worker and upstream error bodies — which can name the
 * organization — are never returned verbatim.
 *
 * See ../README.md for deployment and tunables, and ../../docs/ai-copilot.md
 * for how the editor uses it.
 */
import { TokenLimiter, MINUTE_MS, DAY_MS } from './limiter.js';

export { TokenLimiter };

// The account's own API, reached with the shared key held in a Worker secret.
const OPENAI_COMPLETIONS = 'https://api.openai.com/v1/chat/completions';

export const DEFAULTS = {
  /** The only model the shared key may be used with. */
  model: 'gpt-5.4-mini',
  tokensPerMinute: 1_000_000,
  dailyTokenCap: 5_000_000,
  maxBodyBytes: 1_048_576,
  /** Ceiling on one completion, reasoning included. Bounds the output bill. */
  maxCompletionTokens: 16_384,
  /** Assumed output when reserving, before the real count is known. */
  outputEstimate: 2_000,
  maxMessages: 600,
  maxTools: 64,
  /**
   * Every conversation here shares the same system prefix — the prompt plus
   * the runnable block index — so one cache key for all callers keeps that
   * prefix warm on a single upstream machine instead of paying to establish it
   * per user. Split this per client only if the traffic ever outgrows what one
   * cache key is documented to carry.
   */
  cacheKey: 'grw-shared',
};

/** Reads the tunables, all of which are plain `vars` in wrangler.jsonc. */
export function config(env = {}) {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    model: env.MODEL || DEFAULTS.model,
    tokensPerMinute: number(env.TOKENS_PER_MINUTE, DEFAULTS.tokensPerMinute),
    dailyTokenCap: number(env.DAILY_TOKEN_CAP, DEFAULTS.dailyTokenCap),
    maxBodyBytes: number(env.MAX_BODY_BYTES, DEFAULTS.maxBodyBytes),
    maxCompletionTokens: number(env.MAX_COMPLETION_TOKENS, DEFAULTS.maxCompletionTokens),
    outputEstimate: number(env.OUTPUT_ESTIMATE, DEFAULTS.outputEstimate),
    maxMessages: DEFAULTS.maxMessages,
    maxTools: DEFAULTS.maxTools,
    cacheKey: env.CACHE_KEY || DEFAULTS.cacheKey,
  };
}

// The same origins scripts/r2-cors.json allows for the recording bucket, plus
// any local port so the repository dev server works unconfigured. This is not a
// security boundary — Origin is trivially forged outside a browser — it only
// keeps another site's page from spending this key. The real floor is the
// per-IP limit, the daily cap, and a spend limit on the key itself.
const ALLOWED_ORIGINS = [
  'https://gnuradioworld.com',
  'https://www.gnuradioworld.com',
  'https://gnuradio-wasm.pages.dev',
  '*.gnuradio-world-previews.pages.dev',
];

export function originAllowed(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
  if (url.protocol !== 'https:') return false;
  // A leading `*.` matches subdomains only; the bare domain is not implied.
  return ALLOWED_ORIGINS.some(allowed => allowed.startsWith('*.')
    ? url.hostname.endsWith(allowed.slice(1))
    : origin === allowed);
}

const RATE_HEADERS = [
  'X-RateLimit-Limit-Tokens',
  'X-RateLimit-Remaining-Tokens',
  'X-RateLimit-Reset-Seconds',
];

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // A JSON POST is preflighted; without this every completion costs two
    // Worker requests instead of one.
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': RATE_HEADERS.join(', '),
    Vary: 'Origin',
  };
}

const json = (payload, status, origin, extra = {}) => Response.json(payload, {
  status,
  headers: {
    ...(origin ? corsHeaders(origin) : {}),
    'Cache-Control': 'no-store',
    ...extra,
  },
});

/** An OpenAI-shaped error, so the editor's existing parser reads the message. */
const errorBody = (message, type) => ({ error: { message, type } });

/**
 * Rebuilds the upstream request from a whitelist.
 *
 * Everything the caller sends that is not named here is dropped, and the three
 * fields the metering depends on — the model, streaming, and usage reporting —
 * are set rather than accepted.
 */
export function sanitizeBody(raw, cfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, message: 'Request body must be a JSON object.' };
  }
  if (raw.model !== undefined && raw.model !== cfg.model) {
    return {
      ok: false,
      status: 400,
      message: `The shared GNU Radio World key is limited to ${cfg.model}. ` +
        'Connect your own OpenAI or OpenRouter key to use another model.',
    };
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return { ok: false, status: 400, message: 'Request body needs a non-empty messages array.' };
  }
  if (raw.messages.length > cfg.maxMessages) {
    return {
      ok: false,
      status: 400,
      message: `Conversation is too long (${raw.messages.length} messages). Start a new chat.`,
    };
  }
  for (const message of raw.messages) {
    if (!message || typeof message !== 'object' || typeof message.role !== 'string') {
      return { ok: false, status: 400, message: 'Every message needs a role.' };
    }
  }
  if (raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.length > cfg.maxTools)) {
    return { ok: false, status: 400, message: 'Invalid tools array.' };
  }

  return {
    ok: true,
    body: {
      model: cfg.model,
      messages: raw.messages,
      ...(raw.tools ? { tools: raw.tools } : {}),
      ...(raw.tool_choice ? { tool_choice: raw.tool_choice } : {}),
      stream: true,
      // Not negotiable: the token count in this event is what the limiter
      // settles against.
      stream_options: { include_usage: true },
      max_completion_tokens: cfg.maxCompletionTokens,
      prompt_cache_key: cfg.cacheKey,
    },
  };
}

/**
 * What to charge before the real count arrives. Four bytes per token is the
 * usual rough figure for English and JSON alike, and the estimate is settled
 * against the truth as soon as the stream ends.
 */
export const estimateTokens = (byteLength, cfg) =>
  Math.ceil(byteLength / 4) + cfg.outputEstimate;

/**
 * Pulls `usage.total_tokens` out of a server-sent event stream as it passes.
 *
 * Fed decoded text in whatever pieces the network delivers, so a partial last
 * line is held back rather than parsed. Only lines that mention usage are
 * parsed at all — a completion's content deltas are the overwhelming majority
 * of lines and none of them matter here.
 */
export class UsageScanner {
  constructor() {
    this.pending = '';
    this.total = 0;
    this.seen = false;
  }

  push(text) {
    this.pending += text;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  end() {
    if (this.pending) this.line(this.pending);
    this.pending = '';
  }

  line(line) {
    if (!line.startsWith('data:') || !line.includes('"usage"')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(value);
    } catch {
      return;
    }
    const total = Number(chunk?.usage?.total_tokens);
    if (Number.isFinite(total) && total > 0) {
      this.total = total;
      this.seen = true;
    }
  }
}

const limiterCall = async (stub, path, payload) => {
  const response = await stub.fetch(`https://limiter${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
};

const modelList = (cfg) => ({
  object: 'list',
  data: [{ id: cfg.model, object: 'model', created: 0, owned_by: 'gnuradio-world' }],
});

const rateHeaders = (reserve) => ({
  'X-RateLimit-Limit-Tokens': String(reserve.limit),
  'X-RateLimit-Remaining-Tokens': String(reserve.remaining),
  'X-RateLimit-Reset-Seconds': String(reserve.resetIn),
});

async function handleCompletion(request, env, ctx, origin, cfg) {
  const raw = await request.text();
  if (raw.length > cfg.maxBodyBytes) {
    return json(errorBody(
      'Request is too large for the shared model. Start a new chat, or connect your own key.',
      'request_too_large',
    ), 413, origin);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(errorBody('Request body is not valid JSON.', 'invalid_request_error'), 400, origin);
  }
  const sanitized = sanitizeBody(parsed, cfg);
  if (!sanitized.ok) {
    return json(errorBody(sanitized.message, 'invalid_request_error'), sanitized.status, origin);
  }

  if (!env.OPENAI_API_KEY) {
    return json(errorBody(
      'The shared model is not configured on this deployment.',
      'server_error',
    ), 503, origin);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const estimate = estimateTokens(raw.length, cfg);
  const perIp = env.LIMITER.get(env.LIMITER.idFromName(`ip:${ip}`));
  const global = env.LIMITER.get(env.LIMITER.idFromName('global'));

  const ipWindow = { limit: cfg.tokensPerMinute, windowMs: MINUTE_MS };
  const dayWindow = { limit: cfg.dailyTokenCap, windowMs: DAY_MS };

  const ipReserve = await limiterCall(perIp, '/reserve', { estimate, ...ipWindow });
  if (!ipReserve.ok) {
    return json(errorBody(
      `The shared model's per-visitor limit is used up. Try again in ${ipReserve.retryAfter}s, ` +
      'or connect your own OpenRouter or OpenAI key for higher limits.',
      'rate_limit_exceeded',
    ), 429, origin, {
      'Retry-After': String(ipReserve.retryAfter),
      ...rateHeaders(ipReserve),
    });
  }

  const dayReserve = await limiterCall(global, '/reserve', { estimate, ...dayWindow });
  if (!dayReserve.ok) {
    // Give the per-IP window its estimate back; nothing was spent upstream.
    ctx.waitUntil(limiterCall(perIp, '/settle', {
      delta: -estimate, windowStart: ipReserve.windowStart, ...ipWindow,
    }));
    return json(errorBody(
      "The shared model's daily budget for all visitors is used up. It resets in " +
      `${Math.ceil(dayReserve.retryAfter / 3600)}h — connect your own OpenRouter or OpenAI key ` +
      'to keep working now.',
      'rate_limit_exceeded',
    ), 429, origin, {
      'Retry-After': String(dayReserve.retryAfter),
      ...rateHeaders(ipReserve),
    });
  }

  const adjust = (delta) => (delta ? Promise.all([
    limiterCall(perIp, '/settle', { delta, windowStart: ipReserve.windowStart, ...ipWindow }),
    limiterCall(global, '/settle', { delta, windowStart: dayReserve.windowStart, ...dayWindow }),
  ]) : Promise.resolve());

  /**
   * Charges the difference between the estimate and the truth, on both windows.
   * A stream that ended without a usage event — an aborted read, most often —
   * keeps its estimate rather than being refunded for tokens it did spend.
   */
  const settle = (actual) => adjust((actual > 0 ? actual : estimate) - estimate);

  /** Hands the whole reservation back, for a request that never ran. */
  const refund = () => adjust(-estimate);

  let upstream;
  try {
    upstream = await fetch(OPENAI_COMPLETIONS, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sanitized.body),
    });
  } catch {
    // Nothing was generated, so nothing is owed.
    ctx.waitUntil(refund());
    return json(errorBody('Could not reach the model provider.', 'server_error'), 502, origin);
  }

  if (!upstream.ok || !upstream.body) {
    // The upstream body can name the organization and the key's own limits, so
    // the status is forwarded and the text is not.
    ctx.waitUntil(refund());
    const message = upstream.status === 429
      ? 'The shared model is rate limited upstream right now. Try again shortly, or connect ' +
        'your own OpenRouter or OpenAI key.'
      : `The model provider rejected the request (${upstream.status}).`;
    return json(errorBody(message, 'upstream_error'), upstream.status === 429 ? 429 : 502, origin);
  }

  const scanner = new UsageScanner();
  const decoder = new TextDecoder();
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  ctx.waitUntil(finished.then(() => settle(scanner.total)));

  const meter = new TransformStream({
    transform(chunk, controller) {
      scanner.push(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      scanner.end();
      finish();
    },
    cancel() {
      // A reader that goes away mid-stream (the dock's Stop control) still owes
      // whatever was produced; keeping the estimate is the honest default.
      finish();
    },
  });

  return new Response(upstream.body.pipeThrough(meter), {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      ...rateHeaders(ipReserve),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cfg = config(env);

    if (!originAllowed(origin)) {
      // No CORS headers either: a disallowed page should fail at the browser.
      return json(errorBody(
        'This deployment only serves the GNU Radio World editor.',
        'forbidden',
      ), 403, '');
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return json(modelList(cfg), 200, origin);
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return handleCompletion(request, env, ctx, origin, cfg);
    }
    return json(errorBody('Not found.', 'not_found'), 404, origin);
  },
};
