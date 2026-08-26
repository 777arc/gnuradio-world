/**
 * The AI providers Graham can talk to. All four speak the OpenAI
 * chat-completions wire format, so only these descriptors and the key storage
 * differ; `client.ts` holds the one request path they share.
 *
 * Two of them are keyless: the project's own proxy fronts one OpenAI key and
 * one OpenRouter key, and which upstream a request reaches is decided by the
 * path in `api` rather than by anything the browser sends.
 */
import type { AiModel } from './client';

export type ProviderId = 'hosted' | 'hosted-openrouter' | 'credits' | 'openrouter' | 'openai';

export interface AiProvider {
  id: ProviderId;
  /** Name shown in the UI and in error messages. */
  label: string;
  /** Text of this provider's entry in the dock's provider select. */
  menuLabel: string;
  /** Bare host, for the dock's data-boundary line. */
  host: string;
  /** OpenAI-compatible API root. */
  api: string;
  defaultModel: string;
  keyPlaceholder: string;
  /** Where a user creates a dedicated, spend-limited key. */
  keysUrl: string;
  /** Dialog text for that link, which is not about a key on the shared proxy. */
  keysLabel: string;
  privacyUrl: string;
  privacyLabel: string;
  /** Dialog copy naming what leaves the browser for this provider. */
  sends: string;
  /** OpenRouter has a browser OAuth flow; an OpenAI key is pasted. */
  oauth: boolean;
  /**
   * Whether this provider needs no key from the user at all. The shared proxy
   * holds one key for everyone, so nothing is stored, no Authorization header
   * is sent, and there is nothing to disconnect — only consent to record.
   */
  keyless: boolean;
  /** Uses the SaaS session cookie rather than a browser-held API key. */
  accountAuth?: boolean;
  /**
   * Keyless only: the API the proxy forwards to on the user's behalf. It is
   * the second hop of a two-hop path, so the dock's boundary line and the
   * connection dialog both name it — the browser talks to `host`, but the
   * prompt ends up here.
   */
  upstream?: { label: string; host: string };
  /**
   * Keyless only: the sentence in the connection dialog saying what bounds a
   * shared budget. The two keyless providers run out in different ways — one
   * against a daily token budget the project pays for, the other against a
   * free tier's request allowance — so neither can state the other's.
   */
  limitsNote?: string;
  /**
   * A fixed model list, where the provider publishes no catalog to fetch.
   * Present means the picker is populated from here and no list is ever
   * requested; it is locked only when the list holds a single model, because
   * then there is genuinely nothing to choose.
   */
  fixedModels?: AiModel[];
  /**
   * Short parenthetical shown beside one model id in the picker, keyed by id.
   * For a catalog fetched at run time it is the only place the UI can say
   * something the catalog itself does not carry — the credits list publishes a
   * price per million tokens, which is not what a user choosing between two
   * models wants to compare. An id with no entry is labelled as before.
   */
  modelNotes?: Record<string, string>;
  /** Whether the final usage event carries a dollar cost. */
  reportsCost: boolean;
  /** Whether the model list is public or has to be read with the key. */
  modelsNeedKey: boolean;
  /** OpenRouter's attribution headers; OpenAI rejects them in preflight. */
  attribution: boolean;
  /** Whether usage has to be requested with `stream_options`. */
  requestUsage: boolean;
  /**
   * Reasoning effort, as OpenAI's top-level `reasoning_effort`, sent only
   * alongside tools and only to a model with a reasoning knob at all
   * (`REASONING_MODEL` in client.ts — gpt-4o and friends reject the field as an
   * unknown argument).
   *
   * `/v1/chat/completions` refuses function tools together with any effort
   * above `'none'` — "Function tools with reasoning_effort are not supported …
   * use /v1/responses or set reasoning_effort to 'none'" — and **unset is not
   * the same as `'none'`**: a model whose own default is non-none, such as
   * gpt-5.6-luna, refuses every tool-carrying request when the field is
   * absent, which is every request this dock makes. So `'none'` here is what
   * makes a reasoning model usable on this path at all, exactly as it is for
   * the shared key in `UPSTREAMS.openai`; anything in between needs the
   * Responses API. OpenRouter nests the same idea under `reasoning`, so
   * nothing is sent there.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Whether to send `prompt_cache_key`, which routes a request to the machine
   * already holding this prefix's cache. OpenAI-only.
   */
  promptCacheKey: boolean;
  storage: {
    /** Absent on a keyless provider: there is no key to put anywhere. */
    key?: string;
    sessionKey?: string;
    consent: string;
    model: string;
  };
}

// All three are disclosed remote API boundaries named in the connection dialog.
// pr-security-scan: allow new-outbound-host
export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
// pr-security-scan: allow new-outbound-host
export const OPENAI_ORIGIN = 'https://api.openai.com';
// The project's own Cloudflare Worker in workers/ai-proxy, which holds one
// OpenAI key for every visitor and meters it per IP.
// pr-security-scan: allow new-outbound-host
export const HOSTED_ORIGIN = 'https://ai.gnuradioworld.com';
// Authenticated prepaid-credit API. Its secrets remain in the Worker. Local
// editor builds use the local Wrangler Worker so OAuth cookies stay same-site.
// pr-security-scan: allow new-outbound-host
export const CREDITS_ORIGIN = typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:8787'
  : 'https://credits.gnuradioworld.com';

export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.7-flash';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
/**
 * The credits catalog is versioned D1 rate rows rather than a list named here,
 * so this is not what the provider offers — only which of the fetched ids a
 * browser with nothing stored starts on, marked `· default` in the picker like
 * any other provider's. It has to be an id with an open rate version, or the
 * picker opens on the placeholder again and `/api/chat` would refuse it.
 */
export const DEFAULT_CREDITS_MODEL = 'gpt-5.6-luna';
/**
 * The models the shared OpenAI key may be used with; the proxy refuses any
 * other by name. Kept in step with `MODELS` in workers/ai-proxy/wrangler.jsonc
 * — the same list in two places, changed together.
 *
 * One model, so the picker locks: every entry here would spend the same token
 * budget anyway, and a second one buys more work per dollar rather than a
 * second allowance. Listed rather than named singly so adding one back is a
 * one-line change on both sides.
 */
export const HOSTED_MODELS = ['gpt-5.6-luna'];
/** The one a browser with nothing stored starts on. */
export const HOSTED_MODEL = HOSTED_MODELS[0];

/**
 * The second keyless provider: the same proxy, forwarding to OpenRouter's free
 * tier on a shared OpenRouter key instead of to OpenAI on a shared OpenAI one.
 * A `:free` suffix is what pins a model to the endpoints that cost nothing, so
 * it is part of the id and not decoration.
 *
 * Kept in step with `OPENROUTER_MODELS` in workers/ai-proxy/wrangler.jsonc,
 * exactly as HOSTED_MODELS is with `MODELS`.
 */
export const HOSTED_OPENROUTER_MODELS = ['nvidia/nemotron-3-ultra-550b-a55b:free'];
export const HOSTED_OPENROUTER_MODEL = HOSTED_OPENROUTER_MODELS[0];

export const AI_PROVIDERS: Record<ProviderId, AiProvider> = {
  hosted: {
    id: 'hosted',
    // Named for the model rather than for the site: both free providers are
    // GNU Radio World's, and what tells them apart is what answers.
    label: 'OpenAI Free Tier',
    menuLabel: 'OpenAI Free Tier (gpt-5.6-luna)',
    host: 'ai.gnuradioworld.com',
    api: `${HOSTED_ORIGIN}/v1`,
    defaultModel: HOSTED_MODEL,
    keyPlaceholder: '',
    // There is no key page to send anyone to, so the link explains the proxy.
    keysUrl: 'https://github.com/777arc/gnuradio-world/blob/main/workers/ai-proxy/README.md',
    keysLabel: 'How the shared models work',
    // The prompt ends up at OpenAI either way, so their data controls apply.
    privacyUrl: 'https://platform.openai.com/docs/guides/your-data',
    privacyLabel: 'OpenAI data controls',
    sends: 'Your prompt, current flowgraph, relevant block metadata, tool results, and console ' +
      "output captured while diagnosing a run. That content goes to GNU Radio World's proxy, " +
      'which forwards it to OpenAI using a key shared by everyone who uses the site. Usage is ' +
      'rate limited per visitor, and a busy day can use the shared budget up.',
    oauth: false,
    keyless: true,
    upstream: { label: 'OpenAI', host: 'api.openai.com' },
    limitsNote: 'Use is limited per visitor and against a daily token budget for the whole ' +
      'site, so a busy day can run it out until it resets at 00:00 UTC.',
    fixedModels: HOSTED_MODELS.map(id => ({
      id,
      name: id,
      contextLength: 0,
      promptPrice: 0,
      completionPrice: 0,
    })),
    reportsCost: false,
    modelsNeedKey: false,
    attribution: false,
    // The proxy sets this itself; asking keeps the header honest either way.
    requestUsage: true,
    // Dropped and replaced by the proxy, which keeps one warm prefix for all
    // visitors rather than one per page.
    promptCacheKey: false,
    storage: {
      consent: 'gnuradio-world.hosted-consent',
      model: 'gnuradio-world.hosted-model',
    },
  },
  'hosted-openrouter': {
    id: 'hosted-openrouter',
    label: 'OpenRouter Free Tier',
    menuLabel: 'OpenRouter Free Tier (nemotron-3-ultra)',
    host: 'ai.gnuradioworld.com',
    // The upstream is chosen by this path, not by anything the browser sends:
    // the proxy holds one key per upstream and routes on the prefix alone.
    api: `${HOSTED_ORIGIN}/openrouter/v1`,
    defaultModel: HOSTED_OPENROUTER_MODEL,
    keyPlaceholder: '',
    keysUrl: 'https://github.com/777arc/gnuradio-world/blob/main/workers/ai-proxy/README.md',
    keysLabel: 'How the shared models work',
    privacyUrl: `${OPENROUTER_ORIGIN}/docs/guides/privacy/data-collection`,
    privacyLabel: 'OpenRouter privacy controls',
    sends: 'Your prompt, current flowgraph, relevant block metadata, tool results, and console ' +
      "output captured while diagnosing a run. That content goes to GNU Radio World's proxy, " +
      'which forwards it to OpenRouter using a key shared by everyone who uses the site, and ' +
      'OpenRouter sends it on to whichever provider serves the free model. Free-tier requests ' +
      'are limited per visitor and for the whole site.',
    oauth: false,
    keyless: true,
    upstream: { label: 'OpenRouter', host: 'openrouter.ai' },
    limitsNote: "It runs on OpenRouter's free tier, which allows the whole site a fixed number " +
      'of requests per day, so a busy day can run it out — and a free endpoint can be busy ' +
      'upstream regardless.',
    fixedModels: HOSTED_OPENROUTER_MODELS.map(id => ({
      id,
      name: id,
      contextLength: 0,
      promptPrice: 0,
      completionPrice: 0,
    })),
    // A free model prices every request at zero, which is a headline saying
    // nothing; tokens are what distinguishes a cheap turn from a wasteful one.
    reportsCost: false,
    modelsNeedKey: false,
    // The proxy attributes the request itself. Sending these from the browser
    // would only widen the preflight to a host that ignores them.
    attribution: false,
    requestUsage: true,
    promptCacheKey: false,
    storage: {
      consent: 'gnuradio-world.hosted-openrouter-consent',
      model: 'gnuradio-world.hosted-openrouter-model',
    },
  },
  credits: {
    id: 'credits',
    label: 'GNU Radio World Credits',
    menuLabel: 'GNU Radio World Credits (prepaid)',
    host: 'credits.gnuradioworld.com',
    api: `${CREDITS_ORIGIN}/api`,
    defaultModel: DEFAULT_CREDITS_MODEL,
    // Both catalog models are priced per million tokens, which says nothing
    // about which one to pick; what distinguishes them is the multiple.
    modelNotes: { 'gpt-5.6-terra': '10x cost of luna' },
    keyPlaceholder: '',
    keysUrl: 'https://github.com/777arc/gnuradio-world/blob/main/workers/saas/README.md',
    keysLabel: 'How prepaid credits work',
    privacyUrl: 'https://platform.openai.com/docs/guides/your-data',
    privacyLabel: 'Model-provider data controls',
    sends: 'Your prompt, current flowgraph, relevant block metadata, tool results, and console ' +
      "output captured while diagnosing a run. GNU Radio World's billing Worker reserves and " +
      'settles prepaid credits, then sends the bounded request to OpenAI. Neither the Polar ' +
      'token nor the upstream provider key is sent to your browser.',
    oauth: false,
    keyless: false,
    accountAuth: true,
    upstream: { label: 'OpenAI', host: 'api.openai.com' },
    reportsCost: false,
    modelsNeedKey: false,
    attribution: false,
    requestUsage: true,
    promptCacheKey: false,
    reasoningEffort: 'none',
    storage: {
      consent: 'gnuradio-world.credits-consent',
      model: 'gnuradio-world.credits-model',
    },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    menuLabel: 'OpenRouter API',
    host: 'openrouter.ai',
    api: `${OPENROUTER_ORIGIN}/api/v1`,
    defaultModel: DEFAULT_OPENROUTER_MODEL,
    keyPlaceholder: 'sk-or-v1-…',
    keysUrl: `${OPENROUTER_ORIGIN}/settings/keys`,
    keysLabel: 'Create a dedicated, limited key',
    privacyUrl: `${OPENROUTER_ORIGIN}/docs/guides/privacy/data-collection`,
    privacyLabel: 'OpenRouter privacy controls',
    sends: 'Your prompt, current flowgraph, relevant block metadata, tool results, and console ' +
      'output captured while diagnosing a run. OpenRouter sends that content—not your OpenRouter ' +
      'key—to the selected model provider.',
    oauth: true,
    keyless: false,
    reportsCost: true,
    modelsNeedKey: false,
    attribution: true,
    requestUsage: false,
    promptCacheKey: false,
    storage: {
      key: 'gnuradio-world.openrouter-key',
      sessionKey: 'gnuradio-world.openrouter-session-key',
      consent: 'gnuradio-world.openrouter-consent',
      model: 'gnuradio-world.openrouter-model',
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    // Spelled out, because what distinguishes it from the free tier above is
    // not the API but whose key pays for it.
    menuLabel: 'OpenAI - Use your own API key',
    host: 'api.openai.com',
    api: `${OPENAI_ORIGIN}/v1`,
    defaultModel: DEFAULT_OPENAI_MODEL,
    keyPlaceholder: 'sk-…',
    // The user's own key page and data controls, linked from the dialog.
    // pr-security-scan: allow new-outbound-host
    keysUrl: 'https://platform.openai.com/api-keys',
    keysLabel: 'Create a dedicated, limited key',
    // pr-security-scan: allow new-outbound-host
    privacyUrl: 'https://platform.openai.com/docs/guides/your-data',
    privacyLabel: 'OpenAI data controls',
    sends: 'Your prompt, current flowgraph, relevant block metadata, tool results, and console ' +
      'output captured while diagnosing a run. OpenAI receives that content together with your ' +
      'OpenAI key, which authenticates the request.',
    oauth: false,
    keyless: false,
    reportsCost: false,
    modelsNeedKey: true,
    attribution: false,
    requestUsage: true,
    // The user's own key on the same endpoint the shared one uses, so it needs
    // the same pin: without it a reasoning model whose default effort is not
    // 'none' refuses every tool-carrying request. See `reasoningEffort`.
    reasoningEffort: 'none',
    promptCacheKey: true,
    storage: {
      key: 'gnuradio-world.openai-key',
      sessionKey: 'gnuradio-world.openai-session-key',
      consent: 'gnuradio-world.openai-consent',
      model: 'gnuradio-world.openai-model',
    },
  },
};

/** Every provider this file describes, in the order they are offered. */
export const ALL_PROVIDER_IDS: ProviderId[] =
  ['hosted', 'hosted-openrouter', 'credits', 'openrouter', 'openai'];

/**
 * Providers temporarily withdrawn from the UI. Their descriptors, key storage,
 * OAuth flow and request path all stay in place — they are simply not offered,
 * so nothing lists them, `storedProvider()` will not return one, and a browser
 * still holding one as its choice falls back to `DEFAULT_PROVIDER`. Emptying
 * this array is the whole of putting one back.
 */
const WITHDRAWN_PROVIDERS: ProviderId[] = ['hosted-openrouter', 'openrouter'];

/** The providers actually offered: every list in the UI is built from this. */
export const PROVIDER_IDS: ProviderId[] =
  ALL_PROVIDER_IDS.filter(id => !WITHDRAWN_PROVIDERS.includes(id));

/** Whether a provider is offered at all, for the paths that can arrive at one. */
export const providerOffered = (id: ProviderId | string): boolean =>
  PROVIDER_IDS.includes(id as ProviderId);

/**
 * The offered providers a user connects with a key of their own, named where
 * the dock has to tell someone what to do about a shared model's limits. Read
 * from the list rather than written out, so withdrawing one cannot leave the
 * copy pointing at a provider that is no longer there.
 */
export const ownKeyProviderLabels = (): string[] =>
  PROVIDER_IDS.filter(id => !AI_PROVIDERS[id].keyless && !AI_PROVIDERS[id].accountAuth)
    .map(id => AI_PROVIDERS[id].label);

/** The provider a browser with nothing stored starts on. */
export const DEFAULT_PROVIDER: ProviderId = 'hosted';

export const providerFor = (id: ProviderId | string): AiProvider =>
  AI_PROVIDERS[(id as ProviderId)] || AI_PROVIDERS[DEFAULT_PROVIDER];

const PROVIDER_STORAGE = 'gnuradio-world.ai-provider';

function storageGet(storage: Storage, key: string): string {
  try { return storage.getItem(key) || ''; } catch { return ''; }
}

function storageSet(storage: Storage, key: string, value: string): void {
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch { /* Private browsing or storage disabled. The in-memory UI still works. */ }
}

export const localGet = (key: string): string => {
  try { return storageGet(localStorage, key); } catch { return ''; }
};
export const localSet = (key: string, value: string): void => {
  try { storageSet(localStorage, key, value); } catch { /* unavailable */ }
};
export const sessionGet = (key: string): string => {
  try { return storageGet(sessionStorage, key); } catch { return ''; }
};
export const sessionSet = (key: string, value: string): void => {
  try { storageSet(sessionStorage, key, value); } catch { /* unavailable */ }
};

/** The provider whose key and model the dock starts on. */
export const storedProvider = (): ProviderId => {
  const saved = localGet(PROVIDER_STORAGE);
  return PROVIDER_IDS.includes(saved as ProviderId) ? saved as ProviderId : DEFAULT_PROVIDER;
};
export const storeProvider = (id: ProviderId): void => localSet(PROVIDER_STORAGE, id);

// A keyless provider has no storage slots at all, so every one of these is a
// no-op there rather than inventing a place a key could accidentally land.
export const storedKey = (id: ProviderId): string => {
  const { storage } = providerFor(id);
  if (!storage.key || !storage.sessionKey) return '';
  return sessionGet(storage.sessionKey) || localGet(storage.key);
};
export const keyIsRemembered = (id: ProviderId): boolean => {
  const { storage } = providerFor(id);
  return !!storage.key && !!localGet(storage.key);
};
export const storeKey = (id: ProviderId, key: string, remember = false): void => {
  const { storage } = providerFor(id);
  if (!storage.key || !storage.sessionKey) return;
  const value = key.trim();
  localSet(storage.key, remember ? value : '');
  sessionSet(storage.sessionKey, remember ? '' : value);
};
export const forgetKey = (id: ProviderId): void => {
  const { storage } = providerFor(id);
  if (!storage.key || !storage.sessionKey) return;
  localSet(storage.key, '');
  sessionSet(storage.sessionKey, '');
};
export const hasConsent = (id: ProviderId): boolean =>
  localGet(providerFor(id).storage.consent) === 'yes';
export const storeConsent = (id: ProviderId): void =>
  localSet(providerFor(id).storage.consent, 'yes');
export const storedModel = (id: ProviderId): string => localGet(providerFor(id).storage.model);
export const storeModel = (id: ProviderId, model: string): void =>
  localSet(providerFor(id).storage.model, model);
