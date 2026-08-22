import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';

const {
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
  assert.equal(storedProvider(), 'openrouter', 'OpenRouter stays the default provider');
  storeProvider('openai');
  assert.equal(storedProvider(), 'openai');
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
const fetchImpl = async (_url, init) => {
  const body = JSON.parse(init.body);
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
    toolStarted: name => events.push(`start:${name}`),
    toolFinished: name => events.push(`finish:${name}`),
  },
});
const result = await agent.turn('validate this');
assert.equal(result.text, 'The flowgraph is valid.');
assert.equal(result.rounds, 2);
assert.equal(result.cost, 0.003);
assert.deepEqual(events, ['start:validate', 'finish:validate']);
assert.deepEqual(agent.transcript().map(message => message.role),
  ['system', 'user', 'assistant', 'tool', 'assistant']);

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
const openAiAgent = new FlowgraphAgent({
  provider: 'openai', key: 'sk-test', model: 'gpt-5.4-mini', systemPrompt: 'test', deps,
  fetchImpl: async (url, init) => {
    openAiRequest = { url, init };
    return sse([{
      model: 'gpt-5.4-mini', choices: [{ delta: { content: 'Ready.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }]);
  },
});
const openAiTurn = await openAiAgent.turn('hello');
assert.equal(openAiTurn.text, 'Ready.');
assert.equal(openAiTurn.cost, 0, 'OpenAI prices nothing in its usage event');
// pr-security-scan: allow new-outbound-host
assert.equal(openAiRequest.url, 'https://api.openai.com/v1/chat/completions');
assert.equal(openAiRequest.init.headers.Authorization, 'Bearer sk-test');
assert.equal(openAiRequest.init.headers['HTTP-Referer'], undefined,
  'OpenAI rejects OpenRouter attribution headers in preflight');
const openAiBody = JSON.parse(openAiRequest.init.body);
assert.equal(openAiBody.model, 'gpt-5.4-mini');
assert.deepEqual(openAiBody.stream_options, { include_usage: true });
assert.ok(openAiBody.tools.length, 'the graph tools go to either provider');

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
