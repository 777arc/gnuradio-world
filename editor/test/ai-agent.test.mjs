import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';

const {
  CACHE_KEY,
  FlowgraphAgent,
  GRAPH_PREVIEW_DELAY_MS,
  MAX_TOOL_ROUNDS,
} = await bundleModule('../src/ai/agent.ts');
const {
  exchangeOpenRouterCode,
  openRouterAuthorizationUrl,
} = await bundleModule('../src/ai/openrouter.ts');
const { listModels } = await bundleModule('../src/ai/client.ts');
const {
  AI_PROVIDERS,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_PROVIDER,
  HOSTED_MODEL,
  HOSTED_MODELS,
  PROVIDER_IDS,
  forgetKey,
  keyIsRemembered,
  storeKey,
  storeProvider,
  storedKey,
  storedProvider,
} = await bundleModule('../src/ai/providers.ts');

assert.equal(DEFAULT_OPENROUTER_MODEL, 'google/gemini-3.7-flash');
assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-5.4-mini');
// pr-security-scan: allow new-outbound-host
assert.equal(AI_PROVIDERS.openai.api, 'https://api.openai.com/v1');
assert.equal(AI_PROVIDERS.openai.oauth, false, 'an OpenAI key is pasted, never OAuth');
assert.notEqual(AI_PROVIDERS.openai.storage.key, AI_PROVIDERS.openrouter.storage.key,
  'each provider keeps its own key');
assert.equal(GRAPH_PREVIEW_DELAY_MS, 1000);

// The free shared-key provider leads the list and is what a first-time visitor
// lands on. It is keyless by construction: no key page, no storage slot a key
// could land in, and a fixed short list of models the proxy will accept.
assert.deepEqual(PROVIDER_IDS, ['hosted', 'openrouter', 'openai']);
assert.equal(DEFAULT_PROVIDER, 'hosted');
// pr-security-scan: allow new-outbound-host
assert.equal(AI_PROVIDERS.hosted.api, 'https://ai.gnuradioworld.com/v1');
assert.equal(AI_PROVIDERS.hosted.keyless, true);
assert.equal(AI_PROVIDERS.hosted.oauth, false);
assert.equal(AI_PROVIDERS.hosted.storage.key, undefined,
  'a keyless provider has nowhere to put a key');
assert.equal(AI_PROVIDERS.hosted.storage.sessionKey, undefined);
assert.deepEqual(AI_PROVIDERS.hosted.fixedModels.map(model => model.id), HOSTED_MODELS);
// Kept in step with MODELS in workers/ai-proxy/wrangler.jsonc; the proxy
// refuses anything outside this list by name.
assert.deepEqual(HOSTED_MODELS, ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.6-luna']);
assert.equal(HOSTED_MODEL, 'gpt-5.4-mini', 'the first listed model is the default');
assert.equal(AI_PROVIDERS.hosted.defaultModel, HOSTED_MODEL);
assert.equal(AI_PROVIDERS.openrouter.keyless, false);
assert.equal(AI_PROVIDERS.openai.keyless, false);

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
};
const savedLocalStorage = globalThis.localStorage;
const savedSessionStorage = globalThis.sessionStorage;
try {
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage(), configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: memoryStorage(), configurable: true, writable: true,
  });
  storeKey('openrouter', 'session-key');
  assert.equal(storedKey('openrouter'), 'session-key');
  assert.equal(keyIsRemembered('openrouter'), false, 'keys are session-only by default');
  storeKey('openrouter', 'remembered-key', true);
  assert.equal(storedKey('openrouter'), 'remembered-key');
  assert.equal(keyIsRemembered('openrouter'), true);
  // The two providers' keys never see each other.
  storeKey('openai', 'openai-key', true);
  assert.equal(storedKey('openai'), 'openai-key');
  assert.equal(storedKey('openrouter'), 'remembered-key');
  forgetKey('openrouter');
  assert.equal(storedKey('openrouter'), '');
  assert.equal(storedKey('openai'), 'openai-key');
  forgetKey('openai');
  assert.equal(storedKey('openai'), '');
  assert.equal(storedProvider(), 'hosted', 'the free shared model is the default');
  storeProvider('openai');
  assert.equal(storedProvider(), 'openai');
  // Storing a key against the keyless provider must be a no-op rather than
  // finding some slot to write it to.
  storeKey('hosted', 'sk-should-never-be-stored', true);
  assert.equal(storedKey('hosted'), '');
  assert.equal(keyIsRemembered('hosted'), false);
  forgetKey('hosted');
} finally {
  Object.defineProperty(globalThis, 'localStorage', {
    value: savedLocalStorage, configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: savedSessionStorage, configurable: true, writable: true,
  });
}

const authUrl = new URL(openRouterAuthorizationUrl('https://example.com/callback', 'challenge'));
assert.equal(authUrl.protocol, 'https:');
assert.equal(authUrl.hostname, 'openrouter.ai');
assert.equal(authUrl.pathname, '/auth');
assert.equal(authUrl.searchParams.get('callback_url'), 'https://example.com/callback');
assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
let exchangeRequest;
assert.equal(await exchangeOpenRouterCode('one-time-code', 'verifier', async (url, init) => {
  exchangeRequest = { url, init };
  return new Response(JSON.stringify({ key: 'oauth-key' }), { status: 200 });
}), 'oauth-key');
assert.doesNotMatch(exchangeRequest.url, /one-time-code|oauth-key/,
  'OAuth secrets stay out of the request URL');
assert.deepEqual(JSON.parse(exchangeRequest.init.body), {
  code: 'one-time-code', code_verifier: 'verifier', code_challenge_method: 'S256',
});

const sse = chunks => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
  'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });

const deps = {
  blocks: () => [], connections: () => [], entries: () => [],
  definition: () => undefined, ports: () => [], validate: () => [],
  addBlock() { throw new Error('unused'); }, removeBlock() {}, setParams() {},
  connect() {}, disconnect() {}, setEnabled() {}, autoArrange() {}, replaceFlowgraph() {},
  listExamples: async () => [], readExample: async () => '',
  runFlowgraph: async () => ({ started: true }),
};

let request = 0;
let routerBody;
const fetchImpl = async (_url, init) => {
  const body = routerBody = JSON.parse(init.body);
  request++;
  if (request === 1) {
    assert.equal(body.messages.at(-1).role, 'user');
    return sse([{
      model: 'stub/model', choices: [{ delta: { tool_calls: [{
        index: 0, id: 'call_1', type: 'function',
        function: { name: 'validate', arguments: '{}' },
      }] } }], usage: { cost: 0.001 },
    }]);
  }
  assert.equal(body.messages.at(-1).role, 'tool');
  return sse([{
    model: 'stub/model', choices: [{ delta: { content: 'The flowgraph is valid.' } }],
    usage: { cost: 0.002 },
  }]);
};

const events = [];
const agent = new FlowgraphAgent({
  provider: 'openrouter', key: 'test', model: 'stub/model', systemPrompt: 'test', deps, fetchImpl,
  hooks: {
    assistantStarted: () => events.push('assistant'),
    toolStarted: name => events.push(`start:${name}`),
    toolFinished: name => events.push(`finish:${name}`),
  },
});
const result = await agent.turn('validate this');
assert.equal(result.text, 'The flowgraph is valid.');
assert.equal(result.rounds, 2);
assert.equal(result.cost, 0.003);
// One assistant segment per round, opened before that round's tool calls: the
// panel hangs each round's prose below the tools it followed, and can only do
// that if every round is announced.
assert.deepEqual(events, ['assistant', 'start:validate', 'finish:validate', 'assistant']);
assert.deepEqual(agent.transcript().map(message => message.role),
  ['system', 'user', 'assistant', 'tool', 'assistant']);

// The header's hover breakdown counts requests, and one round is one request.
// Counted where the request is issued, so a round that dies mid-stream — which
// still spent a round-trip and, on the shared proxy, still spent budget —
// counts exactly like one that returned usage.
let issued = 0;
let failingRequest = 0;
const failingAgent = new FlowgraphAgent({
  provider: 'openrouter', key: 'test', model: 'stub/model', systemPrompt: 'test', deps,
  hooks: { requestStarted: () => { issued++; } },
  fetchImpl: async () => {
    failingRequest++;
    if (failingRequest === 1) {
      return sse([{ model: 'stub/model', choices: [{ delta: { tool_calls: [{
        index: 0, id: 'call_1', type: 'function',
        function: { name: 'validate', arguments: '{}' },
      }] } }] }]);
    }
    return sse([{ error: { message: 'upstream fell over' } }]);
  },
});
await assert.rejects(failingAgent.turn('validate this'), /upstream fell over/);
assert.equal(issued, 2, 'a request that failed mid-stream still cost a round-trip');

let editTime = 0;
let runTime = 0;
let previewRequest = 0;
const previewDeps = {
  ...deps,
  addBlock(id, name) {
    editTime = performance.now();
    return {
      uid: 'preview-block', id, name: name || 'preview', x: 0, y: 0,
      params: {}, enabled: true, bypassed: false, rotation: 0,
    };
  },
  runFlowgraph: async () => {
    runTime = performance.now();
    return { started: true };
  },
};
const previewAgent = new FlowgraphAgent({
  provider: 'openrouter', key: 'test', model: 'stub/model', systemPrompt: 'test', deps: previewDeps,
  graphPreviewDelayMs: 30,
  fetchImpl: async () => {
    previewRequest++;
    return previewRequest === 1
      ? sse([{ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'edit', type: 'function',
          function: { name: 'add_block', arguments: '{"id":"source","name":"preview"}' } },
        { index: 1, id: 'run', type: 'function',
          function: { name: 'run_flowgraph', arguments: '{"seconds":0.5}' } },
      ] } }] }])
      : sse([{ choices: [{ delta: { content: 'Changed and ran it.' } }] }]);
  },
});
await previewAgent.turn('change and run');
assert.ok(runTime - editTime >= 25,
  `the run must wait after a visible edit (${(runTime - editTime).toFixed(1)}ms observed)`);

let loops = 0;
const looping = new FlowgraphAgent({
  provider: 'openrouter', key: 'test', model: 'stub/model', systemPrompt: 'test', deps,
  fetchImpl: async () => {
    loops++;
    return sse([{ choices: [{ delta: { tool_calls: [{
      index: 0, id: `loop_${loops}`, type: 'function',
      function: { name: 'validate', arguments: '{}' },
    }] } }] }]);
  },
});
const capped = await looping.turn('loop');
assert.equal(loops, MAX_TOOL_ROUNDS);
assert.match(capped.text, /Stopped after 50 tool rounds/);

// The OpenAI provider reaches OpenAI's own endpoint with the same OpenAI-format
// body, no OpenRouter attribution headers, and an explicit request for usage.
let openAiRequest;
let openAiUsage;
const openAiAgent = new FlowgraphAgent({
  provider: 'openai', key: 'sk-test', model: 'gpt-5.4-mini', systemPrompt: 'test', deps,
  hooks: { usage: used => { openAiUsage = used; } },
  fetchImpl: async (url, init) => {
    openAiRequest = { url, init };
    return sse([{
      model: 'gpt-5.4-mini', choices: [{ delta: { content: 'Ready.' } }],
      usage: {
        prompt_tokens: 12, completion_tokens: 5, total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 9 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    }]);
  },
});
const openAiTurn = await openAiAgent.turn('hello');
assert.equal(openAiTurn.text, 'Ready.');
assert.equal(openAiTurn.cost, 0, 'OpenAI prices nothing in its usage event');
// A single token total cannot separate cheap cached input from full-price fresh
// input from output spent reasoning, and both providers nest those a level down.
assert.equal(openAiUsage.cached_tokens, 9);
assert.equal(openAiUsage.reasoning_tokens, 4);
assert.equal(openAiUsage.prompt_tokens, 12);
assert.equal(openAiUsage.completion_tokens, 5);
// pr-security-scan: allow new-outbound-host
assert.equal(openAiRequest.url, 'https://api.openai.com/v1/chat/completions');
assert.equal(openAiRequest.init.headers.Authorization, 'Bearer sk-test');
assert.equal(openAiRequest.init.headers['HTTP-Referer'], undefined,
  'OpenAI rejects OpenRouter attribution headers in preflight');
const openAiBody = JSON.parse(openAiRequest.init.body);
assert.equal(openAiBody.model, 'gpt-5.4-mini');
assert.deepEqual(openAiBody.stream_options, { include_usage: true });
assert.ok(openAiBody.tools.length, 'the graph tools go to either provider');
// A turn's cost is set by its round count, because every round resends the
// whole transcript — so independent calls are asked for in one round rather
// than left to whatever the model or the routed provider defaults to.
assert.equal(openAiBody.parallel_tool_calls, true);
assert.equal(routerBody.parallel_tool_calls, true);
// gpt-5.4-mini rejects reasoning_effort alongside function tools on
// /v1/chat/completions unless it is 'none', and every request here carries the
// graph tools, so the field stays unset on this path.
assert.equal(openAiBody.reasoning_effort, undefined);
assert.ok(openAiBody.tools.length, 'which is only a constraint because tools are always sent');
// Routes the request at the machine holding this prefix's cache.
assert.match(openAiBody.prompt_cache_key, /^grw-/);
assert.equal(openAiBody.prompt_cache_key, CACHE_KEY);

assert.equal(routerBody.prompt_cache_key, undefined,
  'prompt_cache_key is OpenAI-only');

// The shared proxy takes no key, so the request must carry no Authorization
// header at all — there is nothing of the user's to send, and the proxy holds
// the only key involved.
let hostedRequest;
const hostedAgent = new FlowgraphAgent({
  provider: 'hosted', model: HOSTED_MODEL, systemPrompt: 'test', deps,
  fetchImpl: async (url, init) => {
    hostedRequest = { url, init };
    return sse([{
      model: HOSTED_MODEL, choices: [{ delta: { content: 'Ready.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }]);
  },
});
assert.equal((await hostedAgent.turn('hello')).text, 'Ready.');
// pr-security-scan: allow new-outbound-host
assert.equal(hostedRequest.url, 'https://ai.gnuradioworld.com/v1/chat/completions');
assert.equal(hostedRequest.init.headers.Authorization, undefined,
  'a keyless provider sends no Authorization header');
assert.equal(hostedRequest.init.headers['HTTP-Referer'], undefined);
const hostedBody = JSON.parse(hostedRequest.init.body);
assert.equal(hostedBody.model, HOSTED_MODEL);
assert.deepEqual(hostedBody.stream_options, { include_usage: true });
assert.equal(hostedBody.prompt_cache_key, undefined,
  'the proxy sets one shared cache key for every visitor');

// The one model comes from the descriptor; the picker never fetches a list.
const hostedModels = await listModels({
  provider: 'hosted',
  fetchImpl: () => { throw new Error('a fixed model list must not be fetched'); },
});
assert.deepEqual(hostedModels.map(model => model.id), HOSTED_MODELS);

// OpenAI's model list has no capability flags, so the chat families are picked
// out of every model the account can see.
const openAiModels = await listModels({
  provider: 'openai', key: 'sk-test',
  fetchImpl: async (url, init) => {
    // pr-security-scan: allow new-outbound-host
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(init.headers.Authorization, 'Bearer sk-test');
    return new Response(JSON.stringify({ data: [
      { id: 'gpt-5.4-mini' }, { id: 'gpt-4o-audio-preview' }, { id: 'o3' },
      { id: 'text-embedding-3-large' }, { id: 'dall-e-3' }, { id: 'whisper-1' },
      { id: 'gpt-3.5-turbo-instruct' }, { id: 'omni-moderation-latest' },
    ] }), { status: 200 });
  },
});
assert.deepEqual(openAiModels.map(model => model.id), ['gpt-5.4-mini', 'o3']);
assert.equal(openAiModels[0].contextLength, 0, 'OpenAI publishes no context length');

// OpenRouter keeps its public, tool-filtered list.
const routerModels = await listModels({
  provider: 'openrouter',
  fetchImpl: async url => {
    assert.match(url, /^https:\/\/openrouter\.ai\/api\/v1\/models\?/);
    return new Response(JSON.stringify({ data: [
      { id: 'a/b', name: 'A B', context_length: 128000, supported_parameters: ['tools'] },
      { id: 'c/d', name: 'C D', context_length: 8000, supported_parameters: [] },
    ] }), { status: 200 });
  },
});
assert.deepEqual(routerModels.map(model => model.id), ['a/b']);

console.log('ai-agent.test.mjs: ok');
