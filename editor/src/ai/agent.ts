import { chatCompletion, type ChatMessage, type ContentPart, type AiUsage } from './client';
import type { ProviderId } from './providers';
import { aiTools, dispatchAiTool, type AiToolDeps } from './tools';

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

/**
 * How many screenshots a turn and a conversation may take.
 *
 * An image is worth roughly a thousand input tokens and, unlike everything else
 * a tool returns, it is worth that much again on every later round of the turn —
 * so an unbounded looking habit is the one thing here that can make a turn cost
 * several times what it should. Three is enough to look, change something and
 * look again; past that the model is told to reason from read_plot_data instead.
 */
export const MAX_IMAGES_PER_TURN = 3;
export const MAX_IMAGES_PER_CONVERSATION = 8;

/**
 * How many of them stay in the transcript as pictures. Older ones become a line
 * of text saying what was there.
 *
 * Two rather than one because the loop this serves is look → change → look, and
 * comparing the new plot against the previous one is the whole point of the
 * second look. Evicting rewrites history, which costs the provider's cached
 * prefix from that point on — bounded, and only paid once the third image
 * arrives, where the alternative is resending every earlier image for the rest
 * of the conversation.
 */
export const IMAGE_HISTORY_KEEP = 2;

/** Tools whose answer describes the graph as it is *running*, not as it is drawn. */
const OBSERVATION_TOOLS = new Set(['capture_plots', 'read_plot_data']);

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
  /**
   * One round is one HTTP request, and the whole transcript goes up in each of
   * them — so this, not the turn count, is what a conversation is billed by.
   * Fired where the request is actually issued rather than derived from a
   * usage event, so a round that fails or is aborted mid-stream still counts.
   */
  requestStarted?(): void;
  assistantStarted?(): void;
  assistantDelta?(text: string): void;
  assistantFinished?(text: string): void;
  toolStarted?(name: string, args: unknown): void;
  /**
   * `images` is what the call answered with as pictures, so a transcript can
   * show the user the same screenshot the model was sent rather than a line
   * saying one exists.
   */
  toolFinished?(name: string, result: unknown, error?: string,
                images?: { dataUrl: string; alt: string }[]): void;
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
  /** Whether this model can be sent an image; false hides `capture_plots`. */
  vision?: boolean;
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
  private imagesThisConversation = 0;

  constructor(private readonly options: AgentOptions) {
    this.messages = [{ role: 'system', content: options.systemPrompt }];
  }

  reset(systemPrompt = this.options.systemPrompt): void {
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.totalCost = 0;
    this.graphChangedSinceRun = false;
    this.imagesThisConversation = 0;
  }

  transcript(): ChatMessage[] {
    return structuredClone(this.messages);
  }

  /** Refused before the capture is taken, so a spent budget costs nothing. */
  private checkImageBudget(imagesThisTurn: number): void {
    if (imagesThisTurn >= MAX_IMAGES_PER_TURN)
      throw new Error(
        `already looked at ${imagesThisTurn} screenshots this turn, which is the ` +
        'limit — use read_plot_data, which reports the same plots as numbers, or ' +
        'answer from what you have seen');
    if (this.imagesThisConversation >= MAX_IMAGES_PER_CONVERSATION)
      throw new Error(
        `this conversation has used its ${MAX_IMAGES_PER_CONVERSATION} screenshots — ` +
        'use read_plot_data instead, or start a new chat');
  }

  /**
   * Keep the newest few screenshots as pictures and turn the rest into a line of
   * text. Called after each round that produced one, so the transcript carries a
   * bounded number of images however long a debugging conversation runs.
   */
  private pruneImages(): void {
    let kept = 0;
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (!Array.isArray(message.content)) continue;
      if (!message.content.some(part => part.type === 'image_url')) continue;
      if (++kept <= IMAGE_HISTORY_KEEP) continue;
      const said = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text).join(' ');
      message.content = `${said} [the image itself is no longer in this ` +
        `conversation; call capture_plots again to look at it now]`;
    }
  }

  async turn(prompt: string, signal?: AbortSignal): Promise<TurnResult> {
    this.messages.push({ role: 'user', content: prompt });
    let mutated = false;
    let finalText = '';
    let rounds = 0;
    let imagesThisTurn = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      this.options.hooks?.requestStarted?.();
      this.options.hooks?.assistantStarted?.();
      let streamed = '';
      const response = await chatCompletion({
        provider: this.options.provider,
        key: this.options.key,
        model: this.options.model,
        messages: this.messages,
        tools: aiTools(!!this.options.vision),
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

      // Images this round produced, appended after the round's tool results:
      // a tool message carries a string, so a picture cannot travel in one.
      const attachments: ContentPart[] = [];

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
          if (call.function.name === 'capture_plots')
            this.checkImageBudget(imagesThisTurn);
          const dispatched = await dispatchAiTool(
            this.options.deps, call.function.name, args, signal,
          );
          mutated ||= dispatched.mutated;
          if (dispatched.mutated) this.graphChangedSinceRun = true;
          let value = dispatched.value;
          // What is on screen is the graph that was *running* when the run
          // started. Every edit since then is invisible to it, and a plot read
          // as if it reflected them is a wrong conclusion drawn confidently.
          if (this.graphChangedSinceRun && OBSERVATION_TOOLS.has(call.function.name))
            value = { ...(value as object), stale: 'the canvas has been edited since ' +
              'this flowgraph started; these plots are of the graph as it was then — ' +
              'call run_flowgraph before drawing a conclusion from them' };
          for (const image of dispatched.images || []) {
            imagesThisTurn++;
            this.imagesThisConversation++;
            attachments.push(
              { type: 'text', text: `Screenshot of ${image.alt}.` },
              { type: 'image_url', image_url: { url: image.dataUrl } });
          }
          content = JSON.stringify(value);
          this.options.hooks?.toolFinished?.(call.function.name, value, undefined,
            dispatched.images);
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

      if (attachments.length) {
        this.messages.push({ role: 'user', content: attachments });
        this.pruneImages();
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
