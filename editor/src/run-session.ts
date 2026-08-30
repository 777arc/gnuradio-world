import { AUDIO_SOURCE_ID, prepareAudioCapture } from './audio';
import type { GrcDoc } from './grc';
import type { GraphSnapshot, Inst, ValidationIssue } from './graph-model';
import type { EditorGraphState } from './editor-state';
import type { TrainingSession } from './training';
import type { UsbPreparationProblem, UsbRadio } from './usb-radio';
import {
  RECORDING_ID,
  RECORDING_PARAM,
  recordingDataPath,
  type ExampleRecording,
} from './recording-catalog';
import {
  canPickOutputDirectory,
  pickOutputDirectory,
  sanitizeSigmfBase,
  sigmfSinkFileNames,
  SIGMF_DATA_SUFFIX,
  SIGMF_FILE_PARAM,
  SIGMF_META_SUFFIX,
  SIGMF_OUTPUT_PICKER_HELP,
  SIGMF_OUTPUT_PREFIX,
  SIGMF_SINK_ID,
  SIGMF_SOURCE_ID,
  type SigmfBinding,
} from './sigmf-blocks';

export type RunnerInputFile =
  | { kind: 'local'; path: string; file: File; meta?: string }
  | { kind: 'http'; path: string; url: string; size: number; meta?: string }
  | { kind: 'output'; path: string; base: string; dir: FileSystemDirectoryHandle | null };

export interface RunSessionState {
  pendingFiles: Map<string, RunnerInputFile[]>;
  pendingToken: string | null;
  generation: number;
  runningGraphSnapshot: string | null;
  runningNeedsGracefulStop: boolean;
  active: boolean;
  starting: boolean;
  finishing: boolean;
}

export interface RunSessionDeps {
  state: EditorGraphState;
  trainingSession(): TrainingSession | null;
  log(message: string): void;
  validateGraph(): ValidationIssue[];
  select(uid: string | null): void;
  askToRunUnpacedFlowgraph(): Promise<boolean>;
  /** The dialog's own predicate, for a caller that cannot show the dialog. */
  isUnpacedFlowgraph(): boolean;
  usbRadios: UsbRadio[];
  showUsbPreparationProblem(problem: Exclude<UsbPreparationProblem, string>): void;
  sigmfOutputDirsByToken: Map<string, FileSystemDirectoryHandle>;
  newLocalFileToken(): string;
  unacceptedJsSources(): { block: Inst; source: string }[];
  askToRunJavaScript(pending: { block: Inst; source: string }[]): Promise<boolean>;
  resolveRemoteRecording(path: string): Promise<ExampleRecording | undefined>;
  localFilesByToken: Map<string, File>;
  sigmfBindingsByToken: Map<string, SigmfBinding>;
  recordingPathForBlock(block: Inst): string | null;
  grcTextForRun(overrides: Map<string, string>): string;
  buildGrcDoc(): GrcDoc;
  snapshot(): GraphSnapshot;
  localFileParams: Record<string, string>;
  optionsId: string;
  layoutId: string;
  httpRecordingId: string;
  httpRecordingParam: string;
  httpRecordingPrefix: string;
  frame: HTMLIFrameElement;
  runEmpty: HTMLElement;
  setExecuteEnabled(enabled: boolean): void;
  setRunnerRunning(running: boolean, status?: string): void;
  activateWorkspaceTab(tab: string): void;
  markCanvasStale(stale: boolean): void;
}

const SHUTDOWN_TIMEOUT_MS = 20000;

async function publicHttpFileSize(url: string): Promise<number | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  try {
    const response = await fetch(parsed.href, {
      method: 'HEAD', cache: 'no-store', mode: 'cors',
    });
    const size = Number(response.headers.get('Content-Length'));
    if (response.ok && Number.isSafeInteger(size) && size > 0) return size;
  } catch { /* Some range-capable hosts do not implement HEAD. */ }

  try {
    const response = await fetch(parsed.href, {
      headers: { Range: 'bytes=0-0' }, cache: 'no-store', mode: 'cors',
    });
    const match = /^bytes\s+0-0\/(\d+)$/i.exec(response.headers.get('Content-Range') || '');
    await response.body?.cancel();
    const size = Number(match?.[1]);
    return response.status === 206 && Number.isSafeInteger(size) && size > 0 ? size : null;
  } catch { return null; }
}

function graphNeedsGracefulStop(deps: RunSessionDeps): boolean {
  return deps.state.insts.some(i => i.id === SIGMF_SINK_ID && i.enabled && !i.bypassed);
}

function requestRunnerShutdown(deps: RunSessionDeps, frame: HTMLIFrameElement): Promise<void> {
  const target = frame.contentWindow;
  if (!target) return Promise.resolve();
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== target || event.origin !== location.origin) return;
      if (event.data?.type === 'gr-shutdown-done') finish();
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => {
      deps.log('note: the flowgraph did not stop cleanly; the recording may be truncated');
      finish();
    }, SHUTDOWN_TIMEOUT_MS);
    target.postMessage({ type: 'gr-shutdown' }, location.origin);
  });
}

/**
 * `unattended` means nobody is at the keyboard to answer a question: Graham's
 * runs, and anything else automated. A gate that exists to ask a human is then
 * *declined* rather than shown, because a modal waiting for a click that will
 * never come does not stop a run — it hangs whoever asked for one, with no
 * timeout anywhere on the path. Declining reports through the same
 * `cannot run:` line every other refusal here uses, which the caller already
 * reads back and can act on.
 */
export interface RunOptions { unattended?: boolean }

export async function runFlowgraph(deps: RunSessionDeps, session: RunSessionState,
                                   options: RunOptions = {}): Promise<string | null> {
  if (session.active || session.starting || session.finishing) {
    deps.log(session.finishing
      ? 'cannot run: the previous recording is still being finished'
      : session.starting
        ? 'cannot run: a flowgraph is already being prepared'
        : 'cannot run: stop the current flowgraph before starting it again');
    return null;
  }
  session.starting = true;
  deps.setExecuteEnabled(false);
  try {
    return await prepareFlowgraph(deps, session, options);
  } finally {
    session.starting = false;
    deps.setExecuteEnabled(!session.active && !session.finishing);
  }
}

async function prepareFlowgraph(deps: RunSessionDeps, session: RunSessionState,
                                options: RunOptions): Promise<string | null> {
  const { state, trainingSession: getTrainingSession, log, validateGraph, select, askToRunUnpacedFlowgraph,
    usbRadios: USB_RADIOS, showUsbPreparationProblem, sigmfOutputDirsByToken,
    newLocalFileToken, unacceptedJsSources, askToRunJavaScript,
    resolveRemoteRecording, localFilesByToken, sigmfBindingsByToken,
    recordingPathForBlock, grcTextForRun, buildGrcDoc, snapshot,
    localFileParams: LOCAL_FILE_PARAMS, optionsId: OPTIONS_ID, layoutId: LAYOUT_ID,
    httpRecordingId: HTTP_RECORDING_ID, httpRecordingParam: HTTP_RECORDING_PARAM,
    httpRecordingPrefix: HTTP_RECORDING_PREFIX } = deps;
  const trainingSession = getTrainingSession();
  if (trainingSession && !trainingSession.complete(state.insts, state.conns)) {
    const counts = trainingSession.counts(state.insts, state.conns);
    const blocks = counts.totalBlocks - counts.filledBlocks;
    const connections = counts.totalConnections - counts.filledConnections;
    log(`cannot run training flowgraph: ${blocks} block${blocks === 1 ? '' : 's'} and ` +
        `${connections} connection${connections === 1 ? '' : 's'} still to complete`);
    return null;
  }
  const errors = validateGraph().filter(issue => issue.blocking);
  if (errors.length) {
    const first = errors[0];
    log(`cannot run: ${errors.length} validation error${errors.length === 1 ? '' : 's'}`);
    for (const issue of errors) {
      const block = state.insts.find(inst => inst.uid === issue.uid);
      log(`  ${block?.name || block?.id || issue.uid}: ${issue.message}`);
    }
    select(first.uid);
    return null;
  }
  // Both singletons are placed automatically, so neither counts as something
  // the reader put on the canvas to run.
  if (!state.insts.some(i => i.id !== OPTIONS_ID && i.id !== LAYOUT_ID)) {
    log('nothing to run — add some blocks'); return null;
  }
  if (options.unattended) {
    // The same condition the dialog below asks about, answered without one.
    if (deps.isUnpacedFlowgraph()) {
      log('cannot run: the flowgraph has no rate limit — add a Throttle ' +
          '(blocks_throttle2) at the highest sample rate in it, or a naturally ' +
          'paced block such as an audio device or an SDR');
      return null;
    }
  } else if (!await askToRunUnpacedFlowgraph()) {
    log('cancelled: the flowgraph has no rate limit');
    return null;
  }
  // The one thing that must happen under the Run click itself: WebUSB's
  // requestDevice() needs a user gesture, and neither the runner's constructor
  // nor its worker has one. Everything below this point may await freely; this
  // may not, so it comes before the first await that is not part of the prompt.
  for (const radio of USB_RADIOS) {
    const problem = await radio.prepare(state.insts);
    if (!problem) continue;
    const message = typeof problem === 'string' ? problem : problem.message;
    log(`cannot run: ${message}`);
    if (typeof problem !== 'string') showUsbPreparationProblem(problem);
    const block = state.insts.find(i => radio.owns(i) && i.enabled && !i.bypassed);
    if (block) select(block.uid);
    return null;
  }

  // Where a SigMF Sink writes, for the same reason: showDirectoryPicker() needs
  // a user gesture, and the runner has none. Only for a sink with no folder
  // bound yet -- a reader who chose one in the block's own Properties dialog is
  // never asked twice, and where the browser has no such API there is nothing to
  // ask for and the recording is downloaded at the end instead.
  for (const block of state.insts) {
    if (block.id !== SIGMF_SINK_ID || !block.enabled || block.bypassed) continue;
    if (!canPickOutputDirectory()) continue;
    const bound = block.localFileToken
      ? sigmfOutputDirsByToken.get(block.localFileToken) : undefined;
    if (bound) {
      // A handle from earlier in the session can have lost its permission.
      const state = await (bound as any).queryPermission?.({ mode: 'readwrite' });
      if (state === 'granted') continue;
      const granted = await (bound as any).requestPermission?.({ mode: 'readwrite' });
      if (granted === 'granted') continue;
      sigmfOutputDirsByToken.delete(block.localFileToken!);
    }
    try {
      const dir = await pickOutputDirectory();
      const token = block.localFileToken || newLocalFileToken();
      block.localFileToken = token;
      sigmfOutputDirsByToken.set(token, dir);
    } catch {
      // Dismissed; a blocked folder chosen and then dismissed, which throws
      // identically; or -- with a WebUSB prompt already having spent this
      // click's transient activation -- refused outright. The block's own dialog
      // has a folder button carrying its own gesture, which covers the last.
      log(`cannot run: choose a folder for "${block.name}". ` +
          `${SIGMF_OUTPUT_PICKER_HELP} You can also set it ahead of time in the ` +
          `block's properties with "Choose folder…".`);
      select(block.uid);
      return null;
    }
  }

  // Microphone permission for Audio Source, for the same reason and under the
  // same click, though with more slack than WebUSB: getUserMedia() does not
  // consume the transient activation the prompt above may already have spent,
  // it only wants the prompt to belong to something the reader did.
  const audioProblem = await prepareAudioCapture(state.insts);
  if (audioProblem) {
    log(`cannot run: ${audioProblem}`);
    const block = state.insts.find(i => i.id === AUDIO_SOURCE_ID && i.enabled && !i.bypassed);
    if (block) select(block.uid);
    return null;
  }

  // Consent for JavaScript that did not come from this session. It sits here,
  // after the USB prompt (which must be first: it needs the user gesture) and
  // before anything is fetched or bound, so a "no" costs nothing.
  const pendingJs = unacceptedJsSources();
  if (pendingJs.length && !await askToRunJavaScript(pendingJs)) {
    log('cancelled: the flowgraph’s JavaScript was not accepted');
    select(pendingJs[0].block.uid);
    return null;
  }

  const recordingFiles: RunnerInputFile[] = [];
  const fileOverrides = new Map<string, string>();
  const addedPaths = new Set<string>();
  for (const block of state.insts) {
    if (!block.enabled || block.bypassed) continue;

    // A hosted recording: the runner's factory derives '/recordings/<key>.sigmf-data'
    // from the block's own parameter, so all the editor owes it is the URL and
    // size to read that path through. Nothing is rewritten in the .grc.
    if (block.id === RECORDING_ID) {
      const key = String(block.params[RECORDING_PARAM] || '');
      const recording = key ? await resolveRemoteRecording(recordingDataPath(key)) : undefined;
      if (!recording) {
        log(key
          ? `cannot run: recording "${key}" for "${block.name}" is unavailable`
          : `cannot run: choose a recording for "${block.name}"`);
        select(block.uid);
        return null;
      }
      const path = recordingDataPath(key);
      if (!addedPaths.has(path)) {
        recordingFiles.push({
          kind: 'http', path, url: recording.downloadUrl, size: recording.byteLength,
        });
        addedPaths.add(path);
      }
      continue;
    }

    // A file on another origin: the browser reads it directly, so its size —
    // and with it whether the host answers ranges to this origin at all — is
    // settled here rather than in the reader worker.
    if (block.id === HTTP_RECORDING_ID) {
      const url = String(block.params[HTTP_RECORDING_PARAM] || '').trim();
      const size = url ? await publicHttpFileSize(url) : null;
      if (size === null) {
        log(url
          ? `cannot run: "${url}" for "${block.name}" is not a readable public ` +
            `HTTP(S) file (it must answer range requests and allow this origin)`
          : `cannot run: give "${block.name}" a URL`);
        select(block.uid);
        return null;
      }
      const path = HTTP_RECORDING_PREFIX + encodeURIComponent(url);
      fileOverrides.set(block.name, path);
      if (!addedPaths.has(path)) {
        recordingFiles.push({ kind: 'http', path, url, size });
        addedPaths.add(path);
      }
      continue;
    }

    // A SigMF recording on this computer: the .sigmf-data reads through the same
    // /local-files/... path a File Source's file does, with the .sigmf-meta text
    // riding alongside it so the runner can turn the recording's captures and
    // annotations into stream tags.
    if (block.id === SIGMF_SOURCE_ID) {
      const bound = block.localFileToken
        ? sigmfBindingsByToken.get(block.localFileToken) : undefined;
      if (!bound) {
        const saved = String(block.params[SIGMF_FILE_PARAM] || '');
        log(saved
          ? `cannot run: "${saved}" is not open in this session; open "${block.name}" ` +
            `and choose ${saved}${SIGMF_DATA_SUFFIX} and ${saved}${SIGMF_META_SUFFIX} ` +
            `again with Browse`
          : `cannot run: choose a recording for "${block.name}" with Browse`);
        select(block.uid);
        return null;
      }
      const path = `/local-files/${block.localFileToken}/` +
        `${encodeURIComponent(bound.base)}${SIGMF_DATA_SUFFIX}`;
      fileOverrides.set(block.name, path);
      if (!addedPaths.has(path)) {
        recordingFiles.push({
          kind: 'local', path, file: bound.data, meta: bound.metaText,
        });
        addedPaths.add(path);
      }
      continue;
    }

    // Writing a recording. The destination is a folder handle where the browser
    // has one and nothing at all where it does not; the runner's writer worker
    // buffers and downloads in the second case, which is why an unbound sink is
    // not an error here the way an unbound source is.
    if (block.id === SIGMF_SINK_ID) {
      const base = sanitizeSigmfBase(String(block.params[SIGMF_FILE_PARAM] || ''));
      if (!base) {
        log(`cannot run: give "${block.name}" a recording name`);
        select(block.uid);
        return null;
      }
      const token = block.localFileToken || block.uid;
      const dir = block.localFileToken
        ? sigmfOutputDirsByToken.get(block.localFileToken) ?? null : null;
      const path = `${SIGMF_OUTPUT_PREFIX}${token}/${encodeURIComponent(base)}`;
      fileOverrides.set(block.name, path);
      if (!addedPaths.has(path)) {
        recordingFiles.push({ kind: 'output', path, base, dir });
        addedPaths.add(path);
      }
      if (!dir)
        log(`note: "${block.name}" will download ${sigmfSinkFileNames(base).join(' and ')} ` +
            `when the flowgraph stops; the recording is held in memory until then`);
      continue;
    }

    const fileParam = LOCAL_FILE_PARAMS[block.id];
    if (!fileParam) continue;
    const savedPath = String(block.params[fileParam] || '');
    if (block.localFileToken) {
      const file = localFilesByToken.get(block.localFileToken);
      if (!file) {
        log(`cannot run: choose the local file for "${block.name}" again`);
        select(block.uid);
        return null;
      }
      const path = `/local-files/${block.localFileToken}/${encodeURIComponent(file.name)}`;
      fileOverrides.set(block.name, path);
      if (!addedPaths.has(path)) {
        recordingFiles.push({ kind: 'local', path, file });
        addedPaths.add(path);
      }
      continue;
    }

    // An Image File Source with no local picture names a URL the runner fetches
    // for itself, so there is nothing to bind — only an empty field to catch.
    if (block.id === 'paint_image_source') {
      if (!savedPath) {
        log(`cannot run: choose an image for "${block.name}" with Browse, or type a URL`);
        select(block.uid);
        return null;
      }
      continue;
    }

    // File Source opens a file on this computer and nothing else, exactly as
    // native GNU Radio's does; a .grc keeps only the file's name, so a session
    // that has not picked it has nothing to open. Hosted recordings are GR
    // World Recording's job.
    if (!savedPath) {
      log(`cannot run: choose a file for "${block.name}" with Browse`);
    } else {
      log(`cannot run: no local file is bound to "${block.name}"; ` +
          `open its properties and choose "${savedPath}" with Browse, ` +
          `or use GR World Recording for a hosted recording`);
    }
    select(block.uid);
    return null;
  }
  for (const file of recordingFiles) {
    if (file.kind === 'local' && file.file.size === 0) {
      const block = state.insts.find(item => fileOverrides.get(item.name) === file.path);
      log(`cannot run: local file for "${block?.name || 'File Source'}" is empty`);
      if (block) select(block.uid);
      return null;
    }
    if (file.kind === 'http' && file.size === 0) {
      const block = state.insts.find(item => item.id === RECORDING_ID &&
        recordingPathForBlock(item) === file.path);
      log(`cannot run: recording for "${block?.name || 'GR World Recording'}" is empty`);
      if (block) select(block.uid);
      return null;
    }
  }
  // The runner parses native .grc directly (it lowers disabled/bypassed blocks
  // and variables itself). We hand it a *resolved* doc — parameter expressions
  // evaluated to concrete values — since the runner can't evaluate expressions;
  // the saved/shared .grc keeps the raw expressions.
  if (session.pendingToken) session.pendingFiles.delete(session.pendingToken);
  const token = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  session.pendingToken = token;
  session.pendingFiles.set(token, recordingFiles);
  // The editor's own ?scheduler= is forwarded to the runner, where it overrides
  // whatever the flowgraph's Options block says; ?rounds= goes with it, since a
  // deterministic run's budget is useless without a way to set it. Together they
  // make the choice testable from the address bar without editing (and
  // re-saving) the flowgraph. See docs/schedulers.md.
  const here = new URLSearchParams(location.search);
  const passthrough = ['scheduler', 'rounds']
    .map(key => [key, here.get(key)] as const)
    .filter(([, value]) => value)
    .map(([key, value]) => `&${key}=${encodeURIComponent(value!)}`)
    .join('');
  const url = '/runner/build/runner.html?recordingToken=' + encodeURIComponent(token) +
    passthrough + '#' + encodeURIComponent(grcTextForRun(fileOverrides));
  const frame = deps.frame;
  deps.runEmpty.hidden = true;
  frame.hidden = false;
  deps.setRunnerRunning(true);
  deps.activateWorkspaceTab('qtgui');
  // Claims the frame. The generation check remains a final guard against any
  // stale asynchronous unload, though Run is also refused while one is pending.
  ++session.generation;
  frame.src = url;
  const doc = buildGrcDoc();
  log('▶ running ' + doc.blocks.length + ' blocks, ' + doc.connections.length + ' connections');
  session.runningGraphSnapshot = JSON.stringify(snapshot());
  session.runningNeedsGracefulStop = graphNeedsGracefulStop(deps);
  session.active = true;
  return token;
}

export function stopFlowgraph(deps: RunSessionDeps, session: RunSessionState): void {
  if (session.finishing || !session.active) return;
  const frame = deps.frame;
  // This was captured from the graph that actually started. The canvas may
  // already have been edited or replaced by the time Stop is pressed.
  const finishing = session.runningNeedsGracefulStop
    ? requestRunnerShutdown(deps, frame) : null;
  session.finishing = !!finishing;
  const generation = session.generation;

  if (session.pendingToken) {
    session.pendingFiles.delete(session.pendingToken);
    session.pendingToken = null;
  }
  // The UI returns to the editor at once either way. loadFlowgraphAnimated
  // depends on that being synchronous: its fly-in cannot measure a hidden canvas.
  frame.hidden = true;
  deps.runEmpty.hidden = false;
  session.active = false;
  session.runningGraphSnapshot = null;
  session.runningNeedsGracefulStop = false;
  deps.setRunnerRunning(false);
  deps.activateWorkspaceTab('editor');

  const unload = () => {
    // Only if this is still the run we were asked to stop.
    if (generation !== session.generation) return;
    frame.src = 'about:blank';   // unloading the iframe stops its WASM workers
    session.finishing = false;
    deps.setRunnerRunning(false);
    deps.log('■ flowgraph stopped');
  };
  if (finishing) {
    // Hidden, but still running: the writer worker needs the frame alive to
    // flush the tail of the recording and write the .sigmf-meta.
    deps.log('■ finishing the recording…');
    void finishing.then(unload);
  } else {
    unload();
  }
}
export function takeRecordingFiles(session: RunSessionState, token: string): RunnerInputFile[] {
  const files = session.pendingFiles.get(token) || [];
  session.pendingFiles.delete(token);
  if (session.pendingToken === token) session.pendingToken = null;
  return files;
}

export function updateRunningCanvasState(deps: RunSessionDeps, session: RunSessionState): void {
  if (!session.active || !session.runningGraphSnapshot) return;
  deps.markCanvasStale(JSON.stringify(deps.snapshot()) !== session.runningGraphSnapshot);
}
