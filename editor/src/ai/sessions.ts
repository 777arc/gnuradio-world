// Graham's conversations, kept between visits.
//
// A refresh used to lose the transcript, because it lived in one place: the
// agent's in-memory message list. Now each conversation is a record in the
// editor's IndexedDB, written after every round of a turn, and the panel opens
// on the one it was showing when the page was left -- the canvas itself comes
// back through the workspace autosave, independently of any of this.
//
// What is stored is the wire transcript, exactly as the agent holds it, plus the
// per-turn canvas snapshots the panel already takes for Revert. Nothing new
// leaves the browser or lands anywhere but this browser: the transcript is what
// already went to the provider, made durable. The DOM is rebuilt from it rather
// than from a parallel log of what was rendered, so there is one source of
// truth and a resumed conversation continues from precisely what the model saw.
import type { ChatMessage, ContentPart } from './client';
import type { ProviderId } from './providers';
import type { GraphSnapshot } from '../graph-model';
import { STORES, transact } from '../local-db';

export interface TurnRecord {
  /** Index into `messages` of the user message that opened the turn. */
  messageIndex: number;
  /** Present only when the turn changed the canvas; what Revert restores. */
  before?: GraphSnapshot;
  after?: GraphSnapshot;
}

export interface SessionUsage {
  spend: number;
  prompt: number;
  completion: number;
  cached: number;
  reasoning: number;
  total: number;
  requests: number;
  turns: number;
}

export interface GrahamSession {
  id: string;
  /** The first message, trimmed -- never a model call, which would cost a round. */
  title: string;
  created: number;
  updated: number;
  provider: ProviderId;
  model: string;
  /** The transcript without its system prompt, which is rebuilt on resume. */
  messages: ChatMessage[];
  turns: TurnRecord[];
  usage: SessionUsage;
  imagesThisConversation: number;
}

/** What the History list shows; the transcript stays in the store until opened. */
export interface SessionSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  model: string;
  messageCount: number;
  bytes: number;
}

export const CURRENT_SESSION_STORAGE = 'gnuradio-world.graham-session';
export const MAX_SESSIONS = 50;
/**
 * A conversation past this stops being written, and the panel says so. A long
 * debugging chat carries every tool result of every round; four megabytes is
 * far past where the provider's context would have given out anyway.
 */
export const MAX_SESSION_BYTES = 4 * 1024 * 1024;
export const TITLE_LENGTH = 60;

/** The seed the panel puts above what the user typed; see `canvasContext`. */
const MESSAGE_MARKER = '\n\n[message]\n';

export function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function emptyUsage(): SessionUsage {
  return { spend: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0,
           requests: 0, turns: 0 };
}

/** What the user typed, out of a seeded user message. */
export function userText(content: ChatMessage['content']): string {
  const text = typeof content === 'string' ? content
    : (content || []).filter((part): part is Extract<ContentPart, { type: 'text' }> =>
        part.type === 'text').map(part => part.text).join(' ');
  const marker = text.lastIndexOf(MESSAGE_MARKER);
  return marker >= 0 ? text.slice(marker + MESSAGE_MARKER.length) : text;
}

export function sessionTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
  if (line.length <= TITLE_LENGTH) return line || 'New conversation';
  const cut = line.lastIndexOf(' ', TITLE_LENGTH);
  return `${line.slice(0, cut > TITLE_LENGTH / 2 ? cut : TITLE_LENGTH)}…`;
}

/** A user message that only carries screenshots, appended after a round's tool results. */
export function isAttachment(message: ChatMessage): boolean {
  return message.role === 'user' && Array.isArray(message.content) &&
    message.content.some(part => part.type === 'image_url');
}

const IMAGE_GONE = '[the image itself is no longer in this conversation; ' +
  'call capture_plots again to look at it now]';

/**
 * A stored transcript, made resumable.
 *
 * A refresh mid-turn leaves the last round unfinished: an assistant message
 * whose tool calls have no results, or a user message nothing answered. The
 * API refuses the first shape outright, and the second would be answered
 * silently on the next Send as if it had just been asked. Both are trimmed
 * back to the last completed turn, and the caller is told what the user had
 * asked so it can be offered back rather than lost.
 *
 * A model that cannot see is also handled here: every image part becomes the
 * same line `pruneImages` leaves behind, because a request carrying one would
 * be refused as a whole.
 */
export function resumeTranscript(stored: ChatMessage[], vision: boolean): {
  messages: ChatMessage[];
  interrupted: string | null;
} {
  const messages = structuredClone(stored);
  let interrupted: string | null = null;
  const completed = (message: ChatMessage) =>
    message.role === 'assistant' && !(message.tool_calls && message.tool_calls.length);
  while (messages.length && !completed(messages[messages.length - 1])) {
    const dropped = messages.pop()!;
    if (dropped.role === 'user' && !isAttachment(dropped)) interrupted = userText(dropped.content);
  }
  if (!vision) {
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      if (!message.content.some(part => part.type === 'image_url')) continue;
      const said = message.content
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map(part => part.text).join(' ');
      message.content = `${said} ${IMAGE_GONE}`;
    }
  }
  return { messages, interrupted };
}

/**
 * The transcript as the panel draws it: one event per bubble, tool row, picture
 * or canvas diff, in the order the live turn produced them. A round's prose
 * comes before the tool calls it issued, and the turn's diff hangs on its last
 * assistant bubble -- the same placement the streaming hooks give it.
 */
export type TranscriptEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args: unknown; result: unknown; error: boolean }
  | { kind: 'image'; dataUrl: string; alt: string }
  | { kind: 'diff'; before: GraphSnapshot; after: GraphSnapshot };

export function transcriptEvents(session: GrahamSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const results = new Map<string, ChatMessage>();
  for (const message of session.messages)
    if (message.role === 'tool' && message.tool_call_id) results.set(message.tool_call_id, message);
  const diffs = new Map<number, TurnRecord>();
  for (const turn of session.turns) if (turn.before && turn.after) diffs.set(turn.messageIndex, turn);
  const parse = (text: string | null | undefined) => {
    try { return JSON.parse(String(text ?? '')); } catch { return text; }
  };
  let turnStart = -1;
  const closeTurn = () => {
    const turn = turnStart >= 0 ? diffs.get(turnStart) : undefined;
    if (turn) events.push({ kind: 'diff', before: turn.before!, after: turn.after! });
  };
  session.messages.forEach((message, index) => {
    if (message.role === 'user' && !isAttachment(message)) {
      closeTurn();
      turnStart = index;
      events.push({ kind: 'user', text: userText(message.content) });
    } else if (message.role === 'user') {
      const parts = message.content as ContentPart[];
      let alt = '';
      for (const part of parts) {
        if (part.type === 'text') alt = part.text.replace(/^Screenshot of /, '').replace(/\.$/, '');
        else events.push({ kind: 'image', dataUrl: part.image_url.url, alt });
      }
    } else if (message.role === 'assistant') {
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) events.push({ kind: 'assistant', text });
      for (const call of message.tool_calls || []) {
        const result = results.get(call.id);
        const value = result ? parse(typeof result.content === 'string' ? result.content : '') : undefined;
        events.push({
          kind: 'tool', name: call.function.name, args: parse(call.function.arguments),
          result: value,
          error: !!(value && typeof value === 'object' && 'error' in (value as object)),
        });
      }
    }
  });
  closeTurn();
  return events;
}

// ---- the store ---------------------------------------------------------------

export interface SessionStore {
  list(): Promise<SessionSummary[]>;
  get(id: string): Promise<GrahamSession | null>;
  put(session: GrahamSession): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export function summarize(session: GrahamSession, bytes = JSON.stringify(session).length): SessionSummary {
  return {
    id: session.id, title: session.title, created: session.created, updated: session.updated,
    model: session.model, bytes,
    messageCount: session.messages.filter(message => message.role === 'user' && !isAttachment(message)).length,
  };
}

/** Newest first, with the oldest beyond MAX_SESSIONS named for eviction. */
export function orderSessions(summaries: SessionSummary[]): { kept: SessionSummary[]; evict: string[] } {
  const sorted = [...summaries].sort((a, b) => b.updated - a.updated);
  return { kept: sorted.slice(0, MAX_SESSIONS), evict: sorted.slice(MAX_SESSIONS).map(s => s.id) };
}

const STORE = STORES.grahamSessions;

export const sessionStore: SessionStore = {
  async list() {
    const all = await transact<GrahamSession[]>(STORE, 'readonly', store => store.getAll());
    return orderSessions((all || []).map(session => summarize(session))).kept;
  },
  async get(id) {
    const row = await transact<GrahamSession | undefined>(STORE, 'readonly', store => store.get(id));
    return row && Array.isArray(row.messages) ? row : null;
  },
  async put(session) {
    const bytes = JSON.stringify(session).length;
    if (bytes > MAX_SESSION_BYTES)
      throw new Error(`this conversation is ${(bytes / 1024 / 1024).toFixed(1)} MB, past the ` +
        `${MAX_SESSION_BYTES / 1024 / 1024} MB kept between visits; start a new chat to keep saving`);
    await transact(STORE, 'readwrite', store => store.put(session));
    const all = await transact<GrahamSession[]>(STORE, 'readonly', store => store.getAll());
    const { evict } = orderSessions((all || []).map(s => summarize(s, 0)));
    for (const id of evict) await transact(STORE, 'readwrite', store => store.delete(id));
  },
  async delete(id) {
    await transact(STORE, 'readwrite', store => store.delete(id));
  },
  async clear() {
    await transact(STORE, 'readwrite', store => store.clear());
  },
};

// The id of the conversation the dock is showing -- what a refresh follows.
const local = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string | null) {
    try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* disabled storage */ }
  },
};
export const currentSessionId = () => local.get(CURRENT_SESSION_STORAGE);
export const setCurrentSessionId = (id: string | null) => local.set(CURRENT_SESSION_STORAGE, id);

/** "2 minutes ago", "yesterday", or the date -- for the History list. */
export function relativeTime(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString();
}
