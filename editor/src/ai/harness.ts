import type { Inst } from '../graph-model';

export interface RunAuthorization {
  title: string;
  detail: string;
  button: string;
}

export interface HarnessDeps {
  run(): Promise<string | null>;
  frame(): HTMLIFrameElement;
  blocks(): Inst[];
  authorization(): Promise<RunAuthorization | null>;
  requestAuthorization(
    authorization: RunAuthorization,
    runFromClick: () => Promise<string | null>,
    signal?: AbortSignal,
  ): Promise<string | null>;
  subscribeLogs(subscriber: (lines: string[]) => void): () => void;
  /** The runner's widget report, for naming the plots this run put on screen. */
  layout(): { widgets: { name: string }[] } | null;
}

interface RawStats {
  uptime_s: number;
  /** Items/s the `ref` block moves when the graph is exactly keeping up. */
  ref_item_rate: number;
  blocks: RawBlock[];
}

interface RawBlock {
  name: string;
  id: string;
  items: number;
  work_us: number;
  in_full: number;
  out_full: number;
  msg_only: boolean;
  ref: boolean;
  value?: unknown;
  javascript?: {
    work_calls: number;
    last_requested: number;
    last_produced: number;
    last_consumed: number;
    zero_progress_calls: number;
  };
}

export function javascriptErrors(lines: string[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const text of lines) {
    const match = text.match(/JS Block '([^']+)':\s*(?:Error:\s*)?\[(descriptor|compile|start|forecast|work|stop)\]\s*([^\n]*)/i);
    if (!match) continue;
    const key = `${match[1]}:${match[2]}:${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const location = text.match(/<anonymous>:(\d+):(\d+)/);
    found.push({
      block: match[1], phase: match[2].toLowerCase(), message: match[3].trim(),
      ...(location ? { source_line: Math.max(1, Number(location[1]) - 3),
        source_column: Number(location[2]) } : {}),
      stack: text.slice(0, 4000),
    });
  }
  return found;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException('The operation was aborted.', 'AbortError'));
    return;
  }
  const abort = () => {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    reject(new DOMException('The operation was aborted.', 'AbortError'));
  };
  const timer = window.setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

function sameRun(frame: HTMLIFrameElement, token: string): Window | null {
  try {
    const live = frame.contentWindow;
    const expected = `?recordingToken=${encodeURIComponent(token)}`;
    return live && live.location.search === expected ? live : null;
  } catch { return null; }
}

function readStats(frame: HTMLIFrameElement, token: string): RawStats | null {
  const live = sameRun(frame, token) as any;
  if (!live?.__grstats) return null;
  try {
    const parsed = JSON.parse(live.__grstats);
    if (!Array.isArray(parsed.blocks) || !Number.isFinite(Number(parsed.uptime_s))) return null;
    return parsed;
  } catch { return null; }
}

function readFailure(frame: HTMLIFrameElement, token: string): string | null {
  if (!sameRun(frame, token)) return null;
  try {
    const result = frame.contentDocument?.getElementById('result');
    if (!result || result.getAttribute('data-status') !== 'fail') return null;
    return (result.textContent || 'flowgraph failed').replace(/^RESULT:\s*RUNNER_FAIL\s*/, '');
  } catch { return null; }
}

function sideChannel(frame: HTMLIFrameElement, token: string, name: string): unknown {
  const live = sameRun(frame, token) as any;
  if (!live) return undefined;
  try {
    const value = live[name];
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } catch { return undefined; }
}

function runReport(first: RawStats, last: RawStats, consoleLines: string[],
                   plots: string[]): Record<string, unknown> {
  const elapsed = Math.max(0.001, Number(last.uptime_s) - Number(first.uptime_s));
  const before = new Map(first.blocks.map(block => [block.name, block]));
  const blocks = last.blocks.map(block => {
    const previous = before.get(block.name);
    const delta = Math.max(0, Number(block.items || 0) - Number(previous?.items || 0));
    const rate = delta / elapsed;
    return {
      name: block.name,
      id: block.id,
      items: Number(block.items || 0),
      items_per_s: Math.round(rate),
      work_us: Number(block.work_us || 0),
      in_full: Number(block.in_full || 0),
      out_full: Number(block.out_full || 0),
      msg_only: !!block.msg_only,
      stalled: !block.msg_only && Number(block.items || 0) === 0,
      ...(block.value === undefined ? {} : { value: block.value }),
      ...(block.javascript ? { javascript: {
        work_calls: Number(block.javascript.work_calls || 0),
        calls_per_s: Math.round(Math.max(0,
          Number(block.javascript.work_calls || 0) -
          Number(previous?.javascript?.work_calls || 0)) / elapsed),
        last_requested: Number(block.javascript.last_requested || 0),
        last_produced: Number(block.javascript.last_produced || 0),
        last_consumed: Number(block.javascript.last_consumed || 0),
        zero_progress_calls: Number(block.javascript.zero_progress_calls || 0),
      } } : {}),
    };
  });
  // The realtime factor, as a ratio between two rates at the *same* block: what
  // it actually moved, over what it moves when the graph is exactly keeping up.
  // Null unless both halves are there -- a graph with no block declaring a rate
  // (or none flagged `ref`) has no realtime factor to report, and saying 0.00x
  // would read as "completely stalled" for a graph that is running fine.
  const ref = last.blocks.find(block => block.ref);
  const measured = ref ? blocks.find(block => block.name === ref.name) : undefined;
  const expectedRate = Number(last.ref_item_rate || 0);
  const realtime = measured && expectedRate > 0
    ? measured.items_per_s / expectedRate : null;
  const findings: string[] = [];
  for (const block of blocks) {
    if (block.stalled)
      findings.push(`${block.name} produced no items in ${elapsed.toFixed(1)}s — nothing reached it`);
  }
  const fullestInput = [...blocks].sort((a, b) => b.in_full - a.in_full)[0];
  if (fullestInput?.in_full >= 0.8)
    findings.push(`${fullestInput.name} has ${(fullestInput.in_full * 100).toFixed(0)}% full input buffers and is the likely bottleneck`);
  const fullestOutput = [...blocks].sort((a, b) => b.out_full - a.out_full)[0];
  if (fullestOutput?.out_full >= 0.8)
    findings.push(`output buffers are ${(fullestOutput.out_full * 100).toFixed(0)}% full after ${fullestOutput.name}`);
  if (realtime !== null)
    findings.unshift(`realtime factor ${realtime.toFixed(2)}× at ${ref?.name || 'the reference block'}`);
  // Named here rather than left to the system prompt: the moment a model has a
  // run report in front of it is the moment it decides whether the counters
  // answered the question, and this is where it can see that they did not.
  if (plots.length)
    findings.push(`plotting: ${plots.map(name => `"${name}"`).join(', ')} — ` +
      'read_plot_data for what they show as numbers, capture_plots to look at them');
  const jsBlocks = blocks.filter(block => block.javascript).map(block => ({
    name: block.name, id: block.id, ...block.javascript,
  }));
  const jsErrors = javascriptErrors(consoleLines);
  return {
    started: true,
    ran_seconds: elapsed,
    realtime_factor: realtime,
    blocks,
    findings,
    console: consoleLines.slice(0, 50),
    errors: consoleLines.filter(line => /(?:error|failed|cannot run)/i.test(line)).slice(0, 20),
    ...(jsBlocks.length || jsErrors.length ? { javascript: {
      blocks: jsBlocks, errors: jsErrors,
    } } : {}),
    still_running: true,
  };
}

/**
 * How long to wait for the editor to actually start a run before giving up on
 * it. Everything on that path is normally immediate, so this is a backstop
 * against one thing: a gate that opens a dialog and waits for a click. An
 * unattended run declines the ones it can answer itself (see `RunOptions` in
 * run-session.ts), but a review a human is genuinely meant to read — the
 * JavaScript one — legitimately waits, and waiting *forever* is what must not
 * happen: it hangs the turn with no message, which is indistinguishable from
 * the model having stopped. Generous enough to read a short block of code, and
 * the dialog stays open afterwards so a later click still runs the graph.
 */
const RUN_START_TIMEOUT_MS = 180_000;

const startTimeout = (signal?: AbortSignal) => new Promise<'timeout'>((resolve, reject) => {
  const abort = () => {
    window.clearTimeout(timer);
    reject(new DOMException('The operation was aborted.', 'AbortError'));
  };
  const timer = window.setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve('timeout');
  }, RUN_START_TIMEOUT_MS);
  signal?.addEventListener('abort', abort, { once: true });
});

let runQueue: Promise<unknown> = Promise.resolve();

/** Drives the editor's real runner and observes it without stopping it. */
export function runFlowgraph(
  deps: HarnessDeps, requestedSeconds = 3, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const task = async (): Promise<Record<string, unknown>> => {
    const seconds = Math.min(15, Math.max(0.5, Number(requestedSeconds) || 3));
    const lines: string[] = [];
    const unsubscribe = deps.subscribeLogs(batch => lines.push(...batch));
    try {
      const authorization = await deps.authorization();
      const started = authorization
        ? deps.requestAuthorization(authorization, () => deps.run(), signal)
        : deps.run();
      const token = await Promise.race([started, startTimeout(signal)]);
      if (token === 'timeout') return {
        started: false,
        error: 'the editor has not started the flowgraph: it is waiting for the ' +
          'user to answer something on screen. Say what you were trying to run ' +
          'and ask them to look at the editor.',
        console: lines.slice(0, 50),
        still_running: false,
      };
      if (!token) return {
        started: false,
        error: [...lines].reverse().find(line => line.startsWith('cannot run:')) ||
          (authorization ? 'the run was not authorized' : 'the flowgraph did not start'),
        console: lines.slice(0, 50),
        still_running: false,
      };
      const frame = deps.frame();
      const deadline = Date.now() + 120_000;
      let first: RawStats | null = null;
      let last: RawStats | null = null;
      for (;;) {
        await sleep(80, signal);
        const failure = readFailure(frame, token);
        if (failure) {
          const jsErrors = javascriptErrors([failure, ...lines]);
          return { started: false, error: failure, console: lines.slice(0, 50),
            ...(jsErrors.length ? { javascript: { blocks: [], errors: jsErrors } } : {}),
            still_running: false };
        }
        const reading = readStats(frame, token);
        if (reading) {
          if (!first && reading.uptime_s >= Math.min(1, seconds / 3)) first = reading;
          last = reading;
          if (first && reading.uptime_s - first.uptime_s >= seconds) break;
        }
        if (Date.now() > deadline)
          return { started: false, error: 'the runner did not publish diagnostics', console: lines.slice(0, 50), still_running: false };
      }
      const report = runReport(first!, last!, lines,
        (deps.layout()?.widgets || []).map(widget => widget.name));
      const radio = sideChannel(frame, token, '__grUsbStats');
      const files = sideChannel(frame, token, '__grFileStats');
      const audio = sideChannel(frame, token, '__grAudioStats');
      if (radio !== undefined) report.radio = radio;
      if (files !== undefined) report.files = files;
      if (audio !== undefined) report.audio = audio;
      return report;
    } finally { unsubscribe(); }
  };
  const queued = runQueue.then(task, task);
  runQueue = queued.catch(() => undefined);
  return queued;
}
