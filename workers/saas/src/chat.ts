import type { Env, RuntimeConfig } from './env';
import type { Hold } from './ledger';
import { absorbAndRelease, activeRate, InsufficientFundsError, releaseUnused, reserve, settle } from './ledger';
import type { TokenUsage } from './pricing';

interface ChatBody {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  max_tokens?: unknown;
  parallel_tool_calls?: unknown;
}

interface StreamMeter {
  usage?: TokenUsage;
  outputTextBytes: number;
  sawGeneration: boolean;
  error?: Error;
}

const safeInteger = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const jsonError = (status: number, message: string): Response => Response.json({
  error: { type: status === 402 ? 'insufficient_credits' : 'invalid_request_error', message },
}, { status });

/** Safe token upper bound for pre-flight holds. Actual billing always uses final usage. */
export function countInputTokens(messages: unknown, tools: unknown): number {
  const bytes = new TextEncoder().encode(JSON.stringify({ messages, tools })).byteLength;
  return Math.max(1, bytes);
}

const estimatedUsage = (hold: Hold, outputBytes: number): TokenUsage => ({
  inputTokens: hold.inputTokens,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: Math.max(1, Math.ceil(outputBytes / 3)),
});

class SseMeter {
  private pending = '';
  readonly result: StreamMeter = { outputTextBytes: 0, sawGeneration: false };

  push(text: string): void {
    this.pending += text;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() || '';
    for (const line of lines) this.line(line);
  }

  finish(): void {
    if (this.pending) this.line(this.pending);
    this.pending = '';
  }

  private line(line: string): void {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let chunk: any;
    try { chunk = JSON.parse(raw); } catch { return; }
    if (chunk.error) {
      this.result.error = new Error(String(chunk.error.message || 'Upstream stream failed'));
      return;
    }
    if (chunk.usage) {
      const input = safeInteger(chunk.usage.prompt_tokens);
      const output = safeInteger(chunk.usage.completion_tokens);
      const cached = safeInteger(chunk.usage.prompt_tokens_details?.cached_tokens) ?? 0;
      const cacheWrite = safeInteger(chunk.usage.prompt_tokens_details?.cache_write_tokens) ?? 0;
      if (input !== null && output !== null && cached + cacheWrite <= input) {
        this.result.usage = {
          inputTokens: input,
          cachedInputTokens: cached,
          cacheWriteTokens: cacheWrite,
          outputTokens: output,
        };
      }
    }
    const content = chunk.choices?.[0]?.delta?.content;
    const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
    if (typeof content === 'string' && content) {
      this.result.sawGeneration = true;
      this.result.outputTextBytes += new TextEncoder().encode(content).byteLength;
    }
    if (Array.isArray(toolCalls) && toolCalls.length) {
      this.result.sawGeneration = true;
      this.result.outputTextBytes += new TextEncoder().encode(JSON.stringify(toolCalls)).byteLength;
    }
  }
}

function sanitizedBody(body: ChatBody, model: string, maxTokens: number): Record<string, unknown> {
  return {
    model,
    messages: body.messages,
    ...(Array.isArray(body.tools) && body.tools.length ? {
      tools: body.tools,
      tool_choice: body.tool_choice ?? 'auto',
      parallel_tool_calls: body.parallel_tool_calls !== false,
      // GPT-5.6 Chat Completions rejects function tools at its default
      // reasoning effort. Graham's tool loop is deliberately non-reasoning;
      // enforce that server-side instead of trusting every client version to
      // remember the provider-specific constraint.
      reasoning_effort: 'none',
    } : {}),
    stream: true,
    // The editor's OpenAI-compatible request uses max_tokens; normalize it to
    // OpenAI's current field so reasoning-capable models are bounded too.
    max_completion_tokens: maxTokens,
    stream_options: { include_usage: true },
  };
}

async function finalize(db: D1Database, hold: Hold, meter: StreamMeter,
  outcome: 'complete' | 'client_abort' | 'upstream_error'): Promise<void> {
  const usage = meter.usage || estimatedUsage(hold, meter.outputTextBytes);
  if (outcome === 'client_abort') {
    // A client abort is billable and never an absorbed-cost row. The estimate
    // closes the disconnect exploit when the final usage chunk never arrived.
    await settle(db, hold, usage, !!meter.usage);
    return;
  }
  if (outcome === 'upstream_error') {
    if (!meter.sawGeneration && !meter.usage) {
      await releaseUnused(db, hold);
      return;
    }
    await absorbAndRelease(db, hold, {
      reason: 'upstream_error', usage, exact: !!meter.usage,
      metadata: { upstream_error: true },
    });
    return;
  }
  if (!meter.usage) {
    await absorbAndRelease(db, hold, {
      reason: 'settle_failed', usage, exact: false,
      metadata: { missing_final_usage: true },
    });
    return;
  }
  try {
    await settle(db, hold, meter.usage, true);
  } catch (error) {
    await absorbAndRelease(db, hold, {
      reason: 'settle_failed', usage: meter.usage, exact: true,
      metadata: { settlement_error: error instanceof Error ? error.name : 'unknown' },
    });
    throw error;
  }
}

export async function chat(request: Request, env: Env, cfg: RuntimeConfig,
  userId: string, waitUntil: (promise: Promise<unknown>) => void,
  fetcher: typeof fetch = fetch): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > cfg.maxChatBodyBytes) return jsonError(413, 'Request body is too large');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > cfg.maxChatBodyBytes) {
    return jsonError(413, 'Request body is too large');
  }
  let body: ChatBody;
  try { body = JSON.parse(raw); } catch { return jsonError(400, 'Invalid JSON'); }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 600) {
    return jsonError(400, 'messages must contain between 1 and 600 entries');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 64)) {
    return jsonError(400, 'tools must be an array of at most 64 entries');
  }
  const model = typeof body.model === 'string' ? body.model : '';
  const rate = model ? await activeRate(env.DB, model) : null;
  if (!rate || rate.provider !== 'openai') return jsonError(400, 'Model is not available');
  const requestedMax = safeInteger(body.max_tokens);
  const maxTokens = requestedMax === null ? cfg.maxCompletionTokens : requestedMax;
  if (maxTokens < 1 || maxTokens > cfg.maxCompletionTokens) {
    return jsonError(400, `max_tokens must be between 1 and ${cfg.maxCompletionTokens}`);
  }

  const requestId = crypto.randomUUID();
  let hold: Hold;
  try {
    hold = await reserve(env.DB, {
      userId, requestId, model, rate,
      inputTokens: countInputTokens(body.messages, body.tools),
      maxOutputTokens: maxTokens,
      holdTtlSeconds: cfg.holdTtlSeconds,
    });
  } catch (error) {
    if (error instanceof InsufficientFundsError) return jsonError(402, error.message);
    throw error;
  }

  let upstream: Response;
  try {
    upstream = await fetcher('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sanitizedBody(body, model, maxTokens)),
    });
  } catch {
    await releaseUnused(env.DB, hold);
    return jsonError(502, 'The model provider could not be reached');
  }
  if (!upstream.ok || !upstream.body) {
    await releaseUnused(env.DB, hold);
    return jsonError(502, 'The model provider refused the request');
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const meter = new SseMeter();

  const pump = (async () => {
    let outcome: 'complete' | 'client_abort' | 'upstream_error' = 'complete';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        meter.push(decoder.decode(value, { stream: true }));
        if (meter.result.error) throw meter.result.error;
        try {
          await writer.write(value);
        } catch {
          outcome = 'client_abort';
          await reader.cancel('client disconnected').catch(() => undefined);
          break;
        }
      }
      meter.push(decoder.decode());
      meter.finish();
      if (meter.result.error) outcome = 'upstream_error';
      if (outcome === 'complete') await writer.close().catch(() => undefined);
    } catch {
      outcome = 'upstream_error';
      await writer.abort('upstream stream failed').catch(() => undefined);
    }
    await finalize(env.DB, hold, meter.result, outcome);
  })();
  // The response can finish or disconnect before settlement; the Worker must
  // remain alive until the money path above completes.
  waitUntil(pump);

  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  headers.delete('set-cookie');
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-request-id', requestId);
  return new Response(transform.readable, { status: 200, headers });
}
