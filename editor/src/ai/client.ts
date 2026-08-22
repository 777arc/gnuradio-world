/**
 * The one request path Flowgraph Copilot uses, against whichever provider in
 * `providers.ts` is connected. Both providers speak OpenAI's chat-completions
 * wire format; the descriptor supplies the base URL, the headers each accepts,
 * and what its model list looks like.
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
  /** OpenRouter only; OpenAI reports tokens and no price. */
  cost?: number;
}

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

export function apiError(provider: AiProvider, status: number, body: string): Error {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.message;
    if (message) return new Error(`${provider.label}: ${message}`);
  } catch { /* return the status below */ }
  return new Error(`${provider.label} request failed (${status})`);
}

// OpenAI's model list is every model of every kind, with no capability flags, so
// the chat-completions families are named here and the speech/image/embedding
// ones filtered back out.
const OPENAI_CHAT_MODEL = /^(gpt-|chatgpt-|o\d)/;
const OPENAI_NOT_CHAT = /embed|audio|tts|whisper|image|dall-e|moderation|realtime|transcribe|speech|instruct|search|sora/;

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
 * filter and needs no key; OpenAI's list is authenticated and unfiltered.
 */
export async function listModels(options: {
  provider: ProviderId;
  key?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<AiModel[]> {
  const provider = providerFor(options.provider);
  const fetcher = options.fetchImpl || fetch;
  const path = provider.id === 'openrouter' ? '/models?supported_parameters=tools' : '/models';
  const response = await fetcher(`${provider.api}${path}`, {
    headers: {
      ...providerHeaders(provider),
      ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
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
  key: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<CompletionResult> {
  const provider = providerFor(options.provider);
  const fetcher = options.fetchImpl || fetch;
  const response = await fetcher(`${provider.api}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.key}`,
      'Content-Type': 'application/json',
      ...providerHeaders(provider),
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      stream: true,
      // OpenRouter appends usage itself; OpenAI omits it from a stream unless asked.
      ...(provider.requestUsage ? { stream_options: { include_usage: true } } : {}),
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
