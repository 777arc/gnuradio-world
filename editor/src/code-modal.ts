// The JavaScript Block's popup code editor.
//
// The Properties dialog keeps a small inline Code field, so a JS Block and a
// Python Block still look like siblings in the form. This is the other surface:
// a large resizable modal with CodeMirror on the left and, on the right, what the
// code currently *means* — the derived label, ports and parameters, or the error
// that stopped them being derived. "Expand Editor ⤢" beside the Properties
// dialog's Code field opens it; a JS Block double-clicks to Properties like
// every other block.
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

// ---- remembered dialog size ----
// The dialog carries `resize:both` (editor.css), so the browser writes the
// dragged size straight onto the element as inline width/height. All this does is
// carry that across sessions the way a window manager would. Nothing is clamped
// here: the same rule that draws the grip also sets min-width/min-height and
// max-width/max-height in viewport units, and those still cap an inline width, so
// a size stored on a large monitor is already usable on a small one.
const SIZE_KEY = 'gnuradio_world_code_modal_size';
// Verbatim from editor.css, and the same query main.ts's NARROW_LAYOUT repeats.
// There the dialog is a bottom sheet with no grip, so a remembered size would
// only fight the sheet's own geometry.
const NARROW_LAYOUT = '(max-width:820px), (max-width:1000px) and (max-height:500px)';

function storedSize(): { w: number; h: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    if (raw && Number.isFinite(raw.w) && Number.isFinite(raw.h)) return raw;
  } catch { /* unreadable or unparseable: open at the stylesheet's size */ }
  return null;
}

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
  const disposers: (() => void)[] = [];

  const close = () => {
    clearTimeout(timer);
    for (const dispose of disposers) dispose();
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

  // Before the first paint, so the dialog never appears at one size and jumps.
  const narrow = window.matchMedia(NARROW_LAYOUT);
  const remembered = narrow.matches ? null : storedSize();
  if (remembered) {
    dlg.style.width = `${remembered.w}px`;
    dlg.style.height = `${remembered.h}px`;
  }
  // Turning a phone sideways can cross into the bottom-sheet layout with the
  // dialog open. An inline size outranks every stylesheet rule, so hand the
  // geometry back rather than leaving a sheet stuck at a desktop width.
  const onLayoutChange = () => {
    if (!narrow.matches) return;
    dlg.style.width = '';
    dlg.style.height = '';
  };
  narrow.addEventListener('change', onLayoutChange);
  disposers.push(() => narrow.removeEventListener('change', onLayoutChange));

  // The grip is part of the dialog's own box, and the head/body/foot cover the
  // rest of it — so a pointerdown that lands on .dlg itself is a drag of the
  // grip, and the only thing worth remembering. A size that only ever came from
  // the stylesheet stays in the stylesheet, free to keep following the viewport.
  let dragged = false;
  dlg.addEventListener('pointerdown', event => {
    if (event.target === dlg) dragged = true;
  });
  const sizeObserver = new ResizeObserver(() => {
    if (!dragged || narrow.matches) return;
    const w = Math.round(dlg.offsetWidth), h = Math.round(dlg.offsetHeight);
    try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h })); }
    catch { /* full or blocked: the size is still applied, just not kept */ }
  });
  sizeObserver.observe(dlg);
  disposers.push(() => sizeObserver.disconnect());

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
