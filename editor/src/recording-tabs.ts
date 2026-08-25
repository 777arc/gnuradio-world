import type { Inst } from './graph-model';
import type { EditorGraphState } from './editor-state';
import {
  RECORDING_ID,
  RECORDING_PARAM,
  displaySi,
  normalizeRecordingKey,
  recordingDataPath,
  recordingViewUrl,
  type ExampleRecording,
} from './recording-catalog';
import {
  SIGMF_DATA_SUFFIX,
  SIGMF_SOURCE_ID,
  type SigmfBinding,
} from './sigmf-blocks';
import type {
  WorkspaceTab,
  WorkspaceTabEntry,
  WorkspaceTabsController,
} from './workspace-tabs';
import { tabContainer } from './workspace-tabs';

export interface RecordingTabsDeps {
  state: EditorGraphState;
  workspaceTabs: WorkspaceTabEntry[];
  workspaceController: WorkspaceTabsController;
  workspaceContent: HTMLElement;
  workspaceTabsElement: HTMLElement;
  wireWorkspaceTab(entry: WorkspaceTabEntry): void;
  activateWorkspaceTab(tab: WorkspaceTab): void;
  localFilesByToken: Map<string, File>;
  sigmfBindingsByToken: Map<string, SigmfBinding>;
  scope(): Record<string, any>;
  resolveParamsForRun(block: Inst, scope: Record<string, any>): Record<string, any>;
  bindRemoteRecording(recording: ExampleRecording): string;
  setUrlFragment(patch: { recording: string | null }): void;
  closePaletteDrawer(): void;
  resolveRemoteRecording(path: string): Promise<ExampleRecording | undefined>;
  render(): void;
  recordHistory(): void;
}

export function createRecordingTabs(deps: RecordingTabsDeps) {
  const {
    state,
    workspaceTabs,
    workspaceController: workspaceTabController,
    workspaceContent,
    workspaceTabsElement,
    wireWorkspaceTab,
    activateWorkspaceTab,
    localFilesByToken,
    sigmfBindingsByToken,
    resolveParamsForRun,
    bindRemoteRecording,
    setUrlFragment,
    closePaletteDrawer,
    resolveRemoteRecording,
    render,
    recordHistory,
  } = deps;

  interface RecordingSource {
    key: string;            // '/recordings/<path>' or 'local:<token>'
    label: string;          // tab text
    title: string;          // tooltip: the recording key or file name
    name: string;           // display name handed to the recording view
    kind: 'remote' | 'local';
    path: string;           // remote: the /recordings/... path this resolves through
    token?: string;         // local: key into localFilesByToken
    datatype?: string;      // local: SigMF datatype inferred from the block
    sampleRate?: number;    // local: samp_rate from the flowgraph, when numeric
    // A SigMF Source's real .sigmf-meta. The only local source that has one --
    // everything else local gets synthesizedSigmfMeta(), which infers a datatype
    // and a rate and has no captures or annotations to offer at all.
    metaText?: string;
    file?: File;            // local: the samples, when the block holds them itself
    offset: number;         // the block's sample selection
    length: number;
  }
  
  interface RecordingTab {
    source: RecordingSource;
    entry: WorkspaceTabEntry;
    label: HTMLElement;
    close: HTMLButtonElement;
    status: HTMLElement;
    frame: HTMLIFrameElement | null;
    opening: boolean;
    ready: boolean;
    pinned: boolean;        // opened without a block behind it; survives sync
    viewerOffset: number | null;
    viewerLength: number | null;
    blobUrls: string[];
  }
  
  const recordingTabs = new Map<string, RecordingTab>();
  let recordingTabCounter = 0;
  
  const isRecordingTabId = (id: WorkspaceTab): boolean => id.startsWith('rec:');
  const recordingTabKey = (id: WorkspaceTab): string => id.slice(4);
  
  // A local file has no SigMF metadata, so the datatype is inferred from the File
  // Source itself. GNU Radio reads interleaved I/Q integers as a scalar stream fed
  // into a converter, so a short/byte source whose only sink is that converter is
  // a complex recording — the same shape addRecordingBlock() builds for ci16.
  const FILE_SOURCE_DATATYPES: Record<string, string> = {
    complex: 'cf32_le', float: 'rf32_le', int: 'ri32_le', short: 'ri16_le', byte: 'ri8',
  };
  const INTERLEAVED_CONVERTERS: Record<string, { from: string; datatype: string }> = {
    blocks_interleaved_short_to_complex: { from: 'short', datatype: 'ci16_le' },
    blocks_interleaved_char_to_complex: { from: 'byte', datatype: 'ci8' },
  };
  const SIGMF_SAMPLE_BYTES: Record<string, number> = {
    cf32_le: 8, rf32_le: 4, ri32_le: 4, ci16_le: 4, ri16_le: 2, ci8: 2, ri8: 1,
  };
  
  function localRecordingDatatype(block: Inst): string {
    const type = String(block.params.type || 'complex');
    const scalar = FILE_SOURCE_DATATYPES[type] || 'cf32_le';
    if (Number(block.params.vlen ?? 1) > 1) return scalar;
    const sinks = state.conns.filter(c => c.from === block.uid)
      .map(c => state.insts.find(i => i.uid === c.to)?.id || '');
    if (sinks.length !== 1) return scalar;
    const converter = INTERLEAVED_CONVERTERS[sinks[0]];
    return converter && converter.from === type ? converter.datatype : scalar;
  }
  
  function fileSourceSelection(block: Inst): { offset: number; length: number } {
    const resolved = resolveParamsForRun(block, deps.scope());
    const samples = (value: any): number => {
      const number = Number(value);
      return Number.isSafeInteger(number) && number > 0 ? number : 0;
    };
    return { offset: samples(resolved.offset), length: samples(resolved.length) };
  }
  
  // The three blocks that can have a recording behind them: File Source, for raw
  // samples in a file on this computer; SigMF Source, for a SigMF recording on
  // this computer; and GR World Recording, for a hosted one.
  const RECORDING_BLOCK_IDS = new Set(['blocks_file_source', SIGMF_SOURCE_ID, RECORDING_ID]);
  
  function recordingSourceFor(block: Inst): RecordingSource | null {
    const selection = fileSourceSelection(block);
    if (block.id === RECORDING_ID) {
      let path: string;
      try { path = recordingDataPath(String(block.params[RECORDING_PARAM] || '')); }
      catch { return null; }     // no recording chosen yet, or an unusable key
      // The label comes from the key, not from the recordings index, so drawing
      // the tab never has to wait on (or trigger) a fetch.
      const name = String(block.params[RECORDING_PARAM]);
      return {
        key: path, label: name.split('/').pop() || name, title: name, name,
        kind: 'remote', path,
        ...selection,
      };
    }
    if (!block.localFileToken) return null;
  
    // A SigMF Source is the one local block whose recording describes itself, so
    // its tab is driven by the real .sigmf-meta rather than one inferred from the
    // block's parameters -- which is what puts the recording's own annotations on
    // the spectrogram.
    if (block.id === SIGMF_SOURCE_ID) {
      const bound = sigmfBindingsByToken.get(block.localFileToken);
      if (!bound) return null;   // picked in a previous session; the Files are gone
      const name = bound.base + SIGMF_DATA_SUFFIX;
      return {
        key: 'sigmf:' + block.localFileToken,
        label: bound.base, title: name, name,
        kind: 'local', path: name, token: block.localFileToken,
        datatype: bound.datatype,
        sampleRate: bound.sampleRate ?? undefined,
        metaText: bound.metaText,
        file: bound.data,
        ...selection,
      };
    }
  
    const file = localFilesByToken.get(block.localFileToken);
    if (!file) return null;      // picked in a previous session; the File is gone
    const rate = Number(deps.scope()['samp_rate']);
    return {
      key: 'local:' + block.localFileToken,
      label: file.name, title: file.name, name: file.name,
      kind: 'local', path: String(block.params.file || ''), token: block.localFileToken,
      datatype: localRecordingDatatype(block),
      sampleRate: Number.isFinite(rate) && rate > 0 ? rate : undefined,
      file,
      ...selection,
    };
  }
  
  function recordingSources(): RecordingSource[] {
    const sources: RecordingSource[] = [];
    const seen = new Set<string>();
    for (const block of state.insts) {
      if (!RECORDING_BLOCK_IDS.has(block.id)) continue;
      const source = recordingSourceFor(block);
      if (!source || seen.has(source.key)) continue;   // two blocks, one tab
      seen.add(source.key);
      sources.push(source);
    }
    return sources;
  }
  
  function createRecordingTab(source: RecordingSource): RecordingTab {
    const id = ++recordingTabCounter;
    // The button and its close control are siblings inside a group styled as one
    // tab: nesting a button inside a button is invalid, and the close control has
    // to be separately clickable and focusable.
    const group = document.createElement('div'); group.className = 'workspace-tab-group';
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'workspace-tab'; button.id = `tabRecording${id}`;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
    const label = document.createElement('span'); label.className = 'workspace-tab-label';
    button.appendChild(label);
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'workspace-tab-close'; close.textContent = '×';
    close.tabIndex = -1; close.hidden = true;
    group.append(button, close);
  
    const panel = document.createElement('section');
    panel.className = 'workspace-panel recording-pane'; panel.id = `recordingPane${id}`;
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
    button.setAttribute('aria-controls', panel.id);
    const status = document.createElement('div'); status.className = 'rec-pane-status';
    status.textContent = 'Open this tab to load the recording view.';
    panel.appendChild(status);
    workspaceContent.appendChild(panel);
  
    const entry: WorkspaceTabEntry = { id: 'rec:' + source.key, button, panel, container: group };
    wireWorkspaceTab(entry);
    workspaceTabs.push(entry);
    workspaceTabsElement.appendChild(group);
    const tab: RecordingTab = {
      source, entry, label, close, status, frame: null, opening: false, ready: false,
      pinned: false, viewerOffset: null, viewerLength: null, blobUrls: [],
    };
    close.onclick = event => { event.stopPropagation(); closeRecordingTab(tab); };
    return tab;
  }
  
  function destroyRecordingTab(tab: RecordingTab) {
    for (const url of tab.blobUrls) URL.revokeObjectURL(url);
    tabContainer(tab.entry).remove();
    tab.entry.panel.remove();   // drops the iframe, and with it the viewer's fetches
    const index = workspaceTabs.indexOf(tab.entry);
    if (index >= 0) workspaceTabs.splice(index, 1);
    recordingTabs.delete(tab.source.key);
    // As with #example=, the URL must not go on claiming what is no longer open.
    if (recordingHashKey() === recordingKeyOf(tab)) setUrlFragment({ recording: null });
    if (workspaceTabController.active === tab.entry.id) activateWorkspaceTab('editor');
  }
  
  // The linkable form of what a tab shows: the recording's base key. A locally
  // picked file has none — it exists only for this session — so it is not linkable.
  function recordingKeyOf(tab: RecordingTab): string | null {
    return tab.source.kind === 'remote' ? tab.source.name : null;
  }
  const recordingHashKey = (): string | null =>
    new URLSearchParams(location.hash.slice(1)).get('recording');
  
  // Only a pinned tab has a close button, so a block still owning this
  // recording cannot be closed out from under the canvas.
  function closeRecordingTab(tab: RecordingTab) {
    tab.pinned = false;
    if (recordingSources().some(source => source.key === tab.source.key)) {
      syncRecordingTabs();   // the canvas owns it after all: keep it, drop the ×
      return;
    }
    destroyRecordingTab(tab);
  }
  
  function describeRecordingTab(tab: RecordingTab, source: RecordingSource) {
    tab.source = source;
    tab.label.textContent = source.label;
    tab.entry.button.title = source.title;
    tab.entry.button.setAttribute('aria-label', `Recording ${source.title}`);
    tab.close.title = `Close the recording view of ${source.title} (Delete)`;
    tab.close.setAttribute('aria-label', `Close the recording view of ${source.title}`);
  }
  
  // Called from render(), so it must stay synchronous and free of network calls.
  function syncRecordingTabs() {
    const sources = recordingSources();
    const wanted = new Set(sources.map(source => source.key));
    for (const tab of [...recordingTabs.values()])
      if (!wanted.has(tab.source.key) && !tab.pinned) destroyRecordingTab(tab);
  
    for (const source of sources) {
      let tab = recordingTabs.get(source.key);
      if (!tab) { tab = createRecordingTab(source); recordingTabs.set(source.key, tab); }
      describeRecordingTab(tab, source);
      if (tab.ready &&
          (tab.viewerOffset !== source.offset || tab.viewerLength !== source.length))
        postFileSourceSelection(tab);
    }
  
    // A pinned tab is closable exactly while no block owns its recording;
    // once one does, the canvas is what decides whether the tab exists.
    for (const tab of recordingTabs.values())
      tab.close.hidden = !tab.pinned || wanted.has(tab.source.key);
  
    // Keep the bar in canvas order, with tabs the canvas does not own after them.
    // Only the tab buttons are reordered: re-inserting a panel would re-insert its
    // iframe, which reloads the document inside it.
    const order = [workspaceTabs[0], workspaceTabs[1],
      ...sources.map(source => recordingTabs.get(source.key)!.entry),
      ...[...recordingTabs.values()]
        .filter(tab => !wanted.has(tab.source.key)).map(tab => tab.entry)];
    workspaceTabs.length = 0; workspaceTabs.push(...order);
    const bar = workspaceTabsElement;
    if (order.some((entry, index) => bar.children[index] !== tabContainer(entry)))
      for (const entry of order) bar.appendChild(tabContainer(entry));
  
    if (!workspaceTabs.some(entry => entry.id === workspaceTabController.active))
      activateWorkspaceTab('editor');
  }
  
  // Opens the recording view for a recording nothing on the canvas refers to —
  // the Recordings palette's View control and the #recording= link. The tab is
  // keyed by the same '/recordings/...' path a GR World Recording would produce, so a
  // recording already showing (either way) is revealed rather than duplicated.
  function openRecordingPreview(recording: ExampleRecording) {
    const path = bindRemoteRecording(recording);
    const name = recording.name;
    let tab = recordingTabs.get(path);
    if (!tab) {
      const source: RecordingSource = {
        key: path, label: name.split('/').pop() || name, title: name, name,
        kind: 'remote', path, offset: 0, length: 0,
      };
      tab = createRecordingTab(source);
      recordingTabs.set(path, tab);
      describeRecordingTab(tab, source);
    }
    tab.pinned = true;
    syncRecordingTabs();          // places the tab in the bar and shows its ×
    activateWorkspaceTab(tab.entry.id);   // builds the iframe on first activation
    closePaletteDrawer();         // the drawer would be covering the tab it opened
    // Point the address bar at what is on screen, exactly as loading an example
    // does, so the link can be copied straight out of it and reloaded.
    setUrlFragment({ recording: normalizeRecordingKey(name) });
  }
  
  // A local file is a bare stream of samples: no sample rate, no datatype, nothing
  // the recording view can read. Synthesize the smallest SigMF that describes it
  // from what the flowgraph already says, and label the result as inferred.
  function synthesizedSigmfMeta(source: RecordingSource, file: File): string {
    const datatype = source.datatype || 'cf32_le';
    const global: Record<string, any> = {
      'core:datatype': datatype,
      'core:version': '1.0.0',
      'core:description':
        'Synthesized by GNU Radio World from the File Source parameters; this file carries no SigMF metadata.',
      // Supplying the sample count spares the viewer a HEAD request, which a
      // blob: URL does not reliably answer.
      'traceability:sample_length': Math.floor(file.size / (SIGMF_SAMPLE_BYTES[datatype] || 8)),
    };
    if (source.sampleRate) global['core:sample_rate'] = source.sampleRate;
    return JSON.stringify({ global, captures: [{ 'core:sample_start': 0 }], annotations: [] });
  }
  
  function recordingPaneMessage(tab: RecordingTab, message: string) {
    tab.status.textContent = message;
    tab.status.hidden = false;
  }
  
  function recordingTabForMessage(event: MessageEvent): RecordingTab | null {
    if (event.origin !== location.origin) return null;
    return [...recordingTabs.values()].find(candidate =>
      candidate.frame?.contentWindow === event.source) || null;
  }
  
  function postFileSourceSelection(tab: RecordingTab) {
    if (!tab.ready || !tab.frame?.contentWindow) return;
    const { offset, length } = tab.source;
    tab.frame.contentWindow.postMessage(
      { type: 'gr-file-source-selection', offset, length }, location.origin);
    tab.viewerOffset = offset;
    tab.viewerLength = length;
  }
  
  function applyRecordingSelection(event: MessageEvent, data: any): boolean {
    const tab = recordingTabForMessage(event);
    if (!tab) return false;
  
    const offset = Number(data.offset);
    const length = Number(data.length);
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 0) return false;
  
    // Remember what the viewer already shows before render() synchronizes the
    // tabs, so the resulting block edit is not immediately echoed back.
    tab.viewerOffset = offset;
    tab.viewerLength = length;
  
    let changed = false;
    for (const block of state.insts) {
      if (!RECORDING_BLOCK_IDS.has(block.id) ||
          recordingSourceFor(block)?.key !== tab.source.key) continue;
      const current = fileSourceSelection(block);
      if (current.offset === offset && current.length === length) continue;
      block.params.offset = offset;
      block.params.length = length;
      changed = true;
    }
    if (changed) {
      render();
      recordHistory();
    }
    return changed;
  }
  
  async function openRecordingPane(key: string) {
    const tab = recordingTabs.get(key);
    if (!tab || tab.frame || tab.opening) return;
    tab.opening = true;
    try {
      recordingPaneMessage(tab, 'Loading the recording view…');
  
      // The block can be deleted while the bucket index fetch below is in
      // flight; anything created past this point would never be cleaned up.
      if (recordingTabs.get(key) !== tab) return;
  
      let metaUrl: string, dataUrl: string;
      if (tab.source.kind === 'remote') {
        const recording = await resolveRemoteRecording(tab.source.path);
        if (recordingTabs.get(key) !== tab) return;
        if (!recording) {
          recordingPaneMessage(tab, `The recording "${tab.source.title}" is not available.`);
          return;
        }
        metaUrl = recording.metadataUrl;
        dataUrl = new URL(recording.downloadUrl, location.href).href;
      } else {
        const file = tab.source.file;
        if (!file) {
          recordingPaneMessage(tab, tab.source.metaText !== undefined
            ? 'Choose this SigMF Source’s two files again.'
            : 'Choose the local file for this File Source again.');
          return;
        }
        // Blob URLs, not a copy of the file: the viewer reads them with the same
        // ranged requests it uses for an HTTP recording.
        dataUrl = URL.createObjectURL(file);
        // A SigMF Source brought its own metadata; everything else local gets one
        // inferred from the block, and is told so.
        metaUrl = URL.createObjectURL(new Blob(
          [tab.source.metaText ?? synthesizedSigmfMeta(tab.source, file)],
          { type: 'application/json' }));
        tab.blobUrls.push(dataUrl, metaUrl);
        if (tab.source.metaText === undefined) {
          const note = document.createElement('div'); note.className = 'rec-pane-note';
          note.textContent = `Metadata inferred from the File Source: ${tab.source.datatype}` +
            (tab.source.sampleRate ? ` at ${displaySi(tab.source.sampleRate, 'Hz')}` : ', sample rate unknown') +
            '. A local file carries no SigMF metadata.';
          tab.entry.panel.insertBefore(note, tab.status);
        }
      }
  
      const frame = document.createElement('iframe');
      frame.className = 'rec-pane-frame';
      frame.title = `Recording view — ${tab.source.name}`;
      frame.addEventListener('load', () => { tab.status.hidden = true; });
      tab.entry.panel.appendChild(frame);
      tab.frame = frame;
      frame.src = recordingViewUrl(metaUrl, dataUrl, tab.source.name);
    } catch (error) {
      recordingPaneMessage(tab, `The recording view could not be opened: ${error}`);
    } finally {
      tab.opening = false;
    }
  }
  
  
  return {
    isRecordingTabId,
    recordingTabKey,
    syncRecordingTabs,
    openRecordingPreview,
    openRecordingPane,
    applyRecordingSelection,
    recordingSourceFor,
    handleReady(event: MessageEvent): void {
      const tab = recordingTabForMessage(event);
      if (!tab) return;
      tab.ready = true;
      postFileSourceSelection(tab);
    },
    close(key: string): boolean {
      const tab = recordingTabs.get(key);
      if (!tab || tab.close.hidden) return false;
      closeRecordingTab(tab);
      return true;
    },
  };
}

