import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  UsageScanner,
  cacheKeyFor,
  config,
  estimateTokens,
  originAllowed,
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
  // The global object's window is aligned to the UTC day, so a charge planted
  // there has to sit on today's boundary or the next roll discards it.
  namespace.charge = (name, used) => object(name).ctx.storage.put('window', {
    windowStart: name === 'global' ? alignedStart(Date.now(), DAY_MS) : Date.now(),
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
  model: 'gpt-5.4-mini',
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

test('the model list is the fixed allowlist and never reaches OpenAI', async () => {
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
  const cfg = config({});
  for (const model of ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.6-luna']) {
    const sanitized = sanitizeBody({ ...CHAT, model }, cfg);
    assert.equal(sanitized.ok, true);
    assert.equal(sanitized.body.model, model);
    assert.equal(sanitized.body.prompt_cache_key, cacheKeyFor(cfg, model));
  }
  // One model's warm prefix is useless to the other, so they never share a key.
  assert.notEqual(cacheKeyFor(cfg, 'gpt-5.4-mini'), cacheKeyFor(cfg, 'gpt-5.4-nano'));
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
  assert.equal(sanitized.body.model, 'gpt-5.4-mini', 'the first listed model is the default');
});

test('a model outside the allowlist is refused, naming every one it accepts', () => {
  const refused = sanitizeBody({ ...CHAT, model: 'gpt-5.4' }, config({}));
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 400);
  assert.match(refused.message,
    /limited to gpt-5\.4-mini, gpt-5\.4-nano and gpt-5\.6-luna/);
  // A one-model deployment must not read "limited to a and ".
  assert.match(sanitizeBody({ ...CHAT, model: 'gpt-5.4' }, config({ MODELS: 'only-one' })).message,
    /limited to only-one\./);
});

test('a request with no messages is refused', () => {
  assert.equal(sanitizeBody({ model: 'gpt-5.4-mini', messages: [] }, config({})).ok, false);
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

test('the global daily cap refuses everyone and refunds the per-IP window', async () => {
  const env = {
    OPENAI_API_KEY: 'sk-shared',
    LIMITER: fakeLimiters(),
    DAILY_TOKEN_CAP: '1000',
  };
  await env.LIMITER.charge('global', 1000);
  const { ctx, settled } = context();
  const { result, seen } = await withUpstream(
    () => { throw new Error('a capped request must not reach OpenAI'); },
    () => worker.fetch(completionRequest(CHAT, { 'CF-Connecting-IP': '5.6.7.8' }), env, ctx),
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status, 429);
  await settled();
  assert.equal(await env.LIMITER.used('ip:5.6.7.8'), 0,
    'nothing was spent upstream, so the visitor keeps their minute');
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
