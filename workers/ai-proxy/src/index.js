/**
 * Graham's shared-key proxy.
 *
 * The editor's two keyless AI providers ("OpenAI Free Tier" and "OpenRouter
 * Free Tier") have no API key of their own. They talk to this Worker,
 * which holds one key per upstream for everybody and meters each of them
 * separately: a rolling per-client-IP window, an optional per-client-IP UTC
 * day window, and a site-wide ceiling for the UTC day.
 *
 * **Which upstream a request reaches is decided by its path, and by nothing
 * else the caller sends.** `/v1/…` is OpenAI on the shared OpenAI key;
 * `/openrouter/v1/…` is OpenRouter's free tier on the shared OpenRouter key.
 * Each has its own model allowlist, its own limiter windows, and its own usage
 * history, so one running out leaves the other untouched.
 *
 * Nothing here is a passthrough. The upstream request body is rebuilt from a
 * whitelist, so a caller cannot select a different model, suppress the usage
 * reporting the metering depends on, or attach account-level fields. The key
 * never leaves the Worker and upstream error bodies — which can name the
 * organization — are never returned verbatim.
 *
 * The daily ceiling is a UTC calendar day: it resets at 00:00 UTC for everyone
 * at once, rather than a rolling 24 hours from whenever the first request of a
 * period happened to land.
 *
 * See ../README.md for deployment and tunables, and ../../docs/graham.md
 * for how the editor uses it.
 */
import { TokenLimiter, MINUTE_MS, DAY_MS } from './limiter.js';

export { TokenLimiter };

/**
 * The two APIs this Worker fronts, each on a shared key of its own.
 *
 * Everything an upstream is allowed to differ in lives here, so a third one is
 * another entry rather than a branch in the request path below. `prefix` is
 * the whole of the routing: a caller selects an upstream by the URL it posts
 * to, never by a field in the body.
 */
export const UPSTREAMS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    /** The path on this Worker that selects it. */
    prefix: '/v1',
    // pr-security-scan: allow new-outbound-host
    url: 'https://api.openai.com/v1/chat/completions',
    /** The Worker secret holding this upstream's shared key. */
    keyVar: 'OPENAI_API_KEY',
    /**
     * Durable Object name prefix. Each upstream meters into instances of its
     * own, so its windows and its usage history are independent of the
     * other's — the original upstream keeps the unprefixed names it has always
     * used.
     */
    scope: '',
    /**
     * What the windows count. Tokens, because this key is billed by them and
     * the daily cap is a bill.
     */
    meter: 'tokens',
    /** The field this API takes an output ceiling in. */
    maxTokensField: 'max_completion_tokens',
    /** Only OpenAI routes on a cache key. */
    promptCacheKey: true,
    /**
     * On /v1/chat/completions these models refuse function tools unless
     * reasoning is off — "Function tools with reasoning_effort are not
     * supported … use /v1/responses or set reasoning_effort to 'none'".
     * Leaving it unset is not the same as 'none': a model whose own default is
     * non-none (gpt-5.6-luna) rejects every tool-carrying request, which is
     * every request the editor makes.
     */
    reasoningEffort: 'none',
    /** OpenRouter's ranking headers; OpenAI rejects them. */
    attribution: false,
    modelsVar: 'MODELS',
    /**
     * The models the shared key may be used with. The first is the default,
     * used when a request names none; anything outside the list is refused by
     * name. One entry today: every model here would be billed against the same
     * token budget, so a second buys more work per dollar rather than a second
     * allowance. A list rather than a single name so that stays a one-line
     * change, here and in `HOSTED_MODELS` on the editor side.
     */
    models: ['gpt-5.6-luna'],
    perIpVar: 'TOKENS_PER_MINUTE',
    perIp: 1_000_000,
    userDailyVar: 'PER_USER_DAILY_CAP',
    /** Per client IP, per UTC calendar day. Resets at 00:00 UTC. */
    userDaily: 1_000_000,
    dailyVar: 'GLOBAL_DAILY_TOKEN_CAP',
    /** Site-wide, per UTC calendar day. Resets at 00:00 UTC. */
    daily: 5_000_000,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    prefix: '/openrouter/v1',
    // pr-security-scan: allow new-outbound-host
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyVar: 'OPENROUTER_API_KEY',
    scope: 'or:',
    /**
     * Requests, not tokens. A `:free` model costs nothing per token, so there
     * is no bill for a token budget to bound; what actually runs out is
     * OpenRouter's free-tier **request** allowance for the whole account, so
     * that is the unit both windows count. One reserved unit is one request,
     * and there is nothing to settle afterwards — only the history's token
     * count is, which is why a free upstream still reports tokens.
     */
    meter: 'requests',
    /** OpenRouter's own spelling; `max_completion_tokens` is not its field. */
    maxTokensField: 'max_tokens',
    promptCacheKey: false,
    /**
     * This loop spends most of its rounds mechanically threading one tool
     * result into the next tool call, and reasoning tokens are output tokens —
     * slower rounds against a free endpoint the whole site shares. The free
     * model here lists `reasoning_effort` among its supported parameters, so
     * unlike the OpenAI path a graduated value is reachable; OpenRouter drops
     * the field for a model that cannot take it.
     */
    reasoningEffort: 'low',
    attribution: true,
    modelsVar: 'OPENROUTER_MODELS',
    /**
     * Free variants only. The `:free` suffix is what pins a model to the
     * endpoints that cost nothing — the same id without it is a paid model,
     * and this key must never reach one.
     */
    models: ['nvidia/nemotron-3-ultra-550b-a55b:free'],
    perIpVar: 'OPENROUTER_REQUESTS_PER_MINUTE',
    /**
     * Under OpenRouter's own free-tier ceiling of 20 requests a minute, which
     * it applies to the whole account rather than per caller — so no per-IP
     * value can stop two visitors contending, but one set *above* 20 would
     * only guarantee the upstream refuses instead. A round is one request and
     * rounds are sequential, so a single conversation does not approach this.
     */
    perIp: 15,
    dailyVar: 'OPENROUTER_DAILY_REQUEST_CAP',
    /**
     * Site-wide, per UTC day, and it must stay **under the free-tier allowance
     * on the account itself**: OpenRouter allows a free key 50 requests a day,
     * or 1000 once the account has bought at least 10 credits. This default
     * assumes the larger one. A cap above the real allowance only moves the
     * refusal upstream, where it reads as a broken model rather than as a
     * spent budget.
     */
    daily: 900,
  },
};

export const DEFAULTS = {
  // The OpenAI upstream's, which is the one every existing caller reaches, so
  // its tunables read the same as they always have.
  models: UPSTREAMS.openai.models,
  tokensPerMinute: UPSTREAMS.openai.perIp,
  perUserDailyCap: UPSTREAMS.openai.userDaily,
  globalDailyTokenCap: UPSTREAMS.openai.daily,
  maxBodyBytes: 1_048_576,
  /** Ceiling on one completion, reasoning included. Bounds the output bill. */
  maxCompletionTokens: 50_000,
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
   *
   * Suffixed with the model, because the key is a routing hint and a cache
   * belongs to one model: pointing two models at one machine would send half
   * the requests to a host holding a prefix they cannot use.
   */
  cacheKey: 'grw-shared',
};

/** The cache key for one model. See `DEFAULTS.cacheKey`. */
export const cacheKeyFor = (cfg, model) => `${cfg.cacheKey}-${model}`;

/** The upstream an incoming path selects, or null for anything else. */
export function routeFor(pathname) {
  for (const upstream of Object.values(UPSTREAMS)) {
    if (pathname === `${upstream.prefix}/chat/completions`) {
      return { upstream, endpoint: 'completions' };
    }
    if (pathname === `${upstream.prefix}/models`) return { upstream, endpoint: 'models' };
  }
  return null;
}

/**
 * Reads the tunables for one upstream, all of which are plain `vars` in
 * wrangler.jsonc. Anything not named per upstream is shared by both.
 */
export function config(env = {}, upstreamId = 'openai') {
  const upstream = UPSTREAMS[upstreamId] || UPSTREAMS.openai;
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  // Comma-separated, first entry the default. `MODEL` is accepted as the
  // one-model spelling of the same thing, on the original upstream.
  const named = env[upstream.modelsVar] || (upstream.id === 'openai' ? env.MODEL : '') || '';
  const listed = String(named).split(',').map(name => name.trim()).filter(Boolean);
  const models = listed.length ? listed : upstream.models;
  return {
    upstream,
    models,
    /** The model a request that names none is sent to. */
    model: models[0],
    /** Per client IP, over a rolling minute, in `upstream.meter` units. */
    perIpLimit: number(env[upstream.perIpVar], upstream.perIp),
    /** Per client IP, over the UTC day, when that upstream defines one. */
    userDailyLimit: upstream.userDailyVar
      ? number(env[upstream.userDailyVar], upstream.userDaily)
      : null,
    /** Site-wide, over the UTC day, in the same units. */
    dailyLimit: number(env[upstream.dailyVar], upstream.daily),
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
// per-IP limits, the global daily cap, and a spend limit on the key itself.
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

// Both units appear, because which one an upstream meters in is its own
// business and a browser reads whichever arrives. See `rateHeaders`.
const RATE_HEADERS = [
  'X-RateLimit-Limit-Tokens',
  'X-RateLimit-Remaining-Tokens',
  'X-RateLimit-Limit-Requests',
  'X-RateLimit-Remaining-Requests',
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

/** "a", "a and b", "a, b and c" — three models joined with two `and`s reads badly. */
const nameList = (names) => names.length < 2
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

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
  // A request naming no model gets the default rather than being refused; the
  // editor always names one.
  const model = raw.model === undefined ? cfg.model : String(raw.model);
  if (!cfg.models.includes(model)) {
    return {
      ok: false,
      status: 400,
      message: `The shared GNU Radio World key is limited to ${nameList(cfg.models)}. ` +
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

  const { upstream } = cfg;
  return {
    ok: true,
    body: {
      model,
      messages: raw.messages,
      ...(raw.tools ? { tools: raw.tools } : {}),
      ...(raw.tool_choice ? { tool_choice: raw.tool_choice } : {}),
      // Set, not accepted, like the fields below it: a batch of
      // independent calls answered in one round is one billed request instead
      // of several, each of which would resend the whole transcript. Only
      // alongside tools, which is the only shape OpenAI accepts it in.
      ...(raw.tools ? { parallel_tool_calls: true } : {}),
      stream: true,
      // Not negotiable: the token count in this event is what the limiter
      // settles against, and what the day's history records either way.
      stream_options: { include_usage: true },
      // Only alongside tools, so a plain completion keeps whatever the model
      // does by default. Why each upstream asks for what it does is on
      // `reasoningEffort` in UPSTREAMS.
      ...(raw.tools && upstream.reasoningEffort
        ? { reasoning_effort: upstream.reasoningEffort } : {}),
      // The two APIs spell the output ceiling differently, and a field an API
      // does not know is a field that does not bound anything.
      [upstream.maxTokensField]: cfg.maxCompletionTokens,
      ...(upstream.promptCacheKey ? { prompt_cache_key: cacheKeyFor(cfg, model) } : {}),
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
  data: cfg.models.map(id => ({ id, object: 'model', created: 0, owned_by: 'gnuradio-world' })),
});

/**
 * The per-IP window, in the unit that window actually counts — a free upstream
 * rations requests rather than tokens, and a header naming the wrong unit is
 * worse than no header.
 */
const rateHeaders = (cfg, reserve) => {
  const unit = cfg.upstream.meter === 'requests' ? 'Requests' : 'Tokens';
  return {
    [`X-RateLimit-Limit-${unit}`]: String(reserve.limit),
    [`X-RateLimit-Remaining-${unit}`]: String(reserve.remaining),
    'X-RateLimit-Reset-Seconds': String(reserve.resetIn),
  };
};

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

  const apiKey = env[cfg.upstream.keyVar];
  if (!apiKey) {
    return json(errorBody(
      'The shared model is not configured on this deployment.',
      'server_error',
    ), 503, origin);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  // What the windows are charged. A token-metered upstream reserves an
  // estimate it settles later; a request-metered one reserves the single
  // request it is, which is already exact and settles to nothing.
  const requestMetered = cfg.upstream.meter === 'requests';
  const estimate = requestMetered ? 1 : estimateTokens(raw.length, cfg);
  // The agent loop sends one request per tool round, so a request count says
  // little about how much was actually asked for. A round that *begins* a turn
  // is the one whose last message came from the human; every later round of the
  // same turn ends with a tool result.
  const turn = sanitized.body.messages.at(-1)?.role === 'user';
  // Scoped per upstream, so each one's windows and each one's history belong
  // to it alone: the free tier running out must not touch the paid budget.
  const { scope } = cfg.upstream;
  const perIp = env.LIMITER.get(env.LIMITER.idFromName(`${scope}ip:${ip}`));
  const perUserDaily = cfg.userDailyLimit
    ? env.LIMITER.get(env.LIMITER.idFromName(`${scope}user-day:${ip}`))
    : null;
  const global = env.LIMITER.get(env.LIMITER.idFromName(`${scope}global`));

  const ipWindow = { limit: cfg.perIpLimit, windowMs: MINUTE_MS };
  // `aligned` anchors the window to the epoch, which is itself midnight UTC —
  // so the day's budget resets at 00:00 UTC rather than 24 hours after the
  // request that happened to open it.
  const userDayWindow = cfg.userDailyLimit
    ? { limit: cfg.userDailyLimit, windowMs: DAY_MS, aligned: true }
    : null;
  const globalDayWindow = { limit: cfg.dailyLimit, windowMs: DAY_MS, aligned: true };

  const ipReserve = await limiterCall(perIp, '/reserve', { estimate, ...ipWindow });
  if (!ipReserve.ok) {
    // This return never reaches the global object, which is where the history
    // lives — so the refusal is recorded there explicitly. A limit that is
    // biting is precisely what the history should show.
    ctx.waitUntil(limiterCall(global, '/count', { ip, turn, refused: true }));
    return json(errorBody(
      `The shared model's per-visitor limit is used up. Try again in ${ipReserve.retryAfter}s, ` +
      'or connect your own OpenRouter or OpenAI key for higher limits.',
      'rate_limit_exceeded',
    ), 429, origin, {
      'Retry-After': String(ipReserve.retryAfter),
      ...rateHeaders(cfg, ipReserve),
    });
  }

  const userDayReserve = perUserDaily
    ? await limiterCall(perUserDaily, '/reserve', { estimate, ...userDayWindow })
    : null;
  if (userDayReserve && !userDayReserve.ok) {
    ctx.waitUntil(Promise.all([
      limiterCall(perIp, '/settle', {
        delta: -estimate, windowStart: ipReserve.windowStart, ...ipWindow,
      }),
      limiterCall(global, '/count', { ip, turn, refused: true }),
    ]));
    return json(errorBody(
      "The shared model's daily budget for this visitor is used up. It resets at " +
      `00:00 UTC, in ${Math.ceil(userDayReserve.retryAfter / 3600)}h — connect your own ` +
      'OpenRouter or OpenAI key to keep working now.',
      'rate_limit_exceeded',
    ), 429, origin, {
      'Retry-After': String(userDayReserve.retryAfter),
      ...rateHeaders(cfg, userDayReserve),
    });
  }

  // The global instance also keeps the usage history, on this call it had to
  // make anyway. It hashes the IP under a salt it throws away daily; nothing
  // that identifies a visitor is stored. See src/limiter.js.
  const dayReserve = await limiterCall(global, '/reserve', {
    estimate, ...globalDayWindow, stats: true, ip, turn,
  });
  if (!dayReserve.ok) {
    // Give both visitor windows their estimates back; nothing was spent upstream.
    ctx.waitUntil(Promise.all([
      limiterCall(perIp, '/settle', {
        delta: -estimate, windowStart: ipReserve.windowStart, ...ipWindow,
      }),
      perUserDaily
        ? limiterCall(perUserDaily, '/settle', {
          delta: -estimate, windowStart: userDayReserve.windowStart, ...userDayWindow,
        })
        : Promise.resolve(),
    ]));
    return json(errorBody(
      "The shared model's daily budget for all visitors is used up. It resets at " +
      `00:00 UTC, in ${Math.ceil(dayReserve.retryAfter / 3600)}h — connect your own OpenRouter ` +
      'or OpenAI key to keep working now.',
      'rate_limit_exceeded',
    ), 429, origin, {
      'Retry-After': String(dayReserve.retryAfter),
      ...rateHeaders(cfg, ipReserve),
    });
  }

  const adjust = (delta, stats) => Promise.all([
    // Nothing to correct on the per-IP window when the estimate was exact.
    delta
      ? limiterCall(perIp, '/settle', { delta, windowStart: ipReserve.windowStart, ...ipWindow })
      : Promise.resolve(),
    perUserDaily && delta
      ? limiterCall(perUserDaily, '/settle', {
        delta, windowStart: userDayReserve.windowStart, ...userDayWindow,
      })
      : Promise.resolve(),
    // The global one is called either way, because it also records the outcome.
    limiterCall(global, '/settle', {
      delta, windowStart: dayReserve.windowStart, ...globalDayWindow, stats: true, ...stats,
    }),
  ]);

  /**
   * Charges the difference between the estimate and the truth on every window.
   * A stream that ended without a usage event — an aborted read, most often —
   * keeps its estimate rather than being refunded for tokens it did spend.
   *
   * A request-metered window has nothing to correct: the one request it
   * reserved is the one request that happened. Its usage event is still read,
   * because the day's history counts tokens whether or not they cost anything.
   */
  const settle = (actual) => {
    const tokens = actual > 0 ? actual : (requestMetered ? 0 : estimate);
    return adjust(requestMetered ? 0 : tokens - estimate, { spent: tokens });
  };

  /** Hands the whole reservation back, for a request that never ran. */
  const refund = () => adjust(-estimate, { spent: 0, failed: true });

  let upstream;
  try {
    upstream = await fetch(cfg.upstream.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Attribution is the Worker's to send, not the browser's: the editor
        // talks to this origin, so its own headers would name nothing useful
        // and would widen the preflight for it.
        ...(cfg.upstream.attribution ? {
          'HTTP-Referer': 'https://gnuradioworld.com',
          'X-Title': 'GNU Radio World Graham',
        } : {}),
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
    // the status is forwarded to the caller and the text is not. It is also the
    // only account of *why* a model refused, so it goes to the Worker's log,
    // which only the operator can read (`wrangler tail`) — without it a model
    // that rejects one field of the request is an opaque 400 forever.
    const detail = await upstream.text().catch(() => '');
    console.error(`upstream ${upstream.status} for ${sanitized.body.model}: ` +
      detail.slice(0, 800).replace(/\s+/g, ' '));
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
      ...rateHeaders(cfg, ipReserve),
    },
  });
}

/**
 * The usage history, for the operator rather than the site. Authenticated with
 * a bearer token and answered before the origin gate, because a `curl` sends no
 * Origin at all — and deliberately outside CORS, so no page can read it.
 */
async function handleStats(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Use GET /stats' }, { status: 405, headers: { Allow: 'GET' } });
  }
  if (!env.STATS_TOKEN) {
    console.error('Stats request rejected: STATS_TOKEN is not configured');
    return Response.json({ error: 'Stats are not configured' }, { status: 503 });
  }
  if (request.headers.get('Authorization') !== `Bearer ${env.STATS_TOKEN}`) {
    console.warn('Unauthorized stats request');
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const days = params.get('days') || '30';
  // Each upstream keeps its own history, in the same object that meters it.
  // Defaulting to the original one keeps every existing `curl` reading what it
  // has always read.
  const wanted = params.get('upstream') || 'openai';
  if (!UPSTREAMS[wanted]) {
    return Response.json({
      error: `Unknown upstream. Try one of ${Object.keys(UPSTREAMS).join(', ')}.`,
    }, { status: 400 });
  }
  const global = env.LIMITER.get(env.LIMITER.idFromName(`${UPSTREAMS[wanted].scope}global`));
  const response = await global.fetch(`https://limiter/stats?days=${encodeURIComponent(days)}`);
  return Response.json(await response.json(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (new URL(request.url).pathname === '/stats') return handleStats(request, env);

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

    // The path is the whole of the upstream selection: `/v1/…` is the shared
    // OpenAI key, `/openrouter/v1/…` the shared OpenRouter one. Nothing in the
    // body can move a request from one to the other.
    const route = routeFor(new URL(request.url).pathname);
    if (!route) return json(errorBody('Not found.', 'not_found'), 404, origin);
    const cfg = config(env, route.upstream.id);
    if (request.method === 'GET' && route.endpoint === 'models') {
      return json(modelList(cfg), 200, origin);
    }
    if (request.method === 'POST' && route.endpoint === 'completions') {
      return handleCompletion(request, env, ctx, origin, cfg);
    }
    return json(errorBody('Not found.', 'not_found'), 404, origin);
  },
};
