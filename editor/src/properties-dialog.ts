import type { ParamDef, RunnableDef } from './block-defs';
import type { Inst, ValidationIssue } from './graph-model';
import type { EditorGraphState } from './editor-state';
import type { WidgetRef } from './gui-layout';
import { layoutColumns, layoutRowHeight, parseTiles, serializeTiles } from './gui-layout';
import { numericOrExpression } from './block-library';
import { NAME_FIELD } from './validation';
import { NOTE_DEFAULT_BG } from './note';
import type { UsbLike, UsbRadio } from './usb-radio';
import { usbApi } from './usb-radio';
import {
  RECORDING_ID,
  displayBytes,
  displaySi,
  isCi16Datatype,
  sigmfFileSourceFormat,
  type ExampleRecording,
} from './recording-catalog';
import {
  canPickOutputDirectory,
  pairSigmfFiles,
  parseSigmfMeta,
  pickOutputDirectory,
  sanitizeSigmfBase,
  sigmfSinkFileNames,
  sigmfStreamFormat,
  SIGMF_ACCEPT,
  SIGMF_DATA_SUFFIX,
  SIGMF_OPEN_DTYPE,
  SIGMF_OUTPUT_PICKER_HELP,
  SIGMF_SAVE_DTYPE,
  SIGMF_SOURCE_ID,
  type SigmfBinding,
} from './sigmf-blocks';
import {
  EPY_BLOCK_ID,
  EPY_CODE_DTYPE,
  EPY_IO_CACHE_PARAM,
  pythonRuntime,
  setEpySourceError,
} from './epy';
import {
  JS_BLOCK_ID,
  JS_CODE_DTYPE,
  JS_IO_PARAM,
  JS_LOCAL_SOURCE_PARAM,
  acceptJsSource,
  jsIntrospector,
  parseJsIo,
  setJsSourceError,
  type JsBlockIo,
} from './js-block';
import {
  colorField,
  colorPropertyRow,
  optionCombo,
  propertyFieldDtype,
  usesOptionCombo,
} from './property-fields';
import { fieldIssue, setFieldError } from './validation-ui';

export interface PropertiesDialogDeps {
  state: EditorGraphState;
  closeMenu(): void;
  defFor(inst: Inst): RunnableDef;
  blockIdVisible(inst: Inst): boolean;
  localFileParams: Record<string, string>;
  localFileAccept: Record<string, string>;
  recordingDtype: string;
  layoutDtype: string;
  newLocalFileToken(): string;
  loadExampleRecordings(): Promise<ExampleRecording[]>;
  radioForDtype(dtype?: string): UsbRadio | undefined;
  localFilesByToken: Map<string, File>;
  sigmfBindingsByToken: Map<string, SigmfBinding>;
  sigmfOutputDirsByToken: Map<string, FileSystemDirectoryHandle>;
  log(message: string): void;
  validateGraph(blocks?: Inst[]): ValidationIssue[];
  remapConnectionsForPortChange(inst: Inst, params: Record<string, any>): void;
  render(): void;
  guiWidgets(): WidgetRef[];
  openJsCodeModal(options: {
    title: string;
    source: string;
    apply(source: string, io: JsBlockIo | null): void;
    uid: string;
    onSave(): void;
    render(): void;
  }): void;
  applyJsIo(params: Record<string, any>, io: JsBlockIo): void;
  sigmfSampRateToPublish(id: string, params: Record<string, any>, token?: string):
    { rate: number; source: string } | null;
  applySampRateFromSigmf(rate: number, source: string): boolean;
  sigmfNeedsIShortToComplex(id: string, token?: string): boolean;
  attachIShortToComplex(block: Inst): boolean;
  select(uid: string | null, additive?: boolean): void;
  recordHistory(): void;
  showFieldColors(): boolean;
}

export function showPropertiesDialog(inst: Inst, deps: PropertiesDialogDeps) {
  const {
    state,
    closeMenu,
    defFor,
    blockIdVisible,
    localFileParams: LOCAL_FILE_PARAMS,
    localFileAccept: LOCAL_FILE_ACCEPT,
    recordingDtype: RECORDING_DTYPE,
    layoutDtype: LAYOUT_DTYPE,
    newLocalFileToken,
    loadExampleRecordings,
    radioForDtype,
    localFilesByToken,
    sigmfBindingsByToken,
    sigmfOutputDirsByToken,
    log,
    validateGraph,
    remapConnectionsForPortChange,
    render,
    guiWidgets,
    openJsCodeModal,
    applyJsIo,
    sigmfSampRateToPublish,
    applySampRateFromSigmf,
    sigmfNeedsIShortToComplex,
    attachIShortToComplex,
    select,
    recordHistory,
  } = deps;
  const showPropertiesFieldColors = deps.showFieldColors();
  closeMenu();
  const d = defFor(inst); if (!d) return;
  const tmp: { name: string; params: Record<string, any>; localFileToken?: string } = {
    name: inst.name,
    params: { ...inst.params },
    localFileToken: inst.localFileToken,
  };

  const overlay = document.createElement('div'); overlay.className = 'modal props';
  const dlg = document.createElement('div'); dlg.className = 'dlg';
  if (inst.id === EPY_BLOCK_ID || inst.id === JS_BLOCK_ID) dlg.classList.add('dlg-code');
  const head = document.createElement('div'); head.className = 'dlghead withclose';
  const headTitle = document.createElement('span'); headTitle.textContent = 'Properties: ' + d.label;
  const headClose = document.createElement('button'); headClose.className = 'dlgclose';
  headClose.type = 'button'; headClose.title = 'Close'; headClose.setAttribute('aria-label', 'Close');
  headClose.textContent = '×';
  headClose.onclick = () => closeDialog();
  head.append(headTitle, headClose);
  const tabBar = document.createElement('div'); tabBar.className = 'dlgtabs'; tabBar.setAttribute('role', 'tablist');
  const body = document.createElement('div'); body.className = 'dlgbody';

  const categories = [
    'General',
    ...d.params.map(p => p.category || 'General')
      .filter((cat, i, all) => cat !== 'General' && all.indexOf(cat) === i),
    'Documentation',
  ];
  const panels = new Map<string, HTMLDivElement>();
  const tabs: HTMLButtonElement[] = [];
  const controls = new Map<string, { node: HTMLElement; error: HTMLElement }>();
  const conditionalRows: { param: ParamDef; row: HTMLElement }[] = [];
  let refreshValidation = () => {};
  let refreshVisibility = () => {};
  // The Embedded Python Block's Code field, when this dialog has one: `pending`
  // is true while the source has been edited but not re-read by Python, which is
  // what blocks Apply/OK. `dispose` tears the code editor down with the dialog.
  // See the code-editor branch below.
  const code: {
    pending: boolean; busy: boolean; message: string;
    refresh: () => void; dispose: () => void;
  } = { pending: false, busy: false, message: '', refresh: () => {}, dispose: () => {} };
  // Same, for the GUI Layout block's designer: it owns a ResizeObserver on a
  // node that is about to be detached.
  const layoutDesigner: { dispose: () => void } = { dispose: () => {} };
  // Teardown the dialog collects as it is built, for anything registered outside
  // the overlay — a document-level key listener, say — which the overlay's own
  // removal would otherwise leave behind.
  const teardown: (() => void)[] = [];
  // Every way this dialog closes goes through here, so nothing leaks a mounted
  // CodeMirror or a live observer on a detached node.
  const closeDialog = () => {
    code.dispose(); layoutDesigner.dispose();
    teardown.forEach(fn => fn());
    overlay.remove();
  };
  const activateTab = (category: string) => {
    panels.forEach((panel, name) => panel.hidden = name !== category);
    tabs.forEach(tab => {
      const active = tab.dataset.category === category;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
  };
  for (const category of categories) {
    const panel = document.createElement('div'); panel.className = 'dlgpanel'; panel.setAttribute('role', 'tabpanel');
    panels.set(category, panel); body.appendChild(panel);
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'dlgtab';
    tab.textContent = category; tab.dataset.category = category; tab.setAttribute('role', 'tab');
    tab.onclick = () => activateTab(category);
    tab.onkeydown = e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const offset = e.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
      activateTab(next.dataset.category!); next.focus();
    };
    tabs.push(tab); tabBar.appendChild(tab);
  }

  const docsPanel = panels.get('Documentation')!;
  if (d.wikiUrl) {
    const wikiLink = document.createElement('a'); wikiLink.className = 'props-wiki-link';
    wikiLink.href = d.wikiUrl;
    wikiLink.target = '_blank';
    wikiLink.rel = 'noopener noreferrer';
    wikiLink.textContent = 'Open Wiki Page for this Block';
    docsPanel.appendChild(wikiLink);
  }
  const addDocs = (title: string, text: string | undefined) => {
    if (!text) return;
    const section = document.createElement('section'); section.className = 'props-doc-section';
    const heading = document.createElement('h3'); heading.textContent = title;
    const content = document.createElement('div'); content.className = 'props-doc-text';
    content.textContent = text;
    section.append(heading, content); docsPanel.appendChild(section);
  };
  addDocs('Block description', d.documentation);
  addDocs('API documentation', d.apiDocumentation);
  if (!d.documentation && !d.apiDocumentation) {
    const empty = document.createElement('p'); empty.className = 'props-doc-empty';
    empty.textContent = 'No documentation is available for this block.';
    docsPanel.appendChild(empty);
  }

  const addField = (
    category: string,
    label: string,
    node: HTMLElement,
    field: string,
    validationNode: HTMLElement = node,
    dtype = '',
  ) => {
    const row = document.createElement('div'); row.className = 'dlgrow';
    const l = document.createElement('label'); l.textContent = label;
    const control = document.createElement('div'); control.className = 'field-control';
    const error = document.createElement('small'); error.className = 'field-error'; error.hidden = true;
    control.append(node, error); row.append(l, control); panels.get(category)!.appendChild(row);
    colorPropertyRow(row, dtype, showPropertiesFieldColors);
    controls.set(field, { node: validationNode, error });
    return node;
  };
  // Native GRC builds the `id` parameter as `hide: all` for every block without
  // the `show_id` flag, so the dialog has no ID field for them; the block ID is
  // generated and left alone unless View ▸ Show All Block IDs is on.
  if (blockIdVisible(inst)) {
    const nameInput = document.createElement('input');
    const nameI = addField('General', 'ID', nameInput, NAME_FIELD, nameInput, 'id') as HTMLInputElement;
    nameI.value = tmp.name;
    nameI.oninput = () => { tmp.name = nameI.value.replace(/\s+/g, '_'); refreshValidation(); };
  }
  for (const p of d.params) {
    // The derived-interface caches are written by the code reader, never by hand,
    // and are a JSON blob the length of a paragraph. Neither has a field, and
    // neither does the inlined source a local JS block's instance carries.
    if (p.id === EPY_IO_CACHE_PARAM || p.id === JS_IO_PARAM ||
        p.id === JS_LOCAL_SOURCE_PARAM) continue;
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach((o, index) => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = p.optionLabels?.[index] ?? o;
        s.appendChild(opt);
      });
      s.value = String(tmp.params[p.id]);
      // Output Type is the recording's SigMF datatype for both blocks that read
      // one -- GR World Recording from the bucket index, SigMF Source from the
      // .sigmf-meta beside the samples. It is shown so the reader can see how
      // the samples are being read, and disabled because reading them as
      // anything else would only mis-read them. SigMF *Sink* is the opposite
      // case: there its Stream Type is chosen and the datatype follows.
      s.disabled = (inst.id === RECORDING_ID || inst.id === SIGMF_SOURCE_ID) &&
        p.id === 'type';
      s.onchange = () => { tmp.params[p.id] = s.value; refreshVisibility(); refreshValidation(); };
      addField(p.category || 'General', `${p.label}  (${p.id})`, s, p.id, s, propertyFieldDtype(p));
      if (s.disabled) {
        const hint = document.createElement('small'); hint.className = 'field-hint';
        hint.textContent = inst.id === SIGMF_SOURCE_ID
          ? 'Set from core:datatype in the recording’s .sigmf-meta.'
          : 'Set from the SigMF datatype of the recording above.';
        s.closest('.field-control')?.appendChild(hint);
      }
      if (p.showWhen) conditionalRows.push({ param: p, row: s.closest('.dlgrow') as HTMLElement });
    } else if (LOCAL_FILE_PARAMS[inst.id] === p.id && p.dtype === 'file_open') {
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id]);
      const choose = document.createElement('button'); choose.type = 'button';
      choose.textContent = 'Browse…';
      const native = document.createElement('input'); native.type = 'file';
      native.className = 'file-picker-native'; native.tabIndex = -1;
      const accept = LOCAL_FILE_ACCEPT[inst.id];
      if (accept) native.accept = accept;
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';
      const refreshDetail = () => {
        const file = tmp.localFileToken
          ? localFilesByToken.get(tmp.localFileToken) : undefined;
        detail.textContent = file
          ? `Local file · ${file.name} · ${displayBytes(file.size)}`
          : 'No local file selected for this browser session.';
      };
      inp.oninput = () => {
        tmp.params[p.id] = inp.value;
        tmp.localFileToken = undefined;
        refreshDetail(); refreshVisibility(); refreshValidation();
      };
      choose.onclick = () => native.click();
      native.onchange = () => {
        const file = native.files?.[0];
        if (!file) return;
        const token = newLocalFileToken();
        localFilesByToken.set(token, file);
        tmp.localFileToken = token;
        tmp.params[p.id] = file.name;
        inp.value = file.name;
        refreshDetail(); refreshVisibility(); refreshValidation();
      };
      picker.append(inp, choose, native, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, inp, propertyFieldDtype(p));
      refreshDetail();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (radioForDtype(p.dtype)) {
      // A WebUSB radio. Unlike a local file this binds nothing for the
      // session: the browser remembers the permission per origin, so all a .grc
      // needs is the serial number, and the runner's worker finds the device
      // again by itself. Degrades to a plain text field where WebUSB is absent,
      // so a flowgraph authored in Firefox still round-trips.
      const radio = radioForDtype(p.dtype)!;
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const select = document.createElement('select');
      // The fallback for a .grc naming a dongle that is not plugged in, and for
      // a browser with no WebUSB at all: the value still round-trips.
      const typed = document.createElement('input');
      typed.hidden = true;
      typed.placeholder = 'serial number, or blank for the first available';
      const choose = document.createElement('button'); choose.type = 'button';
      choose.textContent = 'Add…';
      choose.title = `Grant this site access to another ${radio.name}`;
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';
      let shared: UsbLike[] = [];

      // What the field offers and what it says about the current value are both
      // "which radio does this resolve to", so the radio modules own both the
      // options and the block-face display. Only the DOM wiring is here.
      const paint = () => {
        const serial = String(tmp.params[p.id] ?? '').trim();
        select.replaceChildren(...radio.options(serial, shared).map(o => {
          const option = document.createElement('option');
          option.value = o.value; option.textContent = o.label;
          return option;
        }));
        select.value = serial;
        detail.textContent = radio.describe(serial, shared);
      };

      // The same cache the block face draws from, so the dialog and the canvas
      // cannot name different dongles for one flowgraph.
      const refreshDevices = async () => {
        shared = await radio.refresh();
        if (!usbApi()) { select.hidden = true; typed.hidden = false; choose.disabled = true; }
        paint(); render();
      };
      const commit = (serial: string) => {
        tmp.params[p.id] = serial;
        paint(); refreshVisibility(); refreshValidation();
      };
      select.onchange = () => commit(select.value);
      typed.oninput = () => {
        tmp.params[p.id] = typed.value.trim();
        detail.textContent = radio.describe(typed.value.trim(), shared);
        refreshValidation();
      };
      choose.onclick = async () => {
        const usb = usbApi();
        if (!usb) return;
        try {
          const device: UsbLike =
            await usb.requestDevice({ filters: radio.filters });
          shared = await radio.refresh();
          // A radio with no serial cannot be named, so it can only ever be
          // reached as "first available".
          commit(device.serialNumber ?? '');
        } catch {
          await refreshDevices();   // the chooser was dismissed
        }
      };
      typed.value = String(tmp.params[p.id] ?? '');
      picker.append(select, typed, choose, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, select, propertyFieldDtype(p));
      paint();                  // synchronously, before the device list resolves
      void refreshDevices();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (p.dtype === RECORDING_DTYPE) {
      // GR World Recording's recording, chosen from the live bucket index — the
      // same list the Recordings palette tab draws. The block stores the key
      // alone, so a field that could only be a select degrades to a text input
      // when the index cannot be read: the flowgraph still runs, and a key typed
      // from a shared link still works.
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const select = document.createElement('select');
      const typed = document.createElement('input');
      typed.hidden = true;
      typed.placeholder = 'estevez/by701';
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';
      let known = new Map<string, ExampleRecording>();

      const describe = () => {
        const key = String(tmp.params[p.id] ?? '');
        const recording = known.get(key);
        if (!recording) {
          detail.textContent = key
            ? `"${key}" — streamed from the recordings bucket.`
            : 'No recording chosen. Pick one, or click a card in the Recordings tab.';
          return;
        }
        const parts = [
          recording.datatype || 'unknown datatype',
          displaySi(recording.sampleRate, 'Hz'),
          displayBytes(recording.byteLength),
        ];
        detail.textContent = parts.join(' · ') +
          (isCi16Datatype(recording.datatype)
            ? ' · interleaved 16-bit I/Q: feed IShort To Complex'
            : '');
      };
      // A recording's SigMF datatype decides how its samples are read, so
      // choosing one writes Output Type — the field the reader can see but not
      // edit — rather than leaving the block reading them as something else.
      const applyDatatype = (key: string) => {
        const format = sigmfFileSourceFormat(known.get(key)?.datatype ?? null);
        if (!format) return;
        tmp.params.type = format.type;
        const node = controls.get('type')?.node;
        if (node instanceof HTMLSelectElement) node.value = format.type;
      };
      const choose = (key: string) => {
        tmp.params[p.id] = key;
        applyDatatype(key);
        describe(); refreshVisibility(); refreshValidation();
      };
      select.onchange = () => choose(select.value);
      typed.oninput = () => { tmp.params[p.id] = typed.value.trim(); describe(); refreshValidation(); };

      const fill = (recordings: ExampleRecording[]) => {
        select.replaceChildren();
        const key = String(tmp.params[p.id] ?? '');
        // Only what this block can read: Output Type follows the datatype and
        // cannot be corrected by hand, so a datatype with no stream type of its
        // own (the palette greys those cards out) would be a dead end here.
        const keys = recordings.filter(recording => sigmfFileSourceFormat(recording.datatype))
          .map(recording => recording.name).sort();
        // The block's own recording is always offered, listed or not: a bucket
        // that has since dropped it must not silently reselect the block.
        if (!key || !keys.includes(key)) keys.unshift(key);
        for (const name of keys) {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name || '— choose a recording —';
          select.appendChild(option);
        }
        select.value = key;
      };
      fill([]);
      void loadExampleRecordings()
        .then(recordings => {
          known = new Map(recordings.map(recording => [recording.name, recording]));
          fill(recordings);
          describe();
        })
        .catch(error => {
          select.hidden = true;
          typed.hidden = false;
          typed.value = String(tmp.params[p.id] ?? '');
          detail.textContent = `Recordings index unavailable (${error}); type a recording key.`;
        });

      picker.append(select, typed, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, select, propertyFieldDtype(p));
      describe();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (p.dtype === SIGMF_OPEN_DTYPE) {
      // SigMF Source's recording: both halves at once. A browser cannot derive a
      // sibling file from a picked File, so the .sigmf-data and the .sigmf-meta
      // have to come out of the same dialog -- and the metadata is read here and
      // now, because Output Type follows from it and the samp_rate toggle
      // publishes from it.
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id] ?? '');
      inp.placeholder = 'choose a .sigmf-data and its .sigmf-meta';
      const choose = document.createElement('button'); choose.type = 'button';
      choose.textContent = 'Browse…';
      const native = document.createElement('input'); native.type = 'file';
      native.className = 'file-picker-native'; native.tabIndex = -1;
      native.multiple = true;
      native.accept = SIGMF_ACCEPT;
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';

      const describe = (problem?: string) => {
        if (problem) { detail.textContent = problem; return; }
        const bound = tmp.localFileToken
          ? sigmfBindingsByToken.get(tmp.localFileToken) : undefined;
        if (!bound) {
          detail.textContent = String(tmp.params[p.id] ?? '')
            ? `"${tmp.params[p.id]}" is not open in this browser session — choose ` +
              `its two files again with Browse.`
            : 'No recording selected for this browser session.';
          return;
        }
        const parts = [
          bound.datatype,
          bound.sampleRate ? displaySi(bound.sampleRate, 'Hz') : 'sample rate unknown',
          displayBytes(bound.data.size),
          `${bound.captures} capture${bound.captures === 1 ? '' : 's'}`,
          `${bound.annotations} annotation${bound.annotations === 1 ? '' : 's'}`,
        ];
        // Not "feed IShort To Complex", the way GR World Recording's chooser
        // puts it: here the block is already on the canvas, so committing this
        // dialog wires the converter up. Say what will happen, or not, rather
        // than leaving the reader to guess which.
        const converter = !isCi16Datatype(bound.datatype) ? ''
          : state.conns.some(c => c.from === inst.uid)
            ? ' · interleaved 16-bit I/Q: this is a short stream, so it needs an ' +
              'IShort To Complex'
            : ' · interleaved 16-bit I/Q: an IShort To Complex will be added after ' +
              'this block';
        detail.textContent = parts.join(' · ') + converter;
      };

      // Output Type is derived and disabled, so picking a recording is what sets
      // it -- the same arrangement GR World Recording has, for the same reason.
      const applyDatatype = (datatype: string) => {
        const format = sigmfStreamFormat(datatype);
        if (!format) return;
        tmp.params.type = format.type;
        const node = controls.get('type')?.node;
        if (node instanceof HTMLSelectElement) node.value = format.type;
      };

      inp.oninput = () => {
        // Typing a name cannot open a file, so it drops the binding rather than
        // leaving the field describing one recording and the block reading
        // another. Same rule as File Source's field.
        tmp.params[p.id] = inp.value;
        if (tmp.localFileToken) sigmfBindingsByToken.delete(tmp.localFileToken);
        tmp.localFileToken = undefined;
        describe(); refreshVisibility(); refreshValidation();
      };
      choose.onclick = () => native.click();
      native.onchange = async () => {
        const picked = [...(native.files || [])];
        native.value = '';           // so re-picking the same files still fires
        const pair = pairSigmfFiles(picked);
        if ('error' in pair) { describe(pair.error); return; }

        const metaText = await pair.meta.text();
        const meta = parseSigmfMeta(metaText);
        if ('error' in meta) { describe(meta.error); return; }
        if (!sigmfStreamFormat(meta.datatype)) {
          describe(`${meta.datatype} has no stream type here, so this block ` +
                   `could not read it. Open it on its own from the Recordings tab.`);
          return;
        }
        if (pair.data.size === 0) {
          describe(`${pair.base}${SIGMF_DATA_SUFFIX} is empty.`);
          return;
        }

        const token = newLocalFileToken();
        sigmfBindingsByToken.set(token, {
          base: pair.base, data: pair.data, meta: pair.meta, metaText,
          datatype: meta.datatype, sampleRate: meta.sampleRate,
          captures: meta.captures, annotations: meta.annotations,
        });
        tmp.localFileToken = token;
        tmp.params[p.id] = pair.base;
        inp.value = pair.base;
        applyDatatype(meta.datatype);
        describe(); refreshVisibility(); refreshValidation();
        // "Use as samp_rate" publishes on the way out of this dialog, not here,
        // so Cancel cancels it too. See sigmfSampRateToPublish().
      };
      picker.append(inp, choose, native, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, inp, propertyFieldDtype(p));
      describe();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (p.dtype === SIGMF_SAVE_DTYPE) {
      // SigMF Sink's destination: a base name the reader types, plus a folder to
      // put the pair in. The folder is a File System Access handle, bound for the
      // session like a File; where the API does not exist there is no folder to
      // choose at all and the runner buffers and downloads instead.
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id] ?? '');
      inp.placeholder = 'recording name, without a suffix';
      const choose = document.createElement('button'); choose.type = 'button';
      choose.textContent = 'Choose folder…';
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';
      const streaming = canPickOutputDirectory();
      choose.hidden = !streaming;

      const describe = (problem?: string) => {
        if (problem) { detail.textContent = problem; return; }
        const base = sanitizeSigmfBase(String(tmp.params[p.id] ?? ''));
        const dir = tmp.localFileToken
          ? sigmfOutputDirsByToken.get(tmp.localFileToken) : undefined;
        if (!base) {
          // The name is what is missing, so it leads -- but a folder just chosen
          // has to be acknowledged here too, or picking one looks like it failed.
          detail.textContent = 'Give the recording a name — both files take it as their stem.' +
            (dir ? ` They will go into "${dir.name}".` : '');
          return;
        }
        const files = sigmfSinkFileNames(base).join(' + ');
        if (!streaming) {
          detail.textContent = `${files} — downloaded when the flowgraph stops. ` +
            `This browser has no File System Access API, so the recording is held ` +
            `in memory until then; a Chromium browser streams it straight to disk.`;
          return;
        }
        detail.textContent = dir
          ? `${files} — written into "${dir.name}".`
          : `${files} — no folder chosen yet; you will be asked for one when you press Run. ` +
            SIGMF_OUTPUT_PICKER_HELP;
      };

      inp.oninput = () => {
        tmp.params[p.id] = inp.value;
        describe(); refreshVisibility(); refreshValidation();
      };
      inp.onblur = () => {
        // Normalized on the way out, not on every keystroke: the reader is
        // typing a filename stem, and a cursor that jumps mid-word is worse than
        // a name tidied once.
        const base = sanitizeSigmfBase(inp.value);
        if (base === inp.value) return;
        inp.value = base; tmp.params[p.id] = base;
        describe(); refreshValidation();
      };
      choose.onclick = async () => {
        try {
          // A click in this dialog is its own user gesture, so a reader who
          // configures the block up front is never prompted again at Run.
          const dir = await pickOutputDirectory();
          const token = tmp.localFileToken || newLocalFileToken();
          tmp.localFileToken = token;
          sigmfOutputDirsByToken.set(token, dir);
          describe(); refreshValidation();
        } catch {
          // Dismissed -- or a blocked folder was chosen and then dismissed,
          // which throws identically. Say what the restriction is rather than
          // leaving the field looking as though nothing happened.
          describe(`No folder chosen. ${SIGMF_OUTPUT_PICKER_HELP}`);
        }
      };
      picker.append(inp, choose, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, inp, propertyFieldDtype(p));
      describe();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (p.dtype === LAYOUT_DTYPE) {
      // The GUI Layout block's grid. Editing the JSON by hand is possible and
      // pointless, so the field is the arrangement itself: a drag-and-drop
      // miniature of the runner window, fetched on demand like the code editor.
      const mount = document.createElement('div');
      mount.className = 'gui-designer-mount';
      const fallback = document.createElement('small');
      fallback.className = 'field-hint';
      fallback.textContent = 'Loading the layout designer…';
      mount.appendChild(fallback);
      void import('./gui-layout-designer')
        .then(({ mountLayoutDesigner }) => {
          fallback.remove();
          const handle = mountLayoutDesigner(mount, {
            widgets: guiWidgets(),
            tiles: parseTiles(String(tmp.params[p.id] ?? '{}')),
            columns: layoutColumns(tmp.params.columns),
            rowHeight: layoutRowHeight(tmp.params.row_height),
            // Straight into the dialog's working copy, so OK saves the
            // arrangement and Cancel discards it like any other field.
            onChange: next => { tmp.params[p.id] = serializeTiles(next); },
          });
          layoutDesigner.dispose = () => handle.destroy();
        })
        .catch(error => { fallback.textContent = `Layout designer failed to load: ${error}`; });
      addField(p.category || 'General', p.label, mount, p.id, mount, propertyFieldDtype(p));
    } else if (p.dtype === EPY_CODE_DTYPE) {
      // The Embedded Python Block's source. Native GRC hands this parameter to an
      // external editor and re-reads the block every time the file is saved
      // (grc/gui_qt/external_editor.py); the browser equivalent is a code area
      // plus an explicit re-read, because re-reading means running the source in
      // Pyodide and Pyodide is a ~16 MB opt-in download.
      const area = document.createElement('textarea');
      area.className = 'code-editor'; area.rows = 22; area.spellcheck = false;
      area.value = String(tmp.params[p.id]);
      const committed = area.value;
      area.onkeydown = event => {
        // Tab indents instead of leaving the field: this is a Python editor, and
        // an accidental dedent is a syntax error rather than a cosmetic slip.
        // CodeMirror's own indentWithTab does the same once it has mounted.
        if (event.key !== 'Tab' || event.shiftKey) return;
        event.preventDefault();
        const start = area.selectionStart, end = area.selectionEnd;
        area.setRangeText('    ', start, end, 'end');
        tmp.params[p.id] = area.value;
      };
      // Syntax highlighting, line numbers and Python indentation, fetched on
      // demand and mirrored back into the textarea above -- which stays the
      // field's value either way. See editor/src/code-editor.ts.
      void import('./code-editor').then(({ mountCodeEditor }) => mountCodeEditor(area))
        .then(handle => { code.dispose = () => handle?.destroy(); })
        .catch(() => {});
      const status = document.createElement('small'); status.className = 'code-status';
      const reload = document.createElement('button');
      reload.type = 'button'; reload.className = 'code-reload';
      const readSource = async () => {
        code.busy = true; code.message = ''; code.refresh();
        try {
          const io = await pythonRuntime.introspect(String(tmp.params[p.id]));
          // Sorted keys, so re-reading identical code leaves the .grc byte
          // for byte unchanged (and matches the default in epy_block.block.yml).
          tmp.params[EPY_IO_CACHE_PARAM] = JSON.stringify(Object.fromEntries(
            Object.keys(io).sort().map(key => [key, (io as any)[key]])));
          setEpySourceError(inst.uid, '');
          code.pending = false; code.busy = false; code.message = '';
          // The parameter and port set has just changed, so the dialog it is
          // drawn from is stale. Commit and reopen -- the same effect as native
          // GRC rebuilding the block when the external editor saves.
          apply();
          closeDialog();
          log(`${inst.name}: read "${io.label}" — ${io.params.length} parameter(s), ` +
              `${io.sinks.length} input(s), ${io.sources.length} output(s)`);
          showPropertiesDialog(inst, deps);
        } catch (error) {
          code.busy = false;
          code.message = String((error as Error).message || error);
          setEpySourceError(inst.uid, code.message.split('\n').slice(-1)[0].trim() ||
                            'the block\'s source could not be read');
          code.refresh();
          render();
        }
      };
      reload.onclick = () => { void readSource(); };
      area.oninput = () => {
        tmp.params[p.id] = area.value;
        code.pending = area.value !== committed;
        code.refresh();
        refreshValidation();
      };
      const field = document.createElement('div'); field.className = 'code-field';
      const controlsRow = document.createElement('div'); controlsRow.className = 'code-controls';
      controlsRow.append(reload, status);
      field.append(area, controlsRow);
      addField(p.category || 'General', p.label, field, p.id, area, propertyFieldDtype(p));
      code.refresh = () => {
        if (!overlay.isConnected && overlay.parentNode !== null) return;
        const state = pythonRuntime.state;
        reload.disabled = code.busy || state === 'loading';
        reload.textContent = code.busy ? 'Reading…'
          : state === 'loading' ? 'Starting Python…'
          : state === 'ready' ? 'Re-read this block from its code'
          : 'Load Python and read this block  (~16 MB)';
        status.textContent = code.message
          ? code.message.split('\n').slice(-1)[0].trim()
          : code.pending
            ? 'The code has changed. Read it to update this block’s parameters and ports.'
            : state === 'ready' ? 'Python is loaded.'
            : state === 'loading' ? 'Downloading and starting CPython…'
            : 'Parameters and ports below are from the last time this code was read.';
        status.classList.toggle('code-error', !!code.message);
      };
      code.refresh();
      pythonRuntime.onchange = () => code.refresh();
      // Already loaded it once in an earlier session? Then the opt-in has been
      // given and re-asking is just a click in the way. Nothing is fetched for a
      // user who has never loaded it.
      if (pythonRuntime.consented && pythonRuntime.state === 'absent')
        void pythonRuntime.load();
    } else if (p.dtype === JS_CODE_DTYPE) {
      // The JavaScript Block's source. Unlike the Python Block's Code field
      // there is no re-read button and no gating: deriving a JS block's
      // interface means evaluating its descriptor in a disposable sandbox, which
      // costs a few milliseconds and needs nothing downloaded. So it is
      // debounced on every keystroke and the panel below the field says what the
      // code currently means. See editor/src/js-block.ts.
      const area = document.createElement('textarea');
      area.className = 'code-editor'; area.rows = 18; area.spellcheck = false;
      area.value = String(tmp.params[p.id]);
      area.onkeydown = event => {
        if (event.key !== 'Tab' || event.shiftKey) return;
        event.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        tmp.params[p.id] = area.value;
      };
      void import('./code-editor')
        .then(({ mountCodeEditor }) => mountCodeEditor(area, 'javascript'))
        .then(handle => { code.dispose = () => handle?.destroy(); })
        .catch(() => {});
      const status = document.createElement('small'); status.className = 'code-status';
      const popout = document.createElement('button');
      popout.type = 'button'; popout.className = 'code-reload';
      popout.textContent = 'Expand Editor ⤢';
      popout.title = 'Open this code in a large resizable editor, ' +
                     'with a live view of the block it derives';
      popout.onclick = () => {
        // Seeded from the dialog's working copy and written back to it, so
        // Cancel still discards everything the popup did.
        openJsCodeModal({
          title: `Code: ${tmp.name}`,
          source: String(tmp.params[p.id]),
          apply: (source, io) => {
            tmp.params[p.id] = source;
            if (io) applyJsIo(tmp.params, io);
          },
          uid: inst.uid,
          onSave: () => {
            // The parameter and port set may have just changed, so the dialog
            // drawn from it is stale. Commit and reopen -- the same effect the
            // Python Block's re-read has.
            apply(); closeDialog(); showPropertiesDialog(inst, deps);
          },
          render: () => { area.value = String(tmp.params[p.id]); refreshValidation(); },
        });
      };
      let deriveTimer: number | undefined;
      const describe = () => {
        const source = String(tmp.params[p.id]);
        jsIntrospector.describe(source).then(io => {
          if (!overlay.isConnected || String(tmp.params[p.id]) !== source) return;
          applyJsIo(tmp.params, io);
          acceptJsSource(source);   // typed here, so no Run consent for it
          setJsSourceError(inst.uid, '');
          code.message = '';
          code.refresh(); refreshValidation(); render();
        }).catch(error => {
          if (!overlay.isConnected || String(tmp.params[p.id]) !== source) return;
          code.message = String((error as Error)?.message || error);
          setJsSourceError(inst.uid, code.message.split('\n')[0].trim() ||
                           'the block\'s source could not be read');
          code.refresh(); refreshValidation(); render();
        });
      };
      area.oninput = () => {
        tmp.params[p.id] = area.value;
        clearTimeout(deriveTimer);
        deriveTimer = setTimeout(describe, 220) as unknown as number;
      };
      const field = document.createElement('div'); field.className = 'code-field';
      const controlsRow = document.createElement('div'); controlsRow.className = 'code-controls';
      controlsRow.append(popout, status);
      field.append(area, controlsRow);
      addField(p.category || 'General', p.label, field, p.id, area, propertyFieldDtype(p));
      code.refresh = () => {
        if (!overlay.isConnected && overlay.parentNode !== null) return;
        const io = parseJsIo(tmp.params[JS_IO_PARAM]);
        status.textContent = code.message
          ? code.message.split('\n')[0].trim()
          : io
            ? `${io.label} — ${io.inputs.length} input(s), ${io.outputs.length} ` +
              `output(s), ${io.params.length} parameter(s). ` +
              `Apply to update this block's fields.`
            : 'This block has no interface yet.';
        status.classList.toggle('code-error', !!code.message);
      };
      const previousDispose = code.dispose;
      code.dispose = () => { clearTimeout(deriveTimer); previousDispose(); };
      code.refresh();
      describe();
    } else if (p.color) {
      // A colour parameter (the Note block's background). No expression support
      // and no dtype tint on the row: the value is a literal `#rrggbb` that the
      // canvas paints directly, and the field is already all colour.
      const field = colorField(String(tmp.params[p.id]), value => {
        tmp.params[p.id] = value;
        refreshVisibility(); refreshValidation();
      }, NOTE_DEFAULT_BG);
      addField(p.category || 'General', `${p.label}  (${p.id})`, field.wrap, p.id, field.text);
      if (p.showWhen) conditionalRows.push({ param: p, row: field.wrap.closest('.dlgrow') as HTMLElement });
    } else if (usesOptionCombo(p)) {
      // A parameter with an options list that is not `dtype: enum` — see
      // optionCombo(): a dropdown of the options, still able to hold an
      // expression or a variable.
      const combo = optionCombo(p, String(tmp.params[p.id]), value => {
        tmp.params[p.id] = p.type === 'number' ? numericOrExpression(value) : value;
        refreshVisibility(); refreshValidation();
      });
      addField(p.category || 'General', `${p.label}  (${p.id})`, combo.wrap, p.id,
        combo.select, propertyFieldDtype(p));
      if (p.showWhen) conditionalRows.push({ param: p, row: combo.wrap.closest('.dlgrow') as HTMLElement });
    } else {
      // Prose params (the Note block) get a textarea so the text can contain the
      // line breaks the block face honours; everything else stays a one-liner.
      const inp = document.createElement(p.multiline ? 'textarea' : 'input') as
        HTMLInputElement | HTMLTextAreaElement;
      if (p.multiline) (inp as HTMLTextAreaElement).rows = 5;
      inp.value = String(tmp.params[p.id]);
      inp.oninput = () => {
        tmp.params[p.id] = p.type === 'number' ? numericOrExpression(inp.value) : inp.value;
        refreshVisibility(); refreshValidation();
      };
      addField(p.category || 'General', `${p.label}  (${p.id})`, inp, p.id, inp, propertyFieldDtype(p));
      if (p.showWhen) conditionalRows.push({ param: p, row: inp.closest('.dlgrow') as HTMLElement });
    }
  }

  refreshVisibility = () => {
    conditionalRows.forEach(({ param, row }) => row.hidden = !param.showWhen!(tmp.params));
  };
  refreshVisibility();

  refreshValidation = () => {
    const candidate = { ...inst, name: tmp.name, params: tmp.params };
    const issues = validateGraph(state.insts.map(block => block.uid === inst.uid ? candidate : block));
    controls.forEach((control, field) =>
      setFieldError(control.node, control.error, fieldIssue(issues, inst.uid, field)));
  };

  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const apply = () => {
    inst.name = tmp.name;
    remapConnectionsForPortChange(inst, tmp.params);
    inst.params = { ...tmp.params };
    inst.localFileToken = tmp.localFileToken;
    const publish = sigmfSampRateToPublish(inst.id, inst.params, inst.localFileToken);
    if (publish) applySampRateFromSigmf(publish.rate, publish.source);
    // Both of these are the *recording's* consequences rather than the reader's
    // edits, so they land here where the dialog commits: Cancel cancels them,
    // and the single recordHistory() below makes picking a recording one undo
    // step rather than three.
    if (sigmfNeedsIShortToComplex(inst.id, inst.localFileToken) &&
        attachIShortToComplex(inst))
      log(`added IShort To Complex after "${inst.name}": an interleaved 16-bit ` +
          `recording is a short stream`);
    select(inst.uid);
    recordHistory();
  };
  const btn = (label: string, fn: () => void, cls = '') => {
    const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b;
  };
  foot.appendChild(btn('Cancel', () => closeDialog()));
  const applyButton = btn('Apply', apply);
  const okButton = btn('OK', () => { apply(); closeDialog(); }, 'run');
  foot.append(applyButton, okButton);
  if (inst.id === EPY_BLOCK_ID) {
    // Committing edited code without re-reading it would leave the block's
    // parameters and ports describing the *previous* source: the flowgraph would
    // then be wired one way and built another, and only the runner would notice.
    // So the code has to be read before it can be applied.
    const refreshCode = code.refresh;
    code.refresh = () => {
      refreshCode();
      applyButton.disabled = okButton.disabled = code.pending || code.busy;
      applyButton.title = okButton.title = code.pending
        ? 'Read the code first, so this block’s parameters and ports match it' : '';
    };
    code.refresh();
  }

  // Enter commits the dialog, exactly as OK does: typing a parameter and pressing
  // Enter is how every other field in this editor behaves, and reaching for the
  // mouse to confirm one number is the slowest part of editing a flowgraph.
  //
  // It listens on the document, in the capture phase, rather than on the dialog.
  // Focus is often nowhere in particular — clicking a label or the dialog's own
  // background leaves it on <body> — so the key event need never reach the
  // dialog's subtree; and capturing it here keeps it away from the bare-key
  // shortcut handler in main.ts, whose Enter re-opens the properties of the
  // block that is still selected behind this dialog.
  const onEnterKey = (event: KeyboardEvent) => {
    // Escape removes the overlay directly rather than through closeDialog, so
    // this can outlive the dialog it commits. Retire it the moment that shows.
    if (!overlay.isConnected) { document.removeEventListener('keydown', onEnterKey, true); return; }
    if (event.key !== 'Enter' || event.isComposing) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    // Only the topmost modal answers: the code editor's pop-out opens over this
    // one, and Enter there belongs to it.
    const modals = document.querySelectorAll('.modal');
    if (modals[modals.length - 1] !== overlay) return;
    const target = event.target as HTMLElement | null;
    // Multi-line fields keep Enter for themselves, and a focused button or link
    // already has its own activation — committing here too would apply twice.
    if (target instanceof HTMLTextAreaElement || target?.closest('.code-cm')) return;
    if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) return;
    if (okButton.disabled) return;
    event.preventDefault(); event.stopPropagation();
    apply(); closeDialog();
  };
  document.addEventListener('keydown', onEnterKey, true);
  teardown.push(() => document.removeEventListener('keydown', onEnterKey, true));

  activateTab('General');
  dlg.append(head, tabBar, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  // Unlike the informational dialogs, this one holds unsaved edits: a stray click
  // on the backdrop must not discard them. Only OK/Cancel/× close it.
  refreshValidation();
  // The ID field when the block has one, otherwise its first real parameter.
  const first = panels.get('General')!.querySelector(
    'input:not([hidden]), select:not([hidden]), textarea:not([hidden])') as HTMLElement | null;
  first?.focus();
  if (first instanceof HTMLInputElement) first.select();
}
