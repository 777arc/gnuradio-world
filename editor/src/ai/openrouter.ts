export const OPENROUTER_KEY_STORAGE = 'gnuradio-world.openrouter-key';
export const OPENROUTER_SESSION_KEY_STORAGE = 'gnuradio-world.openrouter-session-key';
export const OPENROUTER_CONSENT_STORAGE = 'gnuradio-world.openrouter-consent';
export const OPENROUTER_MODEL_STORAGE = 'gnuradio-world.openrouter-model';
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.7-flash';

const OAUTH_MARKER = 'gr_openrouter';
const OAUTH_VERIFIER_STORAGE = 'gnuradio-world.openrouter-oauth-verifier';
const OAUTH_REMEMBER_STORAGE = 'gnuradio-world.openrouter-oauth-remember';
const OAUTH_GRAPH_STORAGE = 'gnuradio-world.openrouter-oauth-graph';
const OAUTH_HASH_STORAGE = 'gnuradio-world.openrouter-oauth-hash';

// The copilot is explicitly bring-your-own-key and its consent dialog names
// this sole remote API boundary. pr-security-scan: allow new-outbound-host
const OPENROUTER_ORIGIN = 'https://openrouter.ai';
const API = `${OPENROUTER_ORIGIN}/api/v1`;

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  completionPrice: number;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface CompletionResult {
  message: ChatMessage;
  usage?: OpenRouterUsage;
  model?: string;
}

function storageGet(storage: Storage, key: string): string {
  try { return storage.getItem(key) || ''; } catch { return ''; }
}

function storageSet(storage: Storage, key: string, value: string): void {
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch { /* Private browsing or storage disabled. The in-memory UI still works. */ }
}

const localGet = (key: string): string => {
  try { return storageGet(localStorage, key); } catch { return ''; }
};
const localSet = (key: string, value: string): void => {
  try { storageSet(localStorage, key, value); } catch { /* unavailable */ }
};
const sessionGet = (key: string): string => {
  try { return storageGet(sessionStorage, key); } catch { return ''; }
};
const sessionSet = (key: string, value: string): void => {
  try { storageSet(sessionStorage, key, value); } catch { /* unavailable */ }
};

export const storedKey = (): string =>
  sessionGet(OPENROUTER_SESSION_KEY_STORAGE) || localGet(OPENROUTER_KEY_STORAGE);
export const keyIsRemembered = (): boolean => !!localGet(OPENROUTER_KEY_STORAGE);
export const storeKey = (key: string, remember = false): void => {
  const value = key.trim();
  localSet(OPENROUTER_KEY_STORAGE, remember ? value : '');
  sessionSet(OPENROUTER_SESSION_KEY_STORAGE, remember ? '' : value);
};
export const forgetKey = (): void => {
  localSet(OPENROUTER_KEY_STORAGE, '');
  sessionSet(OPENROUTER_SESSION_KEY_STORAGE, '');
};
export const hasConsent = (): boolean => localGet(OPENROUTER_CONSENT_STORAGE) === 'yes';
export const storeConsent = (): void => localSet(OPENROUTER_CONSENT_STORAGE, 'yes');
export const storedModel = (): string => localGet(OPENROUTER_MODEL_STORAGE);
export const storeModel = (model: string): void => localSet(OPENROUTER_MODEL_STORAGE, model);

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function openRouterAuthorizationUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(`${OPENROUTER_ORIGIN}/auth`);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Starts OpenRouter's browser OAuth flow while keeping the canvas recoverable. */
export async function beginOpenRouterOAuth(graphState: string, remember: boolean): Promise<void> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  const callback = new URL(location.href);
  callback.searchParams.delete('code');
  callback.searchParams.set(OAUTH_MARKER, '1');
  callback.hash = '';
  sessionSet(OAUTH_VERIFIER_STORAGE, verifier);
  sessionSet(OAUTH_REMEMBER_STORAGE, remember ? 'yes' : 'no');
  sessionSet(OAUTH_GRAPH_STORAGE, graphState);
  sessionSet(OAUTH_HASH_STORAGE, location.hash);
  if (sessionGet(OAUTH_VERIFIER_STORAGE) !== verifier ||
      sessionGet(OAUTH_GRAPH_STORAGE) !== graphState) {
    for (const key of [OAUTH_VERIFIER_STORAGE, OAUTH_REMEMBER_STORAGE,
      OAUTH_GRAPH_STORAGE, OAUTH_HASH_STORAGE]) sessionSet(key, '');
    throw new Error('OpenRouter connection needs session storage; paste a key instead');
  }
  location.assign(openRouterAuthorizationUrl(callback.toString(), challenge));
}

export interface OpenRouterOAuthReturn {
  code: string;
  verifier: string;
  remember: boolean;
  graphState: string;
}

/** Reads and removes a one-time OAuth return, restoring the pre-redirect URL. */
export function takeOpenRouterOAuthReturn(): OpenRouterOAuthReturn | null {
  if (typeof location === 'undefined') return null;
  const url = new URL(location.href);
  if (url.searchParams.get(OAUTH_MARKER) !== '1') return null;
  const result = {
    code: url.searchParams.get('code') || '',
    verifier: sessionGet(OAUTH_VERIFIER_STORAGE),
    remember: sessionGet(OAUTH_REMEMBER_STORAGE) === 'yes',
    graphState: sessionGet(OAUTH_GRAPH_STORAGE),
  };
  const originalHash = sessionGet(OAUTH_HASH_STORAGE);
  for (const key of [OAUTH_VERIFIER_STORAGE, OAUTH_REMEMBER_STORAGE,
    OAUTH_GRAPH_STORAGE, OAUTH_HASH_STORAGE]) sessionSet(key, '');
  url.searchParams.delete('code');
  url.searchParams.delete(OAUTH_MARKER);
  url.hash = originalHash;
  history.replaceState(null, '', url);
  return result;
}

export async function exchangeOpenRouterCode(
  code: string, verifier: string, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${API}/auth/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...attributionHeaders() },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256',
    }),
  });
  if (!response.ok) throw apiError(response.status, await response.text());
  const payload = await response.json();
  const key = String(payload?.key || '').trim();
  if (!key) throw new Error('OpenRouter did not return an API key');
  return key;
}

const attributionHeaders = (): Record<string, string> => ({
  'HTTP-Referer': typeof location === 'undefined'
    ? 'http://localhost/'
    : location.origin + location.pathname,
  'X-Title': 'GNU Radio World Flowgraph Copilot',
});

export async function listModels(signal?: AbortSignal): Promise<OpenRouterModel[]> {
  const response = await fetch(`${API}/models?supported_parameters=tools`, {
    headers: attributionHeaders(), signal,
  });
  if (!response.ok) throw new Error(`OpenRouter model list failed (${response.status})`);
  const payload = await response.json();
  return (Array.isArray(payload?.data) ? payload.data : [])
    .filter((model: any) => Array.isArray(model.supported_parameters) &&
      model.supported_parameters.includes('tools'))
    .map((model: any) => ({
      id: String(model.id),
      name: String(model.name || model.id),
      contextLength: Number(model.context_length || 0),
      promptPrice: Number(model.pricing?.prompt || 0),
      completionPrice: Number(model.pricing?.completion || 0),
    }));
}

function apiError(status: number, body: string): Error {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.message;
    if (message) return new Error(`OpenRouter: ${message}`);
  } catch { /* return the status below */ }
  return new Error(`OpenRouter request failed (${status})`);
}

/**
 * Streams one OpenAI-compatible chat completion. Tool argument fragments are
 * accumulated by index; text is surfaced immediately for the transcript.
 */
export async function chatCompletion(options: {
  key: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<CompletionResult> {
  const fetcher = options.fetchImpl || fetch;
  const response = await fetcher(`${API}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.key}`,
      'Content-Type': 'application/json',
      ...attributionHeaders(),
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      stream: true,
    }),
    signal: options.signal,
  });
  if (!response.ok) throw apiError(response.status, await response.text());
  if (!response.body) throw new Error('OpenRouter returned no response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let usage: OpenRouterUsage | undefined;
  let model: string | undefined;
  const calls = new Map<number, ChatToolCall>();

  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    let chunk: any;
    try { chunk = JSON.parse(value); } catch { return; }
    if (chunk.error) throw new Error(`OpenRouter: ${chunk.error.message || 'stream failed'}`);
    if (chunk.usage) usage = chunk.usage;
    if (chunk.model) model = String(chunk.model);
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string') {
      content += delta.content;
      options.onText?.(delta.content);
    }
    for (const fragment of delta.tool_calls || []) {
      const index = Number(fragment.index || 0);
      const call = calls.get(index) || {
        id: '', type: 'function' as const,
        function: { name: '', arguments: '' },
      };
      if (fragment.id) call.id = String(fragment.id);
      if (fragment.function?.name) call.function.name += String(fragment.function.name);
      if (fragment.function?.arguments) call.function.arguments += String(fragment.function.arguments);
      calls.set(index, call);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (pending) consume(pending);

  return {
    message: {
      role: 'assistant', content: content || null,
      tool_calls: calls.size ? [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) : undefined,
    },
    usage,
    model,
  };
}
