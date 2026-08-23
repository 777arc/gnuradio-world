/**
 * The one request path Flowgraph Copilot uses, against whichever provider in
 * `providers.ts` is connected. All three providers speak OpenAI's
 * chat-completions wire format; the descriptor supplies the base URL, the
 * headers each accepts, and what its model list looks like.
 */
import { providerFor, type AiProvider, type ProviderId } from './providers';

export interface AiModel {
  id: string;
  name: string;
  /** 0 when the provider does not publish one (OpenAI). */
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

export interface AiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Input served from the provider's prompt cache, at a fraction of the rate. */
  cached_tokens?: number;
  /** Output spent thinking: billed at the output rate and never cached. */
  reasoning_tokens?: number;
  /** OpenRouter only; OpenAI reports tokens and no price. */
  cost?: number;
}

/**
 * Both providers nest the two numbers that decide what a turn actually cost —
 * how much input came from cache, and how much output went on reasoning — a
 * level down from the totals. Flattened here so a caller totalling usage across
 * a conversation never has to know that.
 */
const usageFrom = (raw: any): AiUsage => ({
  prompt_tokens: Number(raw.prompt_tokens || 0),
  completion_tokens: Number(raw.completion_tokens || 0),
  total_tokens: Number(raw.total_tokens || 0),
  cached_tokens: Number(raw.prompt_tokens_details?.cached_tokens || 0),
  reasoning_tokens: Number(raw.completion_tokens_details?.reasoning_tokens || 0),
  ...(raw.cost === undefined ? {} : { cost: Number(raw.cost) }),
});

export interface CompletionResult {
  message: ChatMessage;
  usage?: AiUsage;
  model?: string;
}

export const attributionHeaders = (): Record<string, string> => ({
  'HTTP-Referer': typeof location === 'undefined'
    ? 'http://localhost/'
    : location.origin + location.pathname,
  'X-Title': 'GNU Radio World Flowgraph Copilot',
});

/** Attribution headers only where the provider accepts them in preflight. */
const providerHeaders = (provider: AiProvider): Record<string, string> =>
  provider.attribution ? attributionHeaders() : {};

/**
 * The key, where there is one. A keyless provider must send no Authorization
 * header at all: the shared proxy holds the only key involved, and a stray
 * header would only widen the request's CORS preflight.
 */
const authorization = (key?: string): Record<string, string> =>
  key ? { Authorization: `Bearer ${key}` } : {};

/**
 * An API failure, carrying the status so a caller can tell a spent quota from
 * a bad key. The shared proxy answers 429 with a message that already names
 * the wait and the way forward, so it is surfaced as written.
 */
export class AiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AiRequestError';
  }

  /** True when waiting, or connecting a personal key, is what resolves it. */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export function apiError(provider: AiProvider, status: number, body: string): AiRequestError {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.message;
    if (message) return new AiRequestError(`${provider.label}: ${message}`, status);
  } catch { /* return the status below */ }
  return new AiRequestError(`${provider.label} request failed (${status})`, status);
}

// OpenAI's model list is every model of every kind, with no capability flags, so
// the chat-completions families are named here and the speech/image/embedding
// ones filtered back out.
const OPENAI_CHAT_MODEL = /^(gpt-|chatgpt-|o\d)/;
const OPENAI_NOT_CHAT = /embed|audio|tts|whisper|image|dall-e|moderation|realtime|transcribe|speech|instruct|search|sora/;
// The families that have a reasoning knob to turn off: the gpt-5 line and the
// o-series. That list is every model in the picker that accepts
// `reasoning_effort` — a chat-only model such as gpt-4o answers "Unrecognized
// request argument supplied: reasoning_effort" — so the provider's effort is
// sent through this gate rather than to whatever the user picked.
const REASONING_MODEL = /^(gpt-5|o\d)/;

const openAiModels = (payload: any): AiModel[] =>
  (Array.isArray(payload?.data) ? payload.data : [])
    .map((model: any) => String(model.id))
    .filter((id: string) => OPENAI_CHAT_MODEL.test(id) && !OPENAI_NOT_CHAT.test(id))
    .sort()
    .map((id: string) => ({ id, name: id, contextLength: 0, promptPrice: 0, completionPrice: 0 }));

const openRouterModels = (payload: any): AiModel[] =>
  (Array.isArray(payload?.data) ? payload.data : [])
    .filter((model: any) => Array.isArray(model.supported_parameters) &&
      model.supported_parameters.includes('tools'))
    .map((model: any) => ({
      id: String(model.id),
      name: String(model.name || model.id),
      contextLength: Number(model.context_length || 0),
      promptPrice: Number(model.pricing?.prompt || 0),
      completionPrice: Number(model.pricing?.completion || 0),
    }));

/**
 * Lists the models a provider offers. OpenRouter publishes a tool-capable
 * filter and needs no key; OpenAI's list is authenticated and unfiltered; the
 * shared proxy offers a short fixed list the descriptor already names.
 */
export async function listModels(options: {
  provider: ProviderId;
  key?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<AiModel[]> {
  const provider = providerFor(options.provider);
  if (provider.fixedModels) return provider.fixedModels.map(model => ({ ...model }));
  const fetcher = options.fetchImpl || fetch;
  const path = provider.id === 'openrouter' ? '/models?supported_parameters=tools' : '/models';
  const response = await fetcher(`${provider.api}${path}`, {
    headers: {
      ...providerHeaders(provider),
      ...authorization(options.key),
    },
    signal: options.signal,
  });
  if (!response.ok) throw apiError(provider, response.status, await response.text());
  const payload = await response.json();
  return provider.id === 'openrouter' ? openRouterModels(payload) : openAiModels(payload);
}

/**
 * Streams one OpenAI-compatible chat completion. Tool argument fragments are
 * accumulated by index; text is surfaced immediately for the transcript.
 */
export async function chatCompletion(options: {
  provider: ProviderId;
  /** Absent on a keyless provider. */
  key?: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Cache-routing hint, sent only where the provider accepts one. */
  cacheKey?: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<CompletionResult> {
  const provider = providerFor(options.provider);
  const fetcher = options.fetchImpl || fetch;
  const response = await fetcher(`${provider.api}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authorization(options.key),
      'Content-Type': 'application/json',
      ...providerHeaders(provider),
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      // One HTTP request per tool round, with the whole transcript resent each
      // time, so a turn's cost is set by how many rounds it takes. Independent
      // calls belong in one round. OpenAI defaults this on and OpenRouter
      // leaves it to the model, so it is stated rather than assumed — but only
      // alongside tools, which is the only shape OpenAI accepts it in.
      ...(options.tools.length ? { parallel_tool_calls: true } : {}),
      stream: true,
      // OpenRouter appends usage itself; OpenAI omits it from a stream unless asked.
      ...(provider.requestUsage ? { stream_options: { include_usage: true } } : {}),
      // Only alongside tools, the only shape an effort is constrained in, and
      // only for a model with reasoning to constrain. Unset is not 'none':
      // gpt-5.6-luna's own default is non-none, so leaving the field off made
      // it refuse every tool-carrying request with "Function tools with
      // reasoning_effort are not supported … set reasoning_effort to 'none'".
      ...(provider.reasoningEffort && options.tools.length && REASONING_MODEL.test(options.model)
        ? { reasoning_effort: provider.reasoningEffort } : {}),
      ...(provider.promptCacheKey && options.cacheKey
        ? { prompt_cache_key: options.cacheKey } : {}),
    }),
    signal: options.signal,
  });
  if (!response.ok) throw apiError(provider, response.status, await response.text());
  if (!response.body) throw new Error(`${provider.label} returned no response body`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let usage: AiUsage | undefined;
  let model: string | undefined;
  const calls = new Map<number, ChatToolCall>();

  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    let chunk: any;
    try { chunk = JSON.parse(value); } catch { return; }
    if (chunk.error) throw new Error(`${provider.label}: ${chunk.error.message || 'stream failed'}`);
    if (chunk.usage) usage = usageFrom(chunk.usage);
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
