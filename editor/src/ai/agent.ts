import { chatCompletion, type ChatMessage, type AiUsage } from './client';
import type { ProviderId } from './providers';
import { AI_TOOLS, dispatchAiTool, type AiToolDeps } from './tools';

export const MAX_TOOL_ROUNDS = 50;

/**
 * Cache-routing key for providers that accept `prompt_cache_key`. Deliberately
 * one per page rather than one per conversation: every conversation in this
 * build shares the same system prefix — the prompt plus the runnable block
 * index — so routing them all at the machine already holding that prefix lets
 * a New chat begin against a warm cache instead of paying for it again.
 */
export const CACHE_KEY = `grw-${globalThis.crypto?.randomUUID?.() ||
  Math.random().toString(36).slice(2)}`;
export const GRAPH_PREVIEW_DELAY_MS = 1000;

const waitForGraphPreview = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });

export interface AgentHooks {
  assistantStarted?(): void;
  assistantDelta?(text: string): void;
  assistantFinished?(text: string): void;
  toolStarted?(name: string, args: unknown): void;
  toolFinished?(name: string, result: unknown, error?: string): void;
  usage?(usage: AiUsage, totalCost: number): void;
}

export interface AgentOptions {
  provider: ProviderId;
  /** Absent on a keyless provider, where the proxy holds the only key. */
  key?: string;
  model: string;
  systemPrompt: string;
  deps: AiToolDeps;
  hooks?: AgentHooks;
  fetchImpl?: typeof fetch;
  /** Test seam; production always uses the one-second default. */
  graphPreviewDelayMs?: number;
}

export interface TurnResult {
  text: string;
  mutated: boolean;
  cost: number;
  rounds: number;
}

export class FlowgraphAgent {
  private messages: ChatMessage[];
  private totalCost = 0;
  private graphChangedSinceRun = false;

  constructor(private readonly options: AgentOptions) {
    this.messages = [{ role: 'system', content: options.systemPrompt }];
  }

  reset(systemPrompt = this.options.systemPrompt): void {
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.totalCost = 0;
    this.graphChangedSinceRun = false;
  }

  transcript(): ChatMessage[] {
    return structuredClone(this.messages);
  }

  async turn(prompt: string, signal?: AbortSignal): Promise<TurnResult> {
    this.messages.push({ role: 'user', content: prompt });
    let mutated = false;
    let finalText = '';
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      this.options.hooks?.assistantStarted?.();
      let streamed = '';
      const response = await chatCompletion({
        provider: this.options.provider,
        key: this.options.key,
        model: this.options.model,
        messages: this.messages,
        tools: AI_TOOLS,
        cacheKey: CACHE_KEY,
        signal,
        fetchImpl: this.options.fetchImpl,
        onText: chunk => {
          streamed += chunk;
          this.options.hooks?.assistantDelta?.(chunk);
        },
      });
      if (response.usage) {
        this.totalCost += Number(response.usage.cost || 0);
        this.options.hooks?.usage?.(response.usage, this.totalCost);
      }
      this.messages.push(response.message);
      const calls = response.message.tool_calls || [];
      if (!calls.length) {
        finalText = String(response.message.content || streamed || 'Done.');
        this.options.hooks?.assistantFinished?.(finalText);
        return { text: finalText, mutated, cost: this.totalCost, rounds };
      }
      this.options.hooks?.assistantFinished?.(String(response.message.content || streamed || ''));

      for (const call of calls) {
        let args: any = {};
        let content: string;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          this.options.hooks?.toolStarted?.(call.function.name, args);
          if (call.function.name === 'run_flowgraph' && this.graphChangedSinceRun) {
            await waitForGraphPreview(
              this.options.graphPreviewDelayMs ?? GRAPH_PREVIEW_DELAY_MS,
              signal,
            );
            this.graphChangedSinceRun = false;
          }
          const dispatched = await dispatchAiTool(
            this.options.deps, call.function.name, args, signal,
          );
          mutated ||= dispatched.mutated;
          if (dispatched.mutated) this.graphChangedSinceRun = true;
          content = JSON.stringify(dispatched.value);
          this.options.hooks?.toolFinished?.(call.function.name, dispatched.value);
        } catch (error) {
          if (signal?.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          content = JSON.stringify({ error: message });
          this.options.hooks?.toolFinished?.(call.function.name, { error: message }, message);
        }
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content,
        });
      }
    }

    finalText = `Stopped after ${MAX_TOOL_ROUNDS} tool rounds. Review the current canvas and continue in a new message.`;
    this.messages.push({ role: 'assistant', content: finalText });
    this.options.hooks?.assistantStarted?.();
    this.options.hooks?.assistantDelta?.(finalText);
    this.options.hooks?.assistantFinished?.(finalText);
    return { text: finalText, mutated, cost: this.totalCost, rounds };
  }
}
