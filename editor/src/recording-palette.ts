import {
  buildRecordingTree,
  displayBytes,
  displayRecordingValue,
  displaySi,
  recordingTreeCount,
  recordingUrl,
  sigmfFileSourceFormat,
  type ExampleRecording,
  type FileSourceFormat,
  type RecordingDirectory,
} from './recording-catalog';
import { makePaletteSearch } from './palette-tree';

interface RecordingEntry {
  item: HTMLElement;
  text: string;
}

export interface RecordingPaletteDeps {
  loadExampleRecordings(): Promise<ExampleRecording[]>;
  openRecordingPreview(recording: ExampleRecording): void;
  copyRecordingUrl(name: string): Promise<void>;
  addRecordingBlock(recording: ExampleRecording, format: FileSourceFormat): Promise<void>;
  closePaletteDrawer(): void;
  log(message: string): void;
}

export function createRecordingPalette(deps: RecordingPaletteDeps) {
  const {
    loadExampleRecordings,
    openRecordingPreview,
    copyRecordingUrl,
    addRecordingBlock,
    closePaletteDrawer,
    log,
  } = deps;

  function makeRecordingItem(recording: ExampleRecording): HTMLElement {
    const item = document.createElement('article'); item.className = 'rec-item';
    item.tabIndex = 0; item.setAttribute('role', 'button');
    const head = document.createElement('div'); head.className = 'rec-head';
    const title = document.createElement('div'); title.className = 'rec-title';
    // The containing directory rows already show the relative path. Keep the
    // card itself to the recording's basename instead of repeating that path.
    title.textContent = recording.name.split('/').filter(Boolean).pop() || recording.name;
    // View and the copy-link button open the recording view without touching the
    // canvas, so they are offered even for a datatype GR World Recording cannot
    // represent — that recording is otherwise not viewable here at all. Both stop
    // propagation: clicking one must not also drop a block on the canvas.
    const view = document.createElement('button'); view.className = 'rec-view';
    view.type = 'button'; view.textContent = 'View';
    view.title = `Open the recording view of "${recording.name}" without adding it to the flowgraph`;
    view.setAttribute('aria-label', `View recording ${recording.name}`);
    view.onclick = event => { event.stopPropagation(); openRecordingPreview(recording); };
    // A word rather than the examples tab's 🔗: a color emoji ignores `color`, and
    // these two read as a pair only if they are the same blue.
    const link = document.createElement('button'); link.className = 'rec-link';
    link.type = 'button'; link.textContent = 'Link';
    link.title = `Copy a link to this recording (${recordingUrl(recording.name)})`;
    link.setAttribute('aria-label', `Copy a link to recording ${recording.name}`);
    link.onclick = event => { event.stopPropagation(); void copyRecordingUrl(recording.name); };
    head.append(title, view, link);
    const props = document.createElement('dl'); props.className = 'rec-props';
    const addProperty = (label: string, value: string | number | null) => {
      const key = document.createElement('dt'); key.textContent = label;
      const val = document.createElement('dd'); val.textContent = displayRecordingValue(value);
      props.append(key, val);
    };
    addProperty('Data Type', recording.datatype);
    addProperty('Sample Rate', displaySi(recording.sampleRate, 'Hz'));
    addProperty('Author', recording.author);
    addProperty('Samples', displaySi(recording.sampleCount, ''));
    // Both files and the index come directly from the recording bucket.
    const sizeKey = document.createElement('dt'); sizeKey.textContent = 'Size';
    const sizeVal = document.createElement('dd'); sizeVal.className = 'rec-size';
    sizeVal.append(displayBytes(recording.byteLength));
    const addDownloadLink = (label: string, url: string, fileName: string) => {
      const link = document.createElement('a'); link.className = 'rec-dl';
      // download= is a file name, not a path: a recording in a collection
      // sub-directory still saves under its own base name.
      link.href = url; link.download = fileName.split('/').pop()!; link.rel = 'noopener';
      link.textContent = label;
      // Clicking a link must not also drop a block on the canvas.
      link.onclick = event => event.stopPropagation();
      sizeVal.append(link);
    };
    addDownloadLink('data file', recording.downloadUrl, recording.dataFile);
    addDownloadLink('meta file', recording.metadataUrl, recording.metaFile);
    props.append(sizeKey, sizeVal);
    const streamNote = document.createElement('div'); streamNote.className = 'rec-progress';
    streamNote.textContent = 'Read on demand in bounded byte ranges while the flowgraph runs.';
    item.append(head, props, streamNote);
  
    const format = sigmfFileSourceFormat(recording.datatype);
    if (!format) {
      // The only badge left: what the card cannot do. That clicking it adds the
      // recording to the flowgraph needs no label.
      const badge = document.createElement('span'); badge.className = 'rec-badge';
      badge.textContent = 'Unsupported';
      head.append(badge);
      item.setAttribute('aria-disabled', 'true');
      item.title = `GR World Recording cannot directly represent ${recording.datatype || 'this datatype'}`;
      return item;
    }
  
    const useRecording = async () => {
      try {
        closePaletteDrawer();
        await addRecordingBlock(recording, format);
      } catch (error) {
        log(`recording "${recording.name}" could not be added: ${error}`);
      }
    };
    item.onclick = () => { void useRecording(); };
    item.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // The download links and the View / copy-link buttons act for themselves.
      if ((event.target as HTMLElement)?.closest('a,button')) return;
      event.preventDefault(); void useRecording();
    };
    return item;
  }

  function recordingSearchText(recording: ExampleRecording): string {
    return [recording.name, recording.author, recording.datatype]
      .filter(Boolean).join(' ').toLowerCase();
  }

  function renderRecordingTree(directory: RecordingDirectory, container: HTMLElement,
                               entries: RecordingEntry[]) {
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    for (const child of [...directory.directories.values()].sort((a, b) => byName(a.name, b.name))) {
      const details = document.createElement('details'); details.className = 'rec-directory';
      // Deliberately do not set details.open: every directory, including nested
      // ones, starts collapsed and the browser supplies keyboard disclosure.
      const summary = document.createElement('summary'); summary.className = 'rec-directory-head';
      const name = document.createElement('span'); name.className = 'rec-directory-name';
      name.textContent = child.name;
      const count = document.createElement('span'); count.className = 'rec-directory-count';
      const total = recordingTreeCount(child);
      count.textContent = `${total} recording${total === 1 ? '' : 's'}`;
      summary.append(name, count);
      const contents = document.createElement('div'); contents.className = 'rec-directory-contents';
      renderRecordingTree(child, contents, entries);
      details.append(summary, contents);
      container.append(details);
    }
    for (const recording of [...directory.recordings].sort((a, b) => byName(a.name, b.name))) {
      const item = makeRecordingItem(recording);
      container.append(item);
      entries.push({ item, text: recordingSearchText(recording) });
    }
  }

  async function buildRecordings(panel: HTMLElement) {
    const list = document.createElement('div'); list.className = 'rec-list';
    const status = document.createElement('div'); status.className = 'ex-empty';
    status.textContent = 'Loading recordings…'; panel.append(status);
    let recordings: ExampleRecording[] = [];
    try {
      recordings = await loadExampleRecordings();
    } catch (e) {
      status.textContent = 'Could not load recordings.';
      log('recordings not loaded: ' + e); return;
    }
    if (!recordings.length) { status.textContent = 'No SigMF recordings found.'; return; }
  
    // Search box, matching the Blocks and Example Flowgraphs tabs: every
    // whitespace-separated term has to be found, so "estevez ci16" narrows by
    // collection and datatype at once.
    const { bar: searchBar, input: search } =
      makePaletteSearch('Search recordings…', 'Search SigMF recordings');
    const noMatch = document.createElement('div'); noMatch.className = 'ex-empty'; noMatch.hidden = true;
    const entries: RecordingEntry[] = [];
    let terms: string[] = [];
  
    const refresh = () => {
      const q = terms.join(' ');
      let shown = 0;
      for (const entry of entries) {
        const hit = terms.every(t => entry.text.includes(t));
        entry.item.hidden = !hit;
        if (hit) shown++;
      }
      // A directory stays visible when any descendant is visible, and a search
      // opens the matching paths so a hit is never buried in a collapsed one.
      // Innermost first, so an outer directory sees its children's final state.
      const directories = [...list.querySelectorAll<HTMLDetailsElement>('.rec-directory')].reverse();
      for (const details of directories) {
        const contents = details.querySelector<HTMLElement>(':scope > .rec-directory-contents');
        const hasVisibleChild = !!contents && [...contents.children]
          .some(child => !(child as HTMLElement).hidden);
        details.hidden = !hasVisibleChild;
        if (q && hasVisibleChild) details.open = true;
      }
      if (q) noMatch.textContent = `No SigMF recording matches “${q}”.`;
      noMatch.hidden = !q || shown > 0;
    };
    const onQuery = () => {
      terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      refresh();
    };
    search.oninput = onQuery;
    search.onkeydown = e => {
      if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; onQuery(); }
    };
  
    status.remove(); panel.append(searchBar, list, noMatch);
    renderRecordingTree(buildRecordingTree(recordings), list, entries);
    refresh();
  }
  return { buildRecordings };
}
