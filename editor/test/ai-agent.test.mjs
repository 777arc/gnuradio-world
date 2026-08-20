import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';

const {
  FlowgraphAgent,
  GRAPH_PREVIEW_DELAY_MS,
  MAX_TOOL_ROUNDS,
} = await bundleModule('../src/ai/agent.ts');
const {
  DEFAULT_OPENROUTER_MODEL,
  exchangeOpenRouterCode,
  forgetKey,
  keyIsRemembered,
  openRouterAuthorizationUrl,
  storeKey,
  storedKey,
} = await bundleModule('../src/ai/openrouter.ts');

assert.equal(DEFAULT_OPENROUTER_MODEL, 'google/gemini-3.7-flash');
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
  storeKey('session-key');
  assert.equal(storedKey(), 'session-key');
  assert.equal(keyIsRemembered(), false, 'keys are session-only by default');
  storeKey('remembered-key', true);
  assert.equal(storedKey(), 'remembered-key');
  assert.equal(keyIsRemembered(), true);
  forgetKey();
  assert.equal(storedKey(), '');
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
  key: 'test', model: 'stub/model', systemPrompt: 'test', deps, fetchImpl,
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
  key: 'test', model: 'stub/model', systemPrompt: 'test', deps: previewDeps,
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
  key: 'test', model: 'stub/model', systemPrompt: 'test', deps,
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

console.log('ai-agent.test.mjs: ok');
