import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  UsageScanner,
  config,
  estimateTokens,
  originAllowed,
  sanitizeBody,
} from '../src/index.js';
import { applyReserve, applySettle } from '../src/limiter.js';

const ORIGIN = 'https://gnuradioworld.com';
// pr-security-scan: allow new-outbound-host
const PROXY = 'https://ai.gnuradioworld.com';

/** An in-memory stand-in for the Durable Object namespace, on the real math. */
function fakeLimiters() {
  const slots = new Map();
  const namespace = {
    idFromName: name => ({ name }),
    get(id) {
      if (!slots.has(id.name)) slots.set(id.name, { state: undefined });
      const slot = slots.get(id.name);
      return {
        async fetch(url, init) {
          const payload = JSON.parse(init.body);
          const now = Date.now();
          if (new URL(url).pathname === '/reserve') {
            const applied = applyReserve(slot.state, { now, ...payload });
            slot.state = applied.state;
            return Response.json(applied.result);
          }
          slot.state = applySettle(slot.state, { now, ...payload });
          return Response.json({ ok: true, used: slot.state.used });
        },
      };
    },
  };
  namespace.used = name => slots.get(name)?.state?.used ?? 0;
  namespace.charge = (name, used) => slots.set(name, { state: { windowStart: Date.now(), used } });
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

test('the model list is one fixed id and never reaches OpenAI', async () => {
  const { result, seen } = await withUpstream(
    () => { throw new Error('the model list must not call upstream'); },
    () => worker.fetch(
      new Request(`${PROXY}/v1/models`, { headers: { Origin: ORIGIN } }),
      { MODEL: 'gpt-5.4-mini' }, context().ctx,
    ),
  );
  assert.equal(seen.length, 0);
  const payload = await result.json();
  assert.deepEqual(payload.data.map(model => model.id), ['gpt-5.4-mini']);
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
  assert.equal(body.prompt_cache_key, cfg.cacheKey, 'one shared warm prefix for everyone');
  assert.equal(body.max_completion_tokens, cfg.maxCompletionTokens, 'the output ceiling is ours');
  for (const dropped of ['user', 'store', 'metadata']) {
    assert.equal(dropped in body, false, `${dropped} must not reach the account`);
  }
});

test('a different model is refused by name', () => {
  const refused = sanitizeBody({ ...CHAT, model: 'gpt-5.4' }, config({}));
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 400);
  assert.match(refused.message, /limited to gpt-5\.4-mini/);
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
  assert.equal(env.LIMITER.used('ip:unknown'), 10_000,
    'the estimate is replaced by what the completion actually spent');
  assert.equal(env.LIMITER.used('global'), 10_000);
});

test('a used-up per-IP window answers 429 with a retry and a way forward', async () => {
  const env = {
    OPENAI_API_KEY: 'sk-shared',
    LIMITER: fakeLimiters(),
    TOKENS_PER_MINUTE: '1000',
  };
  env.LIMITER.charge('ip:1.2.3.4', 1000);
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
  env.LIMITER.charge('global', 1000);
  const { ctx, settled } = context();
  const { result, seen } = await withUpstream(
    () => { throw new Error('a capped request must not reach OpenAI'); },
    () => worker.fetch(completionRequest(CHAT, { 'CF-Connecting-IP': '5.6.7.8' }), env, ctx),
  );
  assert.equal(seen.length, 0);
  assert.equal(result.status, 429);
  await settled();
  assert.equal(env.LIMITER.used('ip:5.6.7.8'), 0,
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
  assert.equal(env.LIMITER.used('ip:unknown'), 0);
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
  assert.equal(env.LIMITER.used('ip:unknown'), 0);
  assert.equal(env.LIMITER.used('global'), 0);
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
  assert.ok(env.LIMITER.used('ip:unknown') > 0);
});

test('an unconfigured deployment says so instead of failing upstream', async () => {
  const { ctx } = context();
  const response = await worker.fetch(
    completionRequest(CHAT), { LIMITER: fakeLimiters() }, ctx,
  );
  assert.equal(response.status, 503);
});

test('the estimate covers the body plus assumed output', () => {
  const cfg = config({ OUTPUT_ESTIMATE: '2000' });
  assert.equal(estimateTokens(4000, cfg), 3000);
});
