// The JavaScript Block's popup code editor.
//
// The Properties dialog keeps a small inline Code field, so a JS Block and a
// Python Block still look like siblings in the form. This is the other surface:
// a large resizable modal with CodeMirror on the left and, on the right, what the
// code currently *means* — the derived label, ports and parameters, or the error
// that stopped them being derived. Double-clicking a JS Block opens it, and so
// does "Edit Code ⤢" in Properties.
//
// Derivation is a few milliseconds in a disposable sandbox (editor/src/
// js-block.ts), so it can run on a keystroke debounce: the panel and the block's
// ports follow the code as you type. There is no re-read button and no gating,
// which is the whole difference from the Python Block's Code field.
//
// Dynamically imported by main.ts, for the same reason code-editor.ts is: nothing
// here is fetched by a session that never opens a JS Block.
import type { CodeEditorHandle } from './code-editor';
import { jsIntrospector, type JsBlockIo } from './js-block';

export interface CodeModalOptions {
  title: string;
  source: string;
  /** Debounced, after every successful derivation. */
  onDerived(io: JsBlockIo, source: string): void;
  /** Debounced, when the source could not be read. */
  onError(message: string, source: string): void;
  /** Save & Close: the final source, already derived if it could be. */
  onSave(source: string): void;
  /** Offer this source as a repo/local block. Absent hides the button. */
  onSaveAsBlock?(source: string, io: JsBlockIo | null): void;
}

const DEBOUNCE_MS = 220;

const portSummary = (io: JsBlockIo) => {
  const side = (ports: { dtype: string; vlen: number }[]) =>
    ports.length ? ports.map(p => p.vlen > 1 ? `${p.dtype}×${p.vlen}` : p.dtype).join(', ')
                 : 'none';
  return `in: ${side(io.inputs)}  ·  out: ${side(io.outputs)}`;
};

export function openCodeModal(options: CodeModalOptions): void {
  document.querySelector('.modal.code-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal code-modal';
  const dlg = document.createElement('div');
  dlg.className = 'dlg code-modal-dlg';

  const head = document.createElement('div');
  head.className = 'dlghead withclose';
  const headTitle = document.createElement('span');
  headTitle.textContent = options.title;
  const headClose = document.createElement('button');
  headClose.className = 'dlgclose'; headClose.type = 'button';
  headClose.title = 'Close'; headClose.setAttribute('aria-label', 'Close');
  headClose.textContent = '×';
  head.append(headTitle, headClose);

  const body = document.createElement('div');
  body.className = 'dlgbody code-modal-body';

  const area = document.createElement('textarea');
  area.className = 'code-editor code-modal-area';
  area.spellcheck = false;
  area.value = options.source;
  const original = options.source;

  const panel = document.createElement('div');
  panel.className = 'code-modal-panel';
  const panelTitle = document.createElement('div');
  panelTitle.className = 'code-modal-label';
  const panelPorts = document.createElement('div');
  panelPorts.className = 'code-modal-ports';
  const panelParams = document.createElement('div');
  panelParams.className = 'code-modal-params';
  const panelNotes = document.createElement('div');
  panelNotes.className = 'code-modal-notes';
  const panelError = document.createElement('pre');
  panelError.className = 'code-modal-error';
  panelError.hidden = true;
  panel.append(panelTitle, panelPorts, panelParams, panelNotes, panelError);
  body.append(area, panel);

  const foot = document.createElement('div');
  foot.className = 'dlgfoot';
  const button = (label: string, fn: () => void, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    return b;
  };

  let latestIo: JsBlockIo | null = null;
  let timer: number | undefined;
  let editor: CodeEditorHandle | null = null;

  const close = () => {
    clearTimeout(timer);
    editor?.destroy();
    overlay.remove();
  };

  const paint = (io: JsBlockIo | null, error: string) => {
    panelError.hidden = !error;
    panelError.textContent = error;
    panel.classList.toggle('has-error', !!error);
    if (!io) {
      panelTitle.textContent = 'No interface yet';
      panelPorts.textContent = '';
      panelParams.textContent = '';
      panelNotes.textContent = '';
      return;
    }
    panelTitle.textContent = io.label;
    panelPorts.textContent = portSummary(io);
    const numeric = new Set(io.numericParams || []);
    panelParams.replaceChildren(...(io.params || []).map(([id, value]) => {
      const row = document.createElement('div');
      row.className = 'code-modal-param';
      const name = document.createElement('code');
      name.textContent = id;
      const rest = document.createElement('span');
      rest.textContent = ` = ${JSON.stringify(value)}` +
        (numeric.has(id) ? '  (live)' : '');
      row.append(name, rest);
      return row;
    }));
    const notes: string[] = [];
    if (io.general) notes.push('generalWork()');
    if (io.decim !== 1) notes.push(`decimation ${io.decim}`);
    if (io.interp !== 1) notes.push(`interpolation ${io.interp}`);
    if (io.history !== 1) notes.push(`history ${io.history}`);
    if (io.outputMultiple) notes.push(`output multiple ${io.outputMultiple}`);
    if (io.overridesForecast) notes.push('forecast()');
    if (io.hasStart) notes.push('start()');
    if (io.hasStop) notes.push('stop()');
    panelNotes.textContent = notes.join(' · ');
  };

  const derive = () => {
    const source = area.value;
    jsIntrospector.describe(source).then(io => {
      if (!overlay.isConnected || area.value !== source) return;
      latestIo = io;
      paint(io, '');
      options.onDerived(io, source);
    }).catch(error => {
      if (!overlay.isConnected || area.value !== source) return;
      const message = String(error?.message || error);
      paint(latestIo, message);
      options.onError(message, source);
    });
  };

  area.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(derive, DEBOUNCE_MS) as unknown as number;
  };
  // Tab indents instead of leaving the field, which is what CodeMirror's
  // indentWithTab does once it has mounted.
  area.onkeydown = event => {
    if (event.key !== 'Tab' || event.shiftKey) return;
    event.preventDefault();
    area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
  };

  if (options.onSaveAsBlock)
    foot.appendChild(button('Save as Block…',
      () => options.onSaveAsBlock!(area.value, latestIo)));
  foot.appendChild(button('Revert', () => {
    area.value = original;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }));
  foot.appendChild(button('Close', close));
  foot.appendChild(button('Save & Close', () => {
    const source = area.value;
    close();
    options.onSave(source);
  }, 'run'));

  headClose.onclick = close;
  dlg.append(head, body, foot);
  overlay.appendChild(dlg);
  document.body.appendChild(overlay);
  // Deliberately no backdrop-click close: this holds unsaved code.
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });

  void import('./code-editor')
    .then(({ mountCodeEditor }) => mountCodeEditor(area, 'javascript'))
    .then(handle => { editor = handle; })
    .catch(() => {});

  paint(null, '');
  derive();
  area.focus();
}
