import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  UPSTREAMS,
  UsageScanner,
  cacheKeyFor,
  config,
  estimateTokens,
  originAllowed,
  routeFor,
  sanitizeBody,
} from '../src/index.js';
import { DAY_MS, TokenLimiter, alignedStart } from '../src/limiter.js';
import { fakeStorage } from './storage.js';

const ORIGIN = 'https://gnuradioworld.com';
// pr-security-scan: allow new-outbound-host
const PROXY = 'https://ai.gnuradioworld.com';

/**
 * An in-memory stand-in for the Durable Object namespace, backed by the real
 * TokenLimiter class over fake storage — so these tests exercise the actual
 * metering and stats code rather than a reimplementation of it.
 */
function fakeLimiters() {
  const objects = new Map();
  const object = name => {
    if (!objects.has(name)) objects.set(name, new TokenLimiter({ storage: fakeStorage() }));
    return objects.get(name);
  };
  const namespace = {
    idFromName: name => ({ name }),
    // A stub takes (url, init); the runtime builds the Request the class sees.
    get: id => ({ fetch: (url, init) => object(id.name).fetch(new Request(url, init)) }),
  };
  namespace.used = async name =>
    (await object(name).ctx.storage.get('window'))?.used ?? 0;
  // Daily windows are aligned to UTC, so a planted charge has to sit on
  // today's boundary or the next roll discards it.
  namespace.charge = (name, used) => object(name).ctx.storage.put('window', {
    windowStart: name.endsWith('global') || name.includes('user-day:')
      ? alignedStart(Date.now(), DAY_MS)
      : Date.now(),
    used,
  });
  namespace.stats = async (name = 'global') =>
    (await (await object(name).fetch(new Request('https://limiter/stats'))).json()).days;
  return namespace;
}

function context() {
  const pending = [];
  return {
    ctx: { waitUntil: promise => pending.push(promise) },
    settled: () => Promise.all(pending),
  };
}

const sse = (...chunks) => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  },
});

const completionRequest = (body, headers = {}) => new Request(
  `${PROXY}/v1/chat/completions`,
  {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  },
);

const CHAT = {
  model: 'gpt-5.6-luna',
  messages: [{ role: 'user', content: 'add a signal source' }],
  tools: [{ type: 'function', function: { name: 'validate' } }],
  stream: true,
};

/** Runs the Worker with a stubbed upstream, returning the captured request. */
async function withUpstream(respond, run) {
  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return respond(String(url), init);
  };
  try {
    return { result: await run(), seen };
  } finally {
    globalThis.fetch = saved;
  }
}

test('the origin allowlist covers the site, previews, and local development', () => {
  for (const origin of [
    'https://gnuradioworld.com',
    'https://www.gnuradioworld.com',
    'https://gnuradio-wasm.pages.dev',
    'https://pr-42.gnuradio-world-previews.pages.dev', // pr-security-scan: allow new-outbound-host
    'http://localhost:8090',
    'http://127.0.0.1:5173',
  ]) assert.equal(originAllowed(origin), true, origin);

  for (const origin of [
    '',
    'null',
    'https://evil.com', // pr-security-scan: allow new-outbound-host
    'https://gnuradioworld.com.evil.com', // pr-security-scan: allow new-outbound-host
    'http://gnuradioworld.com',
    'https://gnuradio-world-previews.pages.dev.evil.com', // pr-security-scan: allow new-outbound-host
    'https://notlocalhost',
  ]) assert.equal(originAllowed(origin), false, origin);
});

test('a preflight is cacheable, so a completion costs one request and not two', async () => {
  const response = await worker.fetch(
    new Request(`${PROXY}/v1/chat/completions`, {
      method: 'OPTIONS', headers: { Origin: ORIGIN },
    }), {}, context().ctx,
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(response.headers.get('Access-Control-Max-Age'), '86400');
});

test('another site gets no CORS headers at all', async () => {
  const response = await worker.fetch(
    new Request(`${PROXY}/v1/models`, {
      headers: { Origin: 'https://evil.com' }, // pr-security-scan: allow new-outbound-host
    }), {}, context().ctx,
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('the model list is the configured allowlist and never reaches OpenAI', async () => {
  const { result, seen } = await withUpstream(
    () => { throw new Error('the model list must not call upstream'); },
    () => worker.fetch(
      new Request(`${PROXY}/v1/models`, { headers: { Origin: ORIGIN } }),
      { MODELS: 'gpt-5.4-mini,gpt-5.4-nano,gpt-5.6-luna' }, context().ctx,
    ),
  );
  assert.equal(seen.length, 0);
  const payload = await result.json();
  assert.deepEqual(payload.data.map(model => model.id),
    ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.6-luna']);
});

test('the upstream body is rebuilt, not forwarded', () => {
  const cfg = config({});
  assert.equal(cfg.maxCompletionTokens, 50_000, 'the hosted completion ceiling is 50k');
  const { ok, body } = sanitizeBody({
    ...CHAT,
    stream: false,
    stream_options: { include_usage: false },
    prompt_cache_key: 'caller-supplied',
    user: 'someone',
    store: true,
    metadata: { note: 'dropped' },
    max_completion_tokens: 999_999,
  }, cfg);
  assert.equal(ok, true);
  assert.equal(body.stream, true, 'metering depends on a stream');
  assert.deepEqual(body.stream_options, { include_usage: true },
    'metering depends on the usage event the caller tried to suppress');
  assert.equal(body.prompt_cache_key, cacheKeyFor(cfg, cfg.model),
    'one shared warm prefix for everyone on this model');
  assert.equal(body.max_completion_tokens, cfg.maxCompletionTokens, 'the output ceiling is ours');
  for (const dropped of ['user', 'store', 'metadata']) {
    assert.equal(dropped in body, false, `${dropped} must not reach the account`);
  }
});

test('an allowed model is passed through, with a cache key of its own', () => {
  // Configured with more than one, because the cache key is per model and the
  // default allowlist holding a single entry is a setting, not a constraint.
  const cfg = config({ MODELS: 'gpt-5.4-mini,gpt-5.4-nano,gpt-5.6-luna' });
  for (const model of ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.6-luna']) {
    const sanitized = sanitizeBody({ ...CHAT, model }, cfg);
    assert.equal(sanitized.ok, true);
    assert.equal(sanitized.body.model, model);
    assert.equal(sanitized.body.prompt_cache_key, cacheKeyFor(cfg, model));
  }
  // One model's warm prefix is useless to the other, so they never share a key.
  assert.notEqual(cacheKeyFor(cfg, 'gpt-5.4-mini'), cacheKeyFor(cfg, 'gpt-5.4-nano'));
  // What the deployment actually ships with is one model, and the editor's
  // picker locks to it. HOSTED_MODELS in editor/src/ai/providers.ts is the
  // same list, and the two change together.
  assert.deepEqual(config({}).models, ['gpt-5.6-luna']);
});

test('OpenAI has distinct per-user and global daily token caps', () => {
  const defaults = config({});
  assert.equal(defaults.userDailyLimit, 1_000_000);
  assert.equal(defaults.dailyLimit, 5_000_000);

  const configured = config({
    PER_USER_DAILY_CAP: '750000',
    GLOBAL_DAILY_TOKEN_CAP: '4000000',
  });
  assert.equal(configured.userDailyLimit, 750_000);
  assert.equal(configured.dailyLimit, 4_000_000);
  assert.equal(config({}, 'openrouter').userDailyLimit, null,
    'the request-metered free upstream has no per-user daily token window');
});

test('tools force reasoning off, which is what makes them work at all', () => {
  // Not cosmetic: gpt-5.6-luna defaults to non-none reasoning and refuses every
  // tool-carrying request without this, and every editor request carries tools.
  const withTools = sanitizeBody({ ...CHAT, model: 'gpt-5.6-luna' }, config({}));
  assert.equal(withTools.body.reasoning_effort, 'none');
  // A plain completion is left alone, keeping the model's own default.
  const { tools, ...noTools } = CHAT;
  assert.equal('reasoning_effort' in sanitizeBody(noTools, config({})).body, false);
});

test('tool calls are batched, so one round is one billed request', () => {
  // Every round resends the whole transcript, so calls the model could have
  // answered together cost the shared budget twice. The caller does not get to
  // turn that off.
  const withTools = sanitizeBody({ ...CHAT, parallel_tool_calls: false }, config({}));
  assert.equal(withTools.body.parallel_tool_calls, true);
  // OpenAI rejects the field without tools to go with it.
  const { tools, ...noTools } = CHAT;
  assert.equal('parallel_tool_calls' in sanitizeBody(noTools, config({})).body, false);
});

test('a request naming no model gets the default rather than a refusal', () => {
  const { model, ...noModel } = CHAT;
  const sanitized = sanitizeBody(noModel, config({}));
  assert.equal(sanitized.ok, true);
  assert.equal(sanitized.body.model, 'gpt-5.6-luna', 'the first listed model is the default');
});

test('a model outside the allowlist is refused, naming every one it accepts', () => {
  const refused = sanitizeBody({ ...CHAT, model: 'gpt-5.4' },
    config({ MODELS: 'gpt-5.4-mini,gpt-5.4-nano,gpt-5.6-luna' }));
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 400);
  assert.match(refused.message,
    /limited to gpt-5\.4-mini, gpt-5\.4-nano and gpt-5\.6-luna/);
  // The shipped deployment is one model, which must not read "limited to a and ".
  assert.match(sanitizeBody({ ...CHAT, model: 'gpt-5.4' }, config({})).message,
    /limited to gpt-5\.6-luna\./);
});

test('a request with no messages is refused', () => {
  assert.equal(sanitizeBody({ model: 'gpt-5.6-luna', messages: [] }, config({})).ok, false);
  assert.equal(sanitizeBody('nope', config({})).ok, false);
});

test('usage is read across chunk boundaries and content deltas are ignored', () => {
  const scanner = new UsageScanner();
  scanner.push('data: {"choices":[{"delta":{"content":"hel');
  scanner.push('lo"}}]}\n\ndata: {"choices":[],"usa');
  scanner.push('ge":{"prompt_tokens":40,"completion_tokens":2,"total_tokens":42}}\n');
  scanner.push('data: [DONE]\n');
  scanner.end();
  assert.equal(scanner.seen, true);
  assert.equal(scanner.total, 42);
});

test('a completion is proxied with the shared key and settled against real usage', async () => {
  const env = { OPENAI_API_KEY: 'sk-shared', LIMITER: fakeLimiters() };
  const { ctx, settled } = context();
  const { result, seen } = await withUpstream(
    () => new Response(sse(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":9000,"completion_tokens":1000,"total_tokens":10000}}\n\n',
      'data: [DONE]\n\n',
    ), { status: 200 }),
    () => worker.fetch(
      completionRequest(CHAT, { Authorization: 'Bearer sk-callers-own-key' }),
      env, ctx,
    ),
  );

  assert.equal(result.status, 200);
  assert.match(result.headers.get('Content-Type'), /text\/event-stream/);
  assert.equal(result.headers.get('X-RateLimit-Limit-Tokens'), '1000000');

  const [call] = seen;
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-shared',
    "the caller's own Authorization header must never be forwarded");
  assert.equal(JSON.parse(call.init.body).stream_options.include_usage, true);

  // The stream reaches the browser untouched.
  const text = await result.text();
  assert.match(text, /"content":"ok"/);
  assert.match(text, /\[DONE\]/);

  await settled();
  assert.equal(await env.LIMITER.used('ip:unknown'), 10_000,
    'the estimate is replaced by what the completion actually spent');
  assert.equal(await env.LIMITER.used('user-day:unknown'), 10_000);
  assert.equal(await env.LIMITER.used('global'), 10_000);
});

test('a used-up per-IP window answers 429 with a retry and a way forward', async () => {
  const env = {
    OPENAI_API_KEY: 'sk-shared',
    LIMITER: fakeLimiters(),
    TOKENS_PER_MINUTE: '1000',
  };
  await env.LIMITER.charge('ip:1.2.3.4', 1000);
  const { ctx } = context();
  const { result, seen } = await withUpstream(
    () => { throw new Error('a rate-limited request must not reach OpenAI'); },
    () => worker.fetch(
      completionRequest(CHAT, { 'CF-Connecting-IP': '1.2.3.4' }), env, ctx,
    ),
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status, 429);
  assert.ok(Number(result.headers.get('Retry-After')) > 0);
  const payload = await result.json();
  assert.equal(payload.error.type, 'rate_limit_exceeded');
  assert.match(payload.error.message, /your own OpenRouter or OpenAI key/);
});

test('the per-user daily cap refuses that visitor and refunds their minute', async () => {
  const env = {
    OPENAI_API_KEY: 'sk-shared',
    LIMITER: fakeLimiters(),
    PER_USER_DAILY_CAP: '1000',
  };
  await env.LIMITER.charge('user-day:5.6.7.8', 1000);
  const { ctx, settled } = context();
  const { result, seen } = await withUpstream(
    () => { throw new Error('a capped request must not reach OpenAI'); },
    () => worker.fetch(completionRequest(CHAT, { 'CF-Connecting-IP': '5.6.7.8' }), env, ctx),
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status, 429);
  assert.match((await result.json()).error.message, /daily budget for this visitor/);
  await settled();
  assert.equal(await env.LIMITER.used('ip:5.6.7.8'), 0,
    'nothing was spent upstream, so the visitor keeps their minute');
  assert.equal(await env.LIMITER.used('global'), 0,
    'the refusal is counted globally but does not reserve global spend');

  const { ctx: otherCtx, settled: otherSettled } = context();
  const { result: other } = await withUpstream(() => usageStream(50), () => worker.fetch(
    completionRequest(CHAT, { 'CF-Connecting-IP': '8.8.8.8' }), env, otherCtx,
  ));
  assert.equal(other.status, 200, 'another visitor keeps their independent daily budget');
  await other.text();
  await otherSettled();
});

test('the global daily cap refuses everyone and refunds both visitor windows', async () => {
  const env = {
    OPENAI_API_KEY: 'sk-shared',
    LIMITER: fakeLimiters(),
    GLOBAL_DAILY_TOKEN_CAP: '1000',
  };
  await env.LIMITER.charge('global', 1000);
  const { ctx, settled } = context();
  const { result, seen } = await withUpstream(
    () => { throw new Error('a capped request must not reach OpenAI'); },
    () => worker.fetch(completionRequest(CHAT, { 'CF-Connecting-IP': '5.6.7.8' }), env, ctx),
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status, 429);
  assert.match((await result.json()).error.message, /daily budget for all visitors/);
  await settled();
  assert.equal(await env.LIMITER.used('ip:5.6.7.8'), 0);
  assert.equal(await env.LIMITER.used('user-day:5.6.7.8'), 0,
    'nothing was spent upstream, so the visitor keeps their daily budget');
});

test('an oversized body is refused before any reservation', async () => {
  const env = { OPENAI_API_KEY: 'sk-shared', LIMITER: fakeLimiters(), MAX_BODY_BYTES: '512' };
  const { ctx } = context();
  const { result, seen } = await withUpstream(
    () => { throw new Error('an oversized request must not reach OpenAI'); },
    () => worker.fetch(completionRequest({
      ...CHAT, messages: [{ role: 'user', content: 'x'.repeat(2000) }],
    }), env, ctx),
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status, 413);
  assert.equal(await env.LIMITER.used('ip:unknown'), 0);
});

test('an upstream failure is reported without its body, and refunded', async () => {
  const env = { OPENAI_API_KEY: 'sk-shared', LIMITER: fakeLimiters() };
  const { ctx, settled } = context();
  const { result } = await withUpstream(
    () => new Response(JSON.stringify({
      error: { message: 'Incorrect API key sk-shared for org org-secret' },
    }), { status: 401 }),
    () => worker.fetch(completionRequest(CHAT), env, ctx),
  );
  assert.equal(result.status, 502);
  const payload = await result.json();
  assert.doesNotMatch(payload.error.message, /sk-shared|org-secret/);
  await settled();
  // Nothing was generated, so the visitor's minute is handed back whole.
  assert.equal(await env.LIMITER.used('ip:unknown'), 0);
  assert.equal(await env.LIMITER.used('global'), 0);
});

test('a stream that ends with no usage event keeps its estimate', async () => {
  const env = { OPENAI_API_KEY: 'sk-shared', LIMITER: fakeLimiters() };
  const { ctx, settled } = context();
  const { result } = await withUpstream(
    () => new Response(sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'), { status: 200 }),
    () => worker.fetch(completionRequest(CHAT), env, ctx),
  );
  await result.text();
  await settled();
  // Tokens were spent upstream even though the count never arrived, so the
  // estimate stands rather than being refunded.
  assert.ok(await env.LIMITER.used('ip:unknown') > 0);
});

test('an unconfigured deployment says so instead of failing upstream', async () => {
  const { ctx } = context();
  const response = await worker.fetch(
    completionRequest(CHAT), { LIMITER: fakeLimiters() }, ctx,
  );
  assert.equal(response.status, 503);
});

test('every metered request is counted, without keeping anything identifying', async () => {
  const env = { OPENAI_API_KEY: 'sk-shared', LIMITER: fakeLimiters() };
  const { ctx, settled } = context();
  const usage = () => new Response(sse(
    'data: {"choices":[],"usage":{"total_tokens":5000}}\n\n',
  ), { status: 200 });

  // One turn: a first round whose last message is the human's, then a second
  // round carrying a tool result back.
  await withUpstream(usage, async () => {
    const first = await worker.fetch(
      completionRequest(CHAT, { 'CF-Connecting-IP': '1.1.1.1' }), env, ctx);
    await first.text();
    const second = await worker.fetch(completionRequest({
      ...CHAT,
      messages: [...CHAT.messages, { role: 'tool', tool_call_id: 'x', content: '{}' }],
    }, { 'CF-Connecting-IP': '1.1.1.1' }), env, ctx);
    await second.text();
    // A different visitor, same day.
    const other = await worker.fetch(
      completionRequest(CHAT, { 'CF-Connecting-IP': '2.2.2.2' }), env, ctx);
    await other.text();
  });
  await settled();

  const [today] = await env.LIMITER.stats();
  assert.equal(today.requests, 3);
  assert.equal(today.turns, 2, 'a tool round continues a turn rather than starting one');
  assert.equal(today.visitors, 2, 'the same IP twice is one visitor');
  assert.equal(today.tokens, 15_000);
  assert.equal(today.refused, 0);
  assert.equal(today.failed, 0);
  // The report is counts only. A visitor hash must never leave the object.
  assert.equal('visitors_capped' in today, true);
  assert.doesNotMatch(JSON.stringify(today), /1\.1\.1\.1|2\.2\.2\.2/,
    'no address, hashed or otherwise, appears in the report');
});

test('a refused request is counted as refused, not as spend', async () => {
  const env = {
    OPENAI_API_KEY: 'sk-shared', LIMITER: fakeLimiters(), TOKENS_PER_MINUTE: '1000',
  };
  await env.LIMITER.charge('ip:9.9.9.9', 1000);
  const { ctx, settled } = context();
  await withUpstream(
    () => { throw new Error('unreachable'); },
    () => worker.fetch(completionRequest(CHAT, { 'CF-Connecting-IP': '9.9.9.9' }), env, ctx),
  );
  await settled();
  const [today] = await env.LIMITER.stats();
  assert.equal(today.requests, 1);
  assert.equal(today.refused, 1);
  assert.equal(today.tokens, 0);
  assert.equal(today.visitors, 1, 'a refused visitor is still a visitor');
});

test('stats need a token, and are answered outside CORS', async () => {
  const env = { LIMITER: fakeLimiters(), STATS_TOKEN: 'operator-token' };
  const statsRequest = headers =>
    worker.fetch(new Request(`${PROXY}/stats`, { headers }), env, context().ctx);

  // No Origin at all, because this is answered for a terminal rather than a page.
  assert.equal((await statsRequest({})).status, 401);
  assert.equal((await statsRequest({ Authorization: 'Bearer wrong' })).status, 401);

  const ok = await statsRequest({ Authorization: 'Bearer operator-token' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), null,
    'no page should ever be able to read the usage history');
  assert.ok(Array.isArray((await ok.json()).days));

  const unconfigured = await worker.fetch(
    new Request(`${PROXY}/stats`, { headers: { Authorization: 'Bearer anything' } }),
    { LIMITER: fakeLimiters() }, context().ctx,
  );
  assert.equal(unconfigured.status, 503);
});

test('the estimate covers the body plus assumed output', () => {
  const cfg = config({ OUTPUT_ESTIMATE: '2000' });
  assert.equal(estimateTokens(4000, cfg), 3000);
});

// ---------------------------------------------------------------------------
// The free OpenRouter upstream
//
// Same Worker, same metering class, a second shared key — reached by path and
// by nothing else. What differs is the unit its windows count: a `:free` model
// costs nothing per token, so what runs out is OpenRouter's request allowance.
// ---------------------------------------------------------------------------

const FREE_MODEL = UPSTREAMS.openrouter.models[0];

const freeRequest = (body, headers = {}) => new Request(
  `${PROXY}/openrouter/v1/chat/completions`,
  {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  },
);

const FREE_CHAT = { ...CHAT, model: FREE_MODEL };

const freeEnv = (extra = {}) => ({
  OPENAI_API_KEY: 'sk-shared',
  OPENROUTER_API_KEY: 'sk-or-shared',
  LIMITER: fakeLimiters(),
  ...extra,
});

const usageStream = (total = 10_000) => new Response(sse(
  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
  `data: {"choices":[],"usage":{"prompt_tokens":${total - 1000},` +
    `"completion_tokens":1000,"total_tokens":${total}}}\n\n`,
  'data: [DONE]\n\n',
), { status: 200 });

test('the path picks the upstream, and the body cannot move a request between them', () => {
  assert.deepEqual(routeFor('/v1/chat/completions'),
    { upstream: UPSTREAMS.openai, endpoint: 'completions' });
  assert.deepEqual(routeFor('/openrouter/v1/chat/completions'),
    { upstream: UPSTREAMS.openrouter, endpoint: 'completions' });
  assert.deepEqual(routeFor('/openrouter/v1/models'),
    { upstream: UPSTREAMS.openrouter, endpoint: 'models' });
  for (const path of ['/', '/v1', '/v1/responses', '/openrouter/chat/completions', '/v1/models/x']) {
    assert.equal(routeFor(path), null, path);
  }
  // Each upstream's allowlist holds only its own models, so naming the other's
  // is refused rather than routed.
  assert.equal(sanitizeBody({ ...CHAT, model: FREE_MODEL }, config({})).ok, false);
  assert.equal(sanitizeBody(CHAT, config({}, 'openrouter')).ok, false);
});

test('only free variants are accepted, so the shared key never reaches a paid one', () => {
  const cfg = config({}, 'openrouter');
  for (const model of cfg.models) {
    assert.match(model, /:free$/, 'a paid id here would spend real money on a shared key');
  }
  // The same model without the suffix routes to paid endpoints, and is refused.
  const paid = sanitizeBody({ ...FREE_CHAT, model: FREE_MODEL.replace(':free', '') }, cfg);
  assert.equal(paid.ok, false);
  assert.match(paid.message, /limited to/);
});

test('the free upstream is sent its own dialect of the same request', () => {
  const cfg = config({}, 'openrouter');
  const { ok, body } = sanitizeBody({
    ...FREE_CHAT,
    stream: false,
    max_tokens: 999_999,
    prompt_cache_key: 'caller-supplied',
    user: 'someone',
  }, cfg);
  assert.equal(ok, true);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  // OpenRouter's spelling of the output ceiling; OpenAI's would bound nothing.
  assert.equal(body.max_tokens, cfg.maxCompletionTokens);
  assert.equal('max_completion_tokens' in body, false);
  // Cache routing is OpenAI's alone, and the caller's attempt is dropped.
  assert.equal('prompt_cache_key' in body, false);
  assert.equal('user' in body, false);
  // A graduated effort is reachable here, unlike the OpenAI path where tools
  // leave only 'none'. Cheap rounds are the point: reasoning is output tokens.
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.parallel_tool_calls, true);
});

test('a free completion is proxied with the OpenRouter key, attributed by the Worker', async () => {
  const env = freeEnv();
  const { ctx, settled } = context();
  const { result, seen } = await withUpstream(() => usageStream(), () => worker.fetch(
    freeRequest(FREE_CHAT, { Authorization: 'Bearer sk-callers-own-key' }), env, ctx,
  ));

  assert.equal(result.status, 200);
  const [call] = seen;
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-or-shared',
    'the OpenAI key must not reach OpenRouter, nor the caller\'s own key either one');
  // Attribution belongs to the Worker: the browser only ever talks to this
  // origin, so its headers would name the wrong thing and widen the preflight.
  assert.equal(call.init.headers['X-Title'], 'GNU Radio World Graham');
  assert.match(call.init.headers['HTTP-Referer'], /gnuradioworld\.com/);
  assert.equal(JSON.parse(call.init.body).model, FREE_MODEL);
  await result.text();
  await settled();
});

test('the free tier is rationed in requests, and the paid budget is untouched', async () => {
  const env = freeEnv();
  const { ctx, settled } = context();
  const { result } = await withUpstream(() => usageStream(10_000), () => worker.fetch(
    freeRequest(FREE_CHAT, { 'CF-Connecting-IP': '9.9.9.9' }), env, ctx,
  ));
  // The header names requests, because that is what this window counts.
  assert.equal(result.headers.get('X-RateLimit-Limit-Requests'),
    String(UPSTREAMS.openrouter.perIp));
  assert.equal(result.headers.get('X-RateLimit-Limit-Tokens'), null);
  await result.text();
  await settled();

  assert.equal(await env.LIMITER.used('or:ip:9.9.9.9'), 1,
    'one request is one unit, exact from the start and settled to nothing');
  assert.equal(await env.LIMITER.used('or:global'), 1);
  // The upstream that costs money never saw any of it.
  assert.equal(await env.LIMITER.used('ip:9.9.9.9'), 0);
  assert.equal(await env.LIMITER.used('user-day:9.9.9.9'), 0);
  assert.equal(await env.LIMITER.used('global'), 0);
  // Tokens are still counted, because the history reports them either way.
  const [today] = await env.LIMITER.stats('or:global');
  assert.equal(today.tokens, 10_000);
  assert.equal(today.requests, 1);
  assert.equal(today.turns, 1);
  assert.deepEqual(await env.LIMITER.stats('global'), [],
    "each upstream's history is its own");
});

test('a spent free allowance refuses without touching the paid one', async () => {
  const env = freeEnv({ OPENROUTER_DAILY_REQUEST_CAP: '2' });
  await env.LIMITER.charge('or:global', 2);
  const { ctx, settled } = context();
  const { result, seen } = await withUpstream(
    () => { throw new Error('a capped request must not reach OpenRouter'); },
    () => worker.fetch(freeRequest(FREE_CHAT, { 'CF-Connecting-IP': '4.4.4.4' }), env, ctx),
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status, 429);
  await settled();
  assert.equal(await env.LIMITER.used('or:ip:4.4.4.4'), 0,
    'nothing was spent upstream, so the visitor keeps their minute');

  // The paid upstream is still open, which is the whole point of separate
  // windows: one free model running out is not the site losing Graham.
  const { result: paid } = await withUpstream(() => usageStream(50), () => worker.fetch(
    completionRequest(CHAT, { 'CF-Connecting-IP': '4.4.4.4' }), env, context().ctx,
  ));
  assert.equal(paid.status, 200);
  await paid.text();
});

test('the free model list is fixed too, and never reaches OpenRouter', async () => {
  const { result, seen } = await withUpstream(
    () => { throw new Error('the model list must not call upstream'); },
    () => worker.fetch(
      new Request(`${PROXY}/openrouter/v1/models`, { headers: { Origin: ORIGIN } }),
      {}, context().ctx,
    ),
  );
  assert.equal(seen.length, 0);
  assert.deepEqual((await result.json()).data.map(model => model.id), [FREE_MODEL]);
});

test('an upstream with no key configured says so, and the other still answers', async () => {
  const env = { OPENAI_API_KEY: 'sk-shared', LIMITER: fakeLimiters() };
  const { ctx } = context();
  const { result, seen } = await withUpstream(
    () => { throw new Error('an unconfigured upstream must not be called'); },
    () => worker.fetch(freeRequest(FREE_CHAT), env, ctx),
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status, 503);

  const { result: paid } = await withUpstream(() => usageStream(50), () => worker.fetch(
    completionRequest(CHAT), env, context().ctx,
  ));
  assert.equal(paid.status, 200);
  await paid.text();
});

test('stats read one upstream at a time, defaulting to the one they always did', async () => {
  const env = freeEnv({ STATS_TOKEN: 'secret' });
  const { ctx, settled } = context();
  await withUpstream(() => usageStream(7000), async () => {
    const response = await worker.fetch(freeRequest(FREE_CHAT), env, ctx);
    await response.text();
  });
  await settled();

  const read = (query) => worker.fetch(new Request(`${PROXY}/stats${query}`, {
    headers: { Authorization: 'Bearer secret' },
  }), env);

  assert.deepEqual((await (await read('')).json()).days, [],
    'the default is the OpenAI upstream, which nothing here charged');
  const free = (await (await read('?upstream=openrouter')).json()).days;
  assert.equal(free.length, 1);
  assert.equal(free[0].tokens, 7000);

  const unknown = await read('?upstream=nowhere');
  assert.equal(unknown.status, 400);
});
