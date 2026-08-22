/**
 * The AI providers Flowgraph Copilot can talk to. Both speak the OpenAI
 * chat-completions wire format, so only these descriptors and the key storage
 * differ; `client.ts` holds the one request path they share.
 */

export type ProviderId = 'openrouter' | 'openai';

export interface AiProvider {
  id: ProviderId;
  /** Name shown in the UI and in error messages. */
  label: string;
  /** Bare host, for the dock's data-boundary line. */
  host: string;
  /** OpenAI-compatible API root. */
  api: string;
  defaultModel: string;
  keyPlaceholder: string;
  /** Where a user creates a dedicated, spend-limited key. */
  keysUrl: string;
  privacyUrl: string;
  privacyLabel: string;
  /** Dialog copy naming what leaves the browser for this provider. */
  sends: string;
  /** OpenRouter has a browser OAuth flow; an OpenAI key is pasted. */
  oauth: boolean;
  /** Whether the final usage event carries a dollar cost. */
  reportsCost: boolean;
  /** Whether the model list is public or has to be read with the key. */
  modelsNeedKey: boolean;
  /** OpenRouter's attribution headers; OpenAI rejects them in preflight. */
  attribution: boolean;
  /** Whether usage has to be requested with `stream_options`. */
  requestUsage: boolean;
  storage: {
    key: string;
    sessionKey: string;
    consent: string;
    model: string;
  };
}

// Both are disclosed remote API boundaries named in the connection dialog.
// pr-security-scan: allow new-outbound-host
export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
// pr-security-scan: allow new-outbound-host
export const OPENAI_ORIGIN = 'https://api.openai.com';

export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.7-flash';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';

export const AI_PROVIDERS: Record<ProviderId, AiProvider> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    host: 'openrouter.ai',
    api: `${OPENROUTER_ORIGIN}/api/v1`,
    defaultModel: DEFAULT_OPENROUTER_MODEL,
    keyPlaceholder: 'sk-or-v1-…',
    keysUrl: `${OPENROUTER_ORIGIN}/settings/keys`,
    privacyUrl: `${OPENROUTER_ORIGIN}/docs/guides/privacy/data-collection`,
    privacyLabel: 'OpenRouter privacy controls',
    sends: 'Your prompt, current flowgraph, relevant block metadata, tool results, and console ' +
      'output captured while diagnosing a run. OpenRouter sends that content—not your OpenRouter ' +
      'key—to the selected model provider.',
    oauth: true,
    reportsCost: true,
    modelsNeedKey: false,
    attribution: true,
    requestUsage: false,
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
    host: 'api.openai.com',
    api: `${OPENAI_ORIGIN}/v1`,
    defaultModel: DEFAULT_OPENAI_MODEL,
    keyPlaceholder: 'sk-…',
    // The user's own key page and data controls, linked from the dialog.
    // pr-security-scan: allow new-outbound-host
    keysUrl: 'https://platform.openai.com/api-keys',
    // pr-security-scan: allow new-outbound-host
    privacyUrl: 'https://platform.openai.com/docs/guides/your-data',
    privacyLabel: 'OpenAI data controls',
    sends: 'Your prompt, current flowgraph, relevant block metadata, tool results, and console ' +
      'output captured while diagnosing a run. OpenAI receives that content together with your ' +
      'OpenAI key, which authenticates the request.',
    oauth: false,
    reportsCost: false,
    modelsNeedKey: true,
    attribution: false,
    requestUsage: true,
    storage: {
      key: 'gnuradio-world.openai-key',
      sessionKey: 'gnuradio-world.openai-session-key',
      consent: 'gnuradio-world.openai-consent',
      model: 'gnuradio-world.openai-model',
    },
  },
};

export const PROVIDER_IDS: ProviderId[] = ['openrouter', 'openai'];

export const providerFor = (id: ProviderId | string): AiProvider =>
  AI_PROVIDERS[(id as ProviderId)] || AI_PROVIDERS.openrouter;

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
  return PROVIDER_IDS.includes(saved as ProviderId) ? saved as ProviderId : 'openrouter';
};
export const storeProvider = (id: ProviderId): void => localSet(PROVIDER_STORAGE, id);

export const storedKey = (id: ProviderId): string => {
  const { storage } = providerFor(id);
  return sessionGet(storage.sessionKey) || localGet(storage.key);
};
export const keyIsRemembered = (id: ProviderId): boolean => !!localGet(providerFor(id).storage.key);
export const storeKey = (id: ProviderId, key: string, remember = false): void => {
  const { storage } = providerFor(id);
  const value = key.trim();
  localSet(storage.key, remember ? value : '');
  sessionSet(storage.sessionKey, remember ? '' : value);
};
export const forgetKey = (id: ProviderId): void => {
  const { storage } = providerFor(id);
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
