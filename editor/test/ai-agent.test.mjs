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
const { beginCreditSignIn, signOutCredits } = await bundleModule('../src/ai/credits.ts');
const { javascriptErrors } = await bundleModule('../src/ai/harness.ts');
const {
  AI_PROVIDERS,
  DEFAULT_CREDITS_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_PROVIDER,
  HOSTED_MODEL,
  HOSTED_MODELS,
  HOSTED_OPENROUTER_MODEL,
  HOSTED_OPENROUTER_MODELS,
  ALL_PROVIDER_IDS,
  PROVIDER_IDS,
  ownKeyProviderLabels,
  providerOffered,
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

assert.deepEqual(javascriptErrors([
  "JS Block 'gain_0': Error: [work] Error: boom\n    at Object.work (eval at x, <anonymous>:8:11)",
]), [{
  block: 'gain_0', phase: 'work', message: 'Error: boom',
  source_line: 5, source_column: 11,
  stack: "JS Block 'gain_0': Error: [work] Error: boom\n    at Object.work (eval at x, <anonymous>:8:11)",
}], 'Graham receives a structured JS phase and corrected source location');

// The free shared-key provider leads the list and is what a first-time visitor
// lands on. It is keyless by construction: no key page, no storage slot a key
// could land in, and a fixed short list of models the proxy will accept.
assert.deepEqual(ALL_PROVIDER_IDS, ['hosted', 'hosted-openrouter', 'credits', 'openrouter', 'openai']);
// Both OpenRouter providers are withdrawn for now: their descriptors, storage
// and request path stay described here, but nothing offers them, so they are
// absent from every list the UI builds. Restoring one means emptying
// WITHDRAWN_PROVIDERS, and this assertion is what says so out loud.
assert.deepEqual(PROVIDER_IDS, ['hosted', 'credits', 'openai']);
assert.equal(providerOffered('openrouter'), false);
assert.equal(providerOffered('hosted-openrouter'), false);
assert.equal(providerOffered('hosted'), true);
// The dock names the own-key providers in its copy; withdrawing one must take
// it out of that sentence too rather than pointing at a select entry that is
// no longer there.
assert.deepEqual(ownKeyProviderLabels(), ['OpenAI']);
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
assert.deepEqual(HOSTED_MODELS, ['gpt-5.6-luna']);
assert.equal(HOSTED_MODEL, 'gpt-5.6-luna', 'the first listed model is the default');
assert.equal(AI_PROVIDERS.hosted.defaultModel, HOSTED_MODEL);
// Both free providers run one model, so both pickers lock and each names the
// model it runs in the select — they front the same site and are told apart by
// nothing else.
for (const id of ['hosted', 'hosted-openrouter']) {
  const free = AI_PROVIDERS[id];
  assert.equal(free.fixedModels.length, 1, `${id} locks its picker`);
  assert.match(free.menuLabel, /Free Tier \(/, `${id} names its model in the select`);
  assert.ok(free.menuLabel.includes(free.upstream.label),
    `${id} names the API behind it`);
}
assert.equal(AI_PROVIDERS.hosted.menuLabel, 'OpenAI Free Tier (gpt-5.6-luna)');
assert.equal(AI_PROVIDERS['hosted-openrouter'].menuLabel,
  'OpenRouter Free Tier (nemotron-3-ultra)');
// The four labels have to stay distinct: they are what the connection dialog's
// own provider select shows, and two of them are the same site's proxy. Checked
// over every descriptor, not only the offered ones, so a withdrawn provider
// comes back to a label that is still unique.
assert.equal(new Set(ALL_PROVIDER_IDS.map(id => AI_PROVIDERS[id].label)).size,
  ALL_PROVIDER_IDS.length);
assert.equal(new Set(ALL_PROVIDER_IDS.map(id => AI_PROVIDERS[id].menuLabel)).size,
  ALL_PROVIDER_IDS.length);
assert.equal(AI_PROVIDERS.openrouter.keyless, false);
assert.equal(AI_PROVIDERS.openai.keyless, false);
assert.equal(AI_PROVIDERS.credits.keyless, false);
assert.equal(AI_PROVIDERS.credits.accountAuth, true);
assert.equal(AI_PROVIDERS.credits.storage.key, undefined,
  'the prepaid provider authenticates with a session cookie, never a browser-held key');
assert.deepEqual(AI_PROVIDERS.credits.upstream,
  { label: 'OpenAI', host: 'api.openai.com' },
  'the prepaid provider discloses its direct OpenAI second hop');
// The prepaid catalog is fetched from D1, so the descriptor names no model list
// — but it does name which fetched id a browser with nothing stored opens on.
// An empty default left the picker on its placeholder with Send disabled until
// the user chose, which is not what a first paid turn should ask of anyone.
assert.equal(DEFAULT_CREDITS_MODEL, 'gpt-5.6-luna');
assert.equal(AI_PROVIDERS.credits.defaultModel, DEFAULT_CREDITS_MODEL);
assert.equal(AI_PROVIDERS.credits.fixedModels, undefined,
  'the prepaid model list is fetched, never named here');
// The catalog publishes a price per million tokens per model, which is not the
// comparison someone picking between the two is making; the note is.
assert.deepEqual(AI_PROVIDERS.credits.modelNotes, { 'gpt-5.6-terra': '10x cost of luna' });
assert.equal(AI_PROVIDERS.credits.modelNotes[DEFAULT_CREDITS_MODEL], undefined,
  'the model a note compares against carries no note of its own');

// The second keyless provider is the same proxy on a second shared key. Its
// path is the whole of what selects the OpenRouter upstream, so it is asserted
// rather than assumed, and it stores no key for exactly the same reason.
const freeRouter = AI_PROVIDERS['hosted-openrouter'];
// pr-security-scan: allow new-outbound-host
assert.equal(freeRouter.api, 'https://ai.gnuradioworld.com/openrouter/v1');
assert.equal(freeRouter.keyless, true);
assert.equal(freeRouter.oauth, false);
assert.equal(freeRouter.storage.key, undefined);
assert.equal(freeRouter.storage.sessionKey, undefined);
// Each provider's consent and model live in slots of their own; a free model
// chosen here must not become the paid provider's saved model.
for (const slot of ['consent', 'model']) {
  assert.notEqual(freeRouter.storage[slot], AI_PROVIDERS.hosted.storage[slot]);
}
// Kept in step with OPENROUTER_MODELS in workers/ai-proxy/wrangler.jsonc.
assert.deepEqual(HOSTED_OPENROUTER_MODELS, ['nvidia/nemotron-3-ultra-550b-a55b:free']);
assert.equal(freeRouter.defaultModel, HOSTED_OPENROUTER_MODEL);
assert.deepEqual(freeRouter.fixedModels.map(model => model.id), HOSTED_OPENROUTER_MODELS);
for (const model of HOSTED_OPENROUTER_MODELS) {
  assert.match(model, /:free$/, 'only a :free id stays on the endpoints that cost nothing');
}
// The dock's boundary line and the connection dialog name the second hop, and
// the two keyless providers do not have the same one.
assert.equal(AI_PROVIDERS.hosted.upstream.host, 'api.openai.com');
assert.equal(freeRouter.upstream.host, 'openrouter.ai');
assert.equal(freeRouter.upstream.label, 'OpenRouter');
assert.ok(freeRouter.limitsNote, 'a shared budget has to say how it runs out');
// The proxy attributes the request itself; a header from the browser would
// only widen the preflight to a host that never sees it.
assert.equal(freeRouter.attribution, false);

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
  // A browser still holding a withdrawn provider as its choice comes back on
  // the default rather than on a provider nothing lists.
  storeProvider('openrouter');
  assert.equal(storedProvider(), 'hosted');
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
  listRecordings: async () => [], readRecordingMetadata: async () => ({ recording: {}, metadata: {} }),
  inspectJsBlock: async () => ({}), createJsBlock: async () => ({}),
  setJsBlockSource: async () => ({}), forkJsBlock: async () => ({}),
  exerciseJsBlock: async () => ({}), saveJsBlock: async () => ({}),
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
// /v1/chat/completions rejects function tools alongside any reasoning effort
// above 'none', and an absent field is not 'none' — a model whose own default
// is non-none (gpt-5.6-luna) refused every request the dock made on the user's
// own key until this was pinned, exactly as the proxy pins it for the shared
// one.
assert.equal(openAiBody.reasoning_effort, 'none');
assert.ok(openAiBody.tools.length, 'which is only a constraint because tools are always sent');
// Routes the request at the machine holding this prefix's cache.
assert.match(openAiBody.prompt_cache_key, /^grw-/);
assert.equal(openAiBody.prompt_cache_key, CACHE_KEY);

assert.equal(routerBody.prompt_cache_key, undefined,
  'prompt_cache_key is OpenAI-only');

// ... but only to a model that has reasoning to turn off. The same picker lists
// gpt-4o, which answers "Unrecognized request argument supplied:
// reasoning_effort" rather than reasoning less.
let chatOnlyRequest;
const chatOnlyAgent = new FlowgraphAgent({
  provider: 'openai', key: 'sk-test', model: 'gpt-4o', systemPrompt: 'test', deps,
  fetchImpl: async (url, init) => {
    chatOnlyRequest = { url, init };
    return sse([{ choices: [{ delta: { content: 'Ready.' } }] }]);
  },
});
await chatOnlyAgent.turn('hello');
const chatOnlyBody = JSON.parse(chatOnlyRequest.init.body);
assert.equal(chatOnlyBody.reasoning_effort, undefined);
assert.ok(chatOnlyBody.tools.length, 'the tools go either way');

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

// The prepaid provider uses a credentialed same-site session, its bounded
// /api/chat endpoint, and the server's configured rate catalog.
let creditsRequest;
const creditsAgent = new FlowgraphAgent({
  provider: 'credits', model: 'vendor/model', systemPrompt: 'test', deps,
  fetchImpl: async (url, init) => {
    creditsRequest = { url, init };
    return sse([{
      model: 'vendor/model', choices: [{ delta: { content: 'Paid answer.' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }]);
  },
});
assert.equal((await creditsAgent.turn('hello')).text, 'Paid answer.');
// pr-security-scan: allow new-outbound-host
assert.equal(creditsRequest.url, 'https://credits.gnuradioworld.com/api/chat');
assert.equal(creditsRequest.init.credentials, 'include');
assert.equal(creditsRequest.init.headers.Authorization, undefined);
const creditModels = await listModels({
  provider: 'credits',
  fetchImpl: async (url, init) => {
    // pr-security-scan: allow new-outbound-host
    assert.equal(url, 'https://credits.gnuradioworld.com/api/models');
    assert.equal(init.credentials, 'include');
    return new Response(JSON.stringify({ data: [{
      id: 'vendor/model', name: 'Vendor Model',
      pricing_micros_per_million: { input: 1_500_000, output: 3_000_000 },
    }] }), { status: 200 });
  },
});
assert.deepEqual(creditModels.map(model => model.id), ['vendor/model']);

const realFetch = globalThis.fetch;
let signInRequest;
let assignedSignInUrl = '';
const savedLocation = globalThis.location;
try {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: {
      origin: 'https://gnuradioworld.com', pathname: '/', hash: '#example=test',
      assign: url => { assignedSignInUrl = url; },
    },
  });
  globalThis.fetch = async (url, init) => {
    signInRequest = { url, init };
    return new Response(JSON.stringify({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test', redirect: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await beginCreditSignIn('google');
} finally {
  globalThis.fetch = realFetch;
  if (savedLocation === undefined) delete globalThis.location;
  else Object.defineProperty(globalThis, 'location', { configurable: true, value: savedLocation });
}
assert.equal(signInRequest.url,
  'https://credits.gnuradioworld.com/api/auth/sign-in/social');
assert.deepEqual(JSON.parse(signInRequest.init.body), {
  provider: 'google',
  callbackURL: 'https://gnuradioworld.com/#example=test',
  disableRedirect: true,
});
assert.equal(assignedSignInUrl,
  'https://accounts.google.com/o/oauth2/v2/auth?state=test');

let signOutRequest;
try {
  globalThis.fetch = async (url, init) => {
    signOutRequest = { url, init };
    return new Response(null, { status: 200 });
  };
  await signOutCredits();
} finally {
  globalThis.fetch = realFetch;
}
assert.equal(signOutRequest.url, 'https://credits.gnuradioworld.com/api/auth/sign-out');
assert.equal(signOutRequest.init.method, 'POST');
assert.deepEqual(signOutRequest.init.headers, { 'Content-Type': 'application/json' });
assert.equal(signOutRequest.init.body, '{}');
assert.equal(signOutRequest.init.credentials, 'include');

// The second keyless provider takes the same path, with its own model, its own
// storage, and — like the first — no Authorization header of any kind.
let freeRouterRequest;
const freeRouterAgent = new FlowgraphAgent({
  provider: 'hosted-openrouter', model: HOSTED_OPENROUTER_MODEL, systemPrompt: 'test', deps,
  fetchImpl: async (url, init) => {
    freeRouterRequest = { url, init };
    return sse([{
      model: HOSTED_OPENROUTER_MODEL, choices: [{ delta: { content: 'Ready.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }]);
  },
});
assert.equal((await freeRouterAgent.turn('hello')).text, 'Ready.');
// The path is what routes it to OpenRouter; the browser never talks to
// openrouter.ai on this provider, and holds no key that would let it.
// pr-security-scan: allow new-outbound-host
assert.equal(freeRouterRequest.url, 'https://ai.gnuradioworld.com/openrouter/v1/chat/completions');
assert.equal(freeRouterRequest.init.headers.Authorization, undefined,
  'a keyless provider sends no Authorization header');
assert.equal(freeRouterRequest.init.headers['HTTP-Referer'], undefined,
  'the proxy attributes the request, not the browser');
const freeRouterBody = JSON.parse(freeRouterRequest.init.body);
assert.equal(freeRouterBody.model, HOSTED_OPENROUTER_MODEL);
assert.equal(freeRouterBody.prompt_cache_key, undefined);

const freeRouterModels = await listModels({
  provider: 'hosted-openrouter',
  fetchImpl: () => { throw new Error('a fixed model list must not be fetched'); },
});
assert.deepEqual(freeRouterModels.map(model => model.id), HOSTED_OPENROUTER_MODELS);

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
