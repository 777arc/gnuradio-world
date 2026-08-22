/**
 * The AI providers Flowgraph Copilot can talk to. All three speak the OpenAI
 * chat-completions wire format, so only these descriptors and the key storage
 * differ; `client.ts` holds the one request path they share.
 */
import type { AiModel } from './client';

export type ProviderId = 'hosted' | 'openrouter' | 'openai';

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
  /**
   * A fixed model list, where the provider offers no choice. Present means the
   * picker is populated from here and locked, and no list is ever fetched.
   */
  fixedModels?: AiModel[];
  /** Whether the final usage event carries a dollar cost. */
  reportsCost: boolean;
  /** Whether the model list is public or has to be read with the key. */
  modelsNeedKey: boolean;
  /** OpenRouter's attribution headers; OpenAI rejects them in preflight. */
  attribution: boolean;
  /** Whether usage has to be requested with `stream_options`. */
  requestUsage: boolean;
  /**
   * Reasoning effort, as OpenAI's top-level `reasoning_effort`.
   *
   * Unset everywhere at the moment, and both providers reject it for their own
   * reason. OpenRouter nests the same idea under `reasoning`. OpenAI accepts
   * the field, but **not together with function tools on
   * `/v1/chat/completions`** — `gpt-5.4-mini` answers "Function tools with
   * reasoning_effort are not supported … use /v1/responses or set
   * reasoning_effort to 'none'". Since every request this dock makes carries
   * the graph tools, the only values reachable from this request path are
   * unset and `'none'`, and anything in between needs the Responses API.
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

export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.7-flash';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
/** The one model the shared key may be used with; the proxy refuses any other. */
export const HOSTED_MODEL = 'gpt-5.4-mini';

export const AI_PROVIDERS: Record<ProviderId, AiProvider> = {
  hosted: {
    id: 'hosted',
    label: 'GNU Radio World',
    menuLabel: 'GNU Radio World (free)',
    host: 'ai.gnuradioworld.com',
    api: `${HOSTED_ORIGIN}/v1`,
    defaultModel: HOSTED_MODEL,
    keyPlaceholder: '',
    // There is no key page to send anyone to, so the link explains the proxy.
    keysUrl: 'https://github.com/777arc/gnuradio-world/blob/main/workers/ai-proxy/README.md',
    keysLabel: 'How the shared model works',
    // The prompt ends up at OpenAI either way, so their data controls apply.
    privacyUrl: 'https://platform.openai.com/docs/guides/your-data',
    privacyLabel: 'OpenAI data controls',
    sends: 'Your prompt, current flowgraph, relevant block metadata, tool results, and console ' +
      "output captured while diagnosing a run. That content goes to GNU Radio World's proxy, " +
      'which forwards it to OpenAI using a key shared by everyone who uses the site. Usage is ' +
      'rate limited per visitor, and a busy day can use the shared budget up.',
    oauth: false,
    keyless: true,
    fixedModels: [{
      id: HOSTED_MODEL,
      name: HOSTED_MODEL,
      contextLength: 0,
      promptPrice: 0,
      completionPrice: 0,
    }],
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
    menuLabel: 'OpenAI API',
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
    promptCacheKey: true,
    storage: {
      key: 'gnuradio-world.openai-key',
      sessionKey: 'gnuradio-world.openai-session-key',
      consent: 'gnuradio-world.openai-consent',
      model: 'gnuradio-world.openai-model',
    },
  },
};

export const PROVIDER_IDS: ProviderId[] = ['hosted', 'openrouter', 'openai'];

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
