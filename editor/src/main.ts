// GNU Radio WebAssembly Flowgraph Editor (TypeScript).
// Loads the block library, lets you place/connect/configure blocks on an SVG
// canvas, and Runs the flowgraph by handing JSON to the C++/WASM runner via a
// URL hash (runner.html#<encoded json>).

type ParamType = 'number' | 'string' | 'enum';
interface ParamDef { id: string; label: string; type: ParamType; def: any; options?: string[] }
interface RunnableDef { label: string; inputs: number; outputs: number; params: ParamDef[]; dtype?: string }

// GRC dtype -> port colour (from grc/core/Constants.py).
const DTYPE_COLOR: Record<string, string> = {
  complex: '#2196F3', float: '#F57C00', int: '#009688',
  short: '#FFEB3B', byte: '#D500F9', message: '#BDBDBD', '': '#ffffff',
};

// Curated schemas for blocks the WASM runner registry supports. Param names match
// the runner's factories exactly; keeps the demo clean vs. GRC's raw enum params.
const RUNNABLE: Record<string, RunnableDef> = {
  analog_sig_source_x: {
    label: 'Signal Source', inputs: 0, outputs: 1, params: [
      { id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 32000 },
      { id: 'waveform', label: 'Waveform', type: 'enum', def: 'cos', options: ['cos', 'sin', 'square', 'triangle', 'saw'] },
      { id: 'frequency', label: 'Frequency', type: 'number', def: 2000 },
      { id: 'amplitude', label: 'Amplitude', type: 'number', def: 1.0 },
    ],
  },
  blocks_throttle: {
    label: 'Throttle', inputs: 1, outputs: 1, params: [
      { id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 32000 },
      { id: 'itemsize', label: 'Item Size (bytes)', type: 'number', def: 8 },
    ],
  },
  blocks_multiply_const_cc: {
    label: 'Multiply Const', inputs: 1, outputs: 1, params: [
      { id: 'constant', label: 'Constant', type: 'number', def: 1.0 },
    ],
  },
  qtgui_time_sink_x: {
    label: 'QT GUI Time Sink', inputs: 1, outputs: 0, params: [
      { id: 'name', label: 'Title', type: 'string', def: 'Scope' },
      { id: 'size', label: 'Num Points', type: 'number', def: 1024 },
      { id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 32000 },
    ],
  },
  qtgui_freq_sink_x: {
    label: 'QT GUI Frequency Sink', inputs: 1, outputs: 0, params: [
      { id: 'name', label: 'Title', type: 'string', def: 'Spectrum' },
      { id: 'fftsize', label: 'FFT Size', type: 'number', def: 1024 },
      { id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 32000 },
    ],
  },
  // ---- verified working (complex chains → time sink), incl. multi-source ----
  analog_noise_source_x: { label: 'Noise Source', inputs: 0, outputs: 1, params: [
      { id: 'amplitude', label: 'Amplitude', type: 'number', def: 1.0 },
      { id: 'seed', label: 'Seed', type: 'number', def: 0 }] },
  blocks_add_xx: { label: 'Add', inputs: 2, outputs: 1, params: [] },
  blocks_multiply_xx: { label: 'Multiply', inputs: 2, outputs: 1, params: [] },
  blocks_head: { label: 'Head', inputs: 1, outputs: 1, params: [
      { id: 'itemsize', label: 'Item Size (bytes)', type: 'number', def: 8 },
      { id: 'num_items', label: 'Num Items', type: 'number', def: 10000000 }] },
  blocks_null_source: { label: 'Null Source', inputs: 0, outputs: 1, params: [
      { id: 'itemsize', label: 'Item Size (bytes)', type: 'number', def: 8 }] },
  blocks_null_sink: { label: 'Null Sink', inputs: 1, outputs: 0, params: [
      { id: 'itemsize', label: 'Item Size (bytes)', type: 'number', def: 8 }] },
};
// Palette exposes the blocks above (verified — complex chains, multi-source fan-in,
// and the FFT frequency sink). The runner's registry (registry.cpp) also compiles
// float type-converters; float chains need a float time sink (not yet added).

interface Inst { uid: string; id: string; name: string; x: number; y: number; params: Record<string, any>; enabled: boolean; rotation: number; bypassed: boolean }
interface Conn { from: string; fp: number; to: string; tp: number }

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (id: string) => document.getElementById(id)!;
const nodesG = el('nodes'), wiresG = el('wires'), svg = el('svg') as unknown as SVGSVGElement;

let insts: Inst[] = [];
let conns: Conn[] = [];
let selected: string | null = null;
let counter = 0;
let pending: { uid: string; port: number } | null = null;  // in-progress connection from an output

function log(s: string) { const l = el('log'); l.textContent += s + '\n'; l.scrollTop = l.scrollHeight; }

// GRC-style geometry: title bar + "Label: value" parameter rows, typed ports.
const TITLE_H = 22, ROW_H = 15, PAD = 6, PORT_W = 8, PORT_H = 13, PORT_GAP = 8;
const portColor = (id: string) => DTYPE_COLOR[RUNNABLE[id].dtype || 'complex'] || '#2196F3';

function fmtVal(v: any): string {
  if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 1000) {
    if (v % 1000000 === 0) return v / 1000000 + 'M';
    if (v % 1000 === 0) return v / 1000 + 'k';
  }
  return String(v);
}
const textW = (s: string, px: number) => s.length * px * 0.56;

function geom(inst: Inst) {
  const d = RUNNABLE[inst.id];
  const rows = d.params.map(p => ({ l: p.label + ': ', v: fmtVal(inst.params[p.id]) }));
  const nports = Math.max(d.inputs, d.outputs, 1);
  const bodyH = Math.max(rows.length * ROW_H + PAD, nports * (PORT_H + PORT_GAP) + PAD, ROW_H);
  const h = TITLE_H + bodyH;
  let w = textW(d.label, 13);
  for (const r of rows) w = Math.max(w, textW(r.l + r.v, 11));
  w = Math.max(104, Math.ceil(w) + 22);
  return { d, rows, h, w };
}
type Edge = 'L' | 'R' | 'T' | 'B';
// Port position (relative to the block) + which edge it sits on, honouring rotation.
function portPos(inst: Inst, kind: 'in' | 'out', i: number): { x: number; y: number; edge: Edge } {
  const { w, h } = geom(inst);
  const vSlot = TITLE_H + PAD + i * (PORT_H + PORT_GAP) + PORT_H / 2;
  const hSlot = 16 + i * (PORT_H + PORT_GAP) + PORT_H / 2;
  const map: Record<number, { in: Edge; out: Edge }> = {
    0: { in: 'L', out: 'R' }, 90: { in: 'T', out: 'B' },
    180: { in: 'R', out: 'L' }, 270: { in: 'B', out: 'T' },
  };
  const e = map[inst.rotation || 0][kind];
  if (e === 'L') return { x: 0, y: vSlot, edge: e };
  if (e === 'R') return { x: w, y: vSlot, edge: e };
  if (e === 'T') return { x: hSlot, y: 0, edge: e };
  return { x: hSlot, y: h, edge: e };
}
// Bezier control point offset outward from an edge (for nicely-curved wires).
function ctrl(edge: Edge, x: number, y: number, k: number): [number, number] {
  if (edge === 'L') return [x - k, y];
  if (edge === 'R') return [x + k, y];
  if (edge === 'T') return [x, y - k];
  return [x, y + k];
}

function addBlock(id: string, x = 60 + (counter % 5) * 30, y = 60 + (counter % 7) * 24) {
  const d = RUNNABLE[id]; if (!d) { log('block "' + id + '" is not runnable yet'); return; }
  const uid = 'b' + (++counter);
  const params: Record<string, any> = {};
  d.params.forEach(p => params[p.id] = p.def);
  insts.push({ uid, id, name: id.replace(/^.*_/, '') + counter, x, y, params, enabled: true, rotation: 0, bypassed: false });
  select(uid); render();
}

// ---- block operations (used by the context menu) ----
function deleteBlock(uid: string) {
  insts = insts.filter(i => i.uid !== uid);
  conns = conns.filter(c => c.from !== uid && c.to !== uid);
  if (selected === uid) selected = null;
  renderProps(); render();
}
function duplicateBlock(uid: string) {
  const s = insts.find(i => i.uid === uid); if (!s) return;
  const nu = 'b' + (++counter);
  insts.push({ uid: nu, id: s.id, name: s.id.replace(/^.*_/, '') + counter,
    x: s.x + 24, y: s.y + 24, params: { ...s.params }, enabled: s.enabled,
    rotation: s.rotation, bypassed: s.bypassed });
  select(nu);
}
function toggleEnabled(uid: string) {
  const s = insts.find(i => i.uid === uid); if (s) { s.enabled = !s.enabled; render(); }
}
function rotate(uid: string, deg: number) {
  const s = insts.find(i => i.uid === uid); if (s) { s.rotation = (((s.rotation + deg) % 360) + 360) % 360; render(); }
}
function toggleBypass(uid: string) {
  const s = insts.find(i => i.uid === uid);
  const d = s && RUNNABLE[s.id];
  if (!s || !d) return;
  if (d.inputs !== 1 || d.outputs !== 1) { log('bypass only works on 1-in/1-out blocks'); return; }
  s.bypassed = !s.bypassed; render();
}

// ---- clipboard (Cut/Copy/Paste) ----
let clipboard: Omit<Inst, 'uid' | 'x' | 'y'> | null = null;
function copyBlock(uid: string) {
  const s = insts.find(i => i.uid === uid); if (!s) return;
  clipboard = { id: s.id, name: s.name, params: { ...s.params }, enabled: s.enabled, rotation: s.rotation, bypassed: s.bypassed };
  log('copied ' + s.name);
}
function pasteBlock(x = 80, y = 80) {
  if (!clipboard) return;
  const uid = 'b' + (++counter);
  insts.push({ ...clipboard, params: { ...clipboard.params }, uid,
    name: clipboard.id.replace(/^.*_/, '') + counter, x, y });
  select(uid); render();
}

// ---- right-click context menu (GRC-style) ----
let menuEl: HTMLDivElement | null = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function showMenu(x: number, y: number, inst: Inst) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'ctxmenu';
  const item = (label: string, fn: () => void, danger = false) => {
    const d = document.createElement('div');
    d.className = 'ctxitem' + (danger ? ' danger' : '');
    d.textContent = label;
    d.onclick = () => { closeMenu(); fn(); };
    m.appendChild(d);
  };
  const sep = () => m.appendChild(Object.assign(document.createElement('div'), { className: 'ctxsep' }));
  item('Properties', () => showPropsDialog(inst));
  sep();
  item('Cut', () => { copyBlock(inst.uid); deleteBlock(inst.uid); });
  item('Copy', () => copyBlock(inst.uid));
  item('Paste', () => pasteBlock(inst.x + 30, inst.y + 30));
  item('Duplicate', () => duplicateBlock(inst.uid));
  sep();
  item('Rotate Clockwise', () => rotate(inst.uid, 90));
  item('Rotate Counterclockwise', () => rotate(inst.uid, -90));
  item(inst.enabled ? 'Disable' : 'Enable', () => toggleEnabled(inst.uid));
  item(inst.bypassed ? 'Un-Bypass' : 'Bypass', () => toggleBypass(inst.uid));
  sep();
  item('Delete', () => deleteBlock(inst.uid), true);
  document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 6) + 'px';
  menuEl = m;
}
document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target as Node)) closeMenu(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeMenu(); document.querySelector('.modal.props')?.remove(); return; }
  const el = document.activeElement;
  if (el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return; // don't hijack typing
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Delete' && selected) deleteBlock(selected);
  else if (ctrl && e.key === 'c' && selected) copyBlock(selected);
  else if (ctrl && e.key === 'x' && selected) { copyBlock(selected); deleteBlock(selected); }
  else if (ctrl && e.key === 'v') pasteBlock();
  else if (ctrl && e.key === 'ArrowRight' && selected) { e.preventDefault(); rotate(selected, 90); }
  else if (ctrl && e.key === 'ArrowLeft' && selected) { e.preventDefault(); rotate(selected, -90); }
});

// ---- block Properties dialog (GRC-style modal) ----
function showPropsDialog(inst: Inst) {
  closeMenu();
  const d = RUNNABLE[inst.id]; if (!d) return;
  const tmp: { name: string; params: Record<string, any> } = { name: inst.name, params: { ...inst.params } };

  const overlay = document.createElement('div'); overlay.className = 'modal props';
  const dlg = document.createElement('div'); dlg.className = 'dlg';
  const head = document.createElement('div'); head.className = 'dlghead'; head.textContent = 'Properties: ' + d.label;
  const body = document.createElement('div'); body.className = 'dlgbody';

  const addField = (label: string, node: HTMLElement) => {
    const row = document.createElement('div'); row.className = 'dlgrow';
    const l = document.createElement('label'); l.textContent = label;
    row.appendChild(l); row.appendChild(node); body.appendChild(row);
    return node;
  };
  const nameI = addField('ID', document.createElement('input')) as HTMLInputElement;
  nameI.value = tmp.name; nameI.oninput = () => tmp.name = nameI.value.replace(/\s+/g, '_');
  for (const p of d.params) {
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; s.appendChild(opt); });
      s.value = String(tmp.params[p.id]); s.onchange = () => tmp.params[p.id] = s.value;
      addField(`${p.label}  (${p.id})`, s);
    } else {
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id]);
      inp.oninput = () => tmp.params[p.id] = p.type === 'number' ? Number(inp.value) : inp.value;
      addField(`${p.label}  (${p.id})`, inp);
    }
  }

  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const apply = () => { inst.name = tmp.name; inst.params = { ...tmp.params }; select(inst.uid); render(); };
  const btn = (label: string, fn: () => void, cls = '') => {
    const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b;
  };
  foot.appendChild(btn('Cancel', () => overlay.remove()));
  foot.appendChild(btn('Apply', apply));
  foot.appendChild(btn('OK', () => { apply(); overlay.remove(); }, 'run'));

  dlg.append(head, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  nameI.focus(); nameI.select();
}

function select(uid: string | null) { selected = uid; renderProps(); render(); }

function svgPoint(evt: MouseEvent): { x: number; y: number } {
  const r = svg.getBoundingClientRect();
  return { x: evt.clientX - r.left, y: evt.clientY - r.top };
}

const svgEl = (tag: string, attrs: Record<string, string>) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

function render() {
  nodesG.textContent = ''; wiresG.textContent = '';
  const G = (uid: string) => insts.find(i => i.uid === uid)!;
  // wires (from output right-edge to input left-edge, GRC-style curves)
  for (const c of conns) {
    const a = G(c.from), b = G(c.to); if (!a || !b) continue;
    const pa = portPos(a, 'out', c.fp), pb = portPos(b, 'in', c.tp);
    const x1 = a.x + pa.x, y1 = a.y + pa.y, x2 = b.x + pb.x, y2 = b.y + pb.y;
    const [c1x, c1y] = ctrl(pa.edge, x1, y1, 42);
    const [c2x, c2y] = ctrl(pb.edge, x2, y2, 42);
    wiresG.appendChild(svgEl('path', { class: 'wire',
      d: `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`, 'marker-end': 'url(#arrow)' }));
  }
  // blocks
  for (const inst of insts) {
    const { d, rows, h, w } = geom(inst);
    const col = portColor(inst.id);
    const g = svgEl('g', { class: 'blk' + (inst.uid === selected ? ' sel' : '') +
      (inst.enabled ? '' : ' disabled') + (inst.bypassed ? ' bypassed' : ''),
      transform: `translate(${inst.x},${inst.y})` });
    const rect = svgEl('rect', { class: 'body', width: String(w), height: String(h), rx: '2' });
    g.appendChild(rect);
    // title + underline (GRC draws a rule under the bold title)
    const t = svgEl('text', { class: 'title', x: String(w / 2), y: '15', 'text-anchor': 'middle' });
    t.textContent = d.label; g.appendChild(t);
    g.appendChild(svgEl('line', { x1: '0', y1: String(TITLE_H), x2: String(w), y2: String(TITLE_H),
      stroke: '#000', 'stroke-width': '1' }));
    // parameter rows: "label: value"
    rows.forEach((r, i) => {
      const y = TITLE_H + PAD + i * ROW_H + 11;
      const tx = svgEl('text', { class: 'param', x: '6', y: String(y) });
      const l = document.createElementNS(SVGNS, 'tspan'); l.textContent = r.l;
      const v = document.createElementNS(SVGNS, 'tspan'); v.setAttribute('class', 'pval'); v.textContent = r.v;
      tx.appendChild(l); tx.appendChild(v); g.appendChild(tx);
    });
    // Drag from anywhere on the block; ports stopPropagation so they still connect.
    g.addEventListener('mousedown', e => startDrag(e, inst));
    g.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); select(inst.uid); showMenu(e.clientX, e.clientY, inst); });
    g.addEventListener('dblclick', e => { e.preventDefault(); showPropsDialog(inst); });
    for (let i = 0; i < d.inputs; i++) addPort(g, inst, 'in', i, col);
    for (let i = 0; i < d.outputs; i++) addPort(g, inst, 'out', i, col);
    nodesG.appendChild(g);
  }
}

function addPort(g: SVGGElement, inst: Inst, kind: 'in' | 'out', idx: number, color: string) {
  // GRC ports: small typed rectangles protruding from the block edge (rotation-aware).
  const p = portPos(inst, kind, idx);
  let x: number, y: number, w: number, h: number;
  if (p.edge === 'L') { w = PORT_W; h = PORT_H; x = -PORT_W + 2; y = p.y - PORT_H / 2; }
  else if (p.edge === 'R') { w = PORT_W; h = PORT_H; x = p.x - 2; y = p.y - PORT_H / 2; }
  else if (p.edge === 'T') { w = PORT_H; h = PORT_W; x = p.x - PORT_H / 2; y = -PORT_W + 2; }
  else { w = PORT_H; h = PORT_W; x = p.x - PORT_H / 2; y = p.y - 2; }
  const r = svgEl('rect', { class: 'port', x: String(x), y: String(y),
    width: String(w), height: String(h), fill: color });
  r.addEventListener('mousedown', e => {
    e.stopPropagation();
    if (kind === 'out') { pending = { uid: inst.uid, port: idx }; log('connect from ' + inst.name + ':' + idx + ' …'); }
    else if (pending) {
      conns = conns.filter(cn => !(cn.to === inst.uid && cn.tp === idx));
      conns.push({ from: pending.uid, fp: pending.port, to: inst.uid, tp: idx });
      log('  → ' + G0(pending.uid).name + ':' + pending.port + '  to  ' + inst.name + ':' + idx);
      pending = null; render();
    }
  });
  g.appendChild(r);
}
const G0 = (uid: string) => insts.find(i => i.uid === uid)!;

let drag: { inst: Inst; ox: number; oy: number } | null = null;
function startDrag(e: MouseEvent, inst: Inst) {
  e.stopPropagation();
  if (e.button !== 0) return;   // right/middle click: let the context menu handle it
  e.preventDefault();           // stop the browser from starting a text selection
  select(inst.uid);
  const p = svgPoint(e); drag = { inst, ox: p.x - inst.x, oy: p.y - inst.y };
}
window.addEventListener('mousemove', e => {
  if (!drag) return; const p = svgPoint(e);
  drag.inst.x = Math.round(p.x - drag.ox); drag.inst.y = Math.round(p.y - drag.oy); render();
});
window.addEventListener('mouseup', () => { drag = null; });
svg.addEventListener('mousedown', () => { select(null); pending = null; });
svg.addEventListener('contextmenu', e => {
  e.preventDefault(); closeMenu();
  const m = document.createElement('div'); m.className = 'ctxmenu';
  const d = document.createElement('div'); d.className = 'ctxitem';
  d.textContent = 'Paste'; d.style.opacity = clipboard ? '1' : '.4';
  d.onclick = () => { closeMenu(); if (clipboard) { const p = svgPoint(e); pasteBlock(p.x, p.y); } };
  m.appendChild(d); document.body.appendChild(m);
  m.style.left = Math.min(e.clientX, window.innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = Math.min(e.clientY, window.innerHeight - m.offsetHeight - 6) + 'px';
  menuEl = m;
});

function renderProps() {
  const body = el('propBody');
  if (!selected) { body.innerHTML = 'Select a block…'; return; }
  const inst = insts.find(i => i.uid === selected)!; const d = RUNNABLE[inst.id];
  body.innerHTML = '';
  const mk = (label: string, node: HTMLElement) => {
    const l = document.createElement('label'); l.textContent = label; body.appendChild(l); body.appendChild(node);
  };
  const nameI = document.createElement('input'); nameI.value = inst.name;
  nameI.oninput = () => { inst.name = nameI.value.replace(/\s+/g, '_'); render(); };
  mk('Block name (id)', nameI);
  for (const p of d.params) {
    let node: HTMLElement;
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; s.appendChild(opt); });
      s.value = String(inst.params[p.id]); s.onchange = () => inst.params[p.id] = s.value;
      node = s;
    } else {
      const inp = document.createElement('input'); inp.value = String(inst.params[p.id]);
      inp.oninput = () => inst.params[p.id] = p.type === 'number' ? Number(inp.value) : inp.value;
      node = inp;
    }
    mk(p.label + '  (' + p.id + ')', node);
  }
}

function toFlowgraphJSON() {
  const byUid = (u: string) => insts.find(i => i.uid === u)!;
  const active = (u: string) => { const b = byUid(u); return b && b.enabled && !b.bypassed; };
  const bypassed = (u: string) => { const b = byUid(u); return b && b.enabled && b.bypassed; };
  // Resolve a downstream endpoint through bypassed blocks to active endpoints.
  const resolveDown = (uid: string, port: number, seen = new Set<string>()): { uid: string; port: number }[] => {
    if (active(uid)) return [{ uid, port }];
    if (!bypassed(uid) || seen.has(uid)) return [];
    seen.add(uid);
    return conns.filter(c => c.from === uid).flatMap(c => resolveDown(c.to, c.tp, seen));
  };
  const out: any[] = []; const seen = new Set<string>();
  for (const c of conns) {
    if (!active(c.from)) continue;               // start from active sources
    for (const d of resolveDown(c.to, c.tp)) {   // hop over any bypassed blocks
      const key = `${c.from}:${c.fp}>${d.uid}:${d.port}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push([byUid(c.from).name, c.fp, byUid(d.uid).name, d.port]);
    }
  }
  return {
    blocks: insts.filter(i => active(i.uid)).map(i => ({ name: i.name, id: i.id, params: i.params })),
    connections: out,
  };
}

// ---- Run: hand the flowgraph to the WASM runner via an overlay iframe ----
function run() {
  const fg = toFlowgraphJSON();
  if (!fg.blocks.length) { log('nothing to run — add some blocks'); return; }
  const url = '/runner/build/runner.html#' + encodeURIComponent(JSON.stringify(fg));
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:99';
  const box = document.createElement('div');
  box.style.cssText = 'width:860px;height:600px;background:#20232f;border:1px solid #46507a;border-radius:10px;overflow:hidden;display:flex;flex-direction:column';
  const bar = document.createElement('div');
  bar.style.cssText = 'padding:8px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #333a4d';
  bar.innerHTML = '<b style="font-size:13px">Running flowgraph…</b>';
  const close = document.createElement('button'); close.textContent = '✕ Stop'; close.style.marginLeft = 'auto';
  close.onclick = () => overlay.remove(); bar.appendChild(close);
  const frame = document.createElement('iframe');
  frame.src = url; frame.style.cssText = 'flex:1;border:0;background:#fff';
  box.appendChild(bar); box.appendChild(frame); overlay.appendChild(box); document.body.appendChild(overlay);
  log('▶ running ' + fg.blocks.length + ' blocks, ' + fg.connections.length + ' connections');
}

// ---- Palette ----
// ---- GRC-style block tree (collapsible categories + search) ----
interface Cat { name: string; path: string; subs: Map<string, Cat>; blocks: { id: string; label: string }[] }

function buildTree(blocks: any[]): Cat {
  const root: Cat = { name: '', path: '', subs: new Map(), blocks: [] };
  for (const b of blocks) {
    const parts = String(b.category || 'Other').split('/').filter(Boolean);
    let node = root, path = '';
    for (const part of parts) {
      path = path ? path + '/' + part : part;
      let sub = node.subs.get(part);
      if (!sub) { sub = { name: part, path, subs: new Map(), blocks: [] }; node.subs.set(part, sub); }
      node = sub;
    }
    node.blocks.push({ id: b.id, label: b.label || b.id });
  }
  return root;
}
const matchesQ = (b: { id: string; label: string }, q: string) => !q || (b.label + ' ' + b.id).toLowerCase().includes(q);
function catMatches(node: Cat, q: string): boolean {
  return !q || node.blocks.some(b => matchesQ(b, q)) || [...node.subs.values()].some(s => catMatches(s, q));
}

function makeBlockItem(b: { id: string; label: string }, indent: number): HTMLElement {
  const run = !!RUNNABLE[b.id];
  const item = document.createElement('div');
  item.className = 'pal-item' + (run ? ' runnable' : '');
  item.style.paddingLeft = indent + 'px';
  item.textContent = b.label;
  item.title = b.id + (run ? '' : '  (in palette; not yet in the runner registry)');
  item.onclick = () => run ? addBlock(b.id) : log('"' + b.id + '" is in the palette but not yet runnable');
  return item;
}
function makeCatRow(name: string, container: HTMLElement, open: boolean, bold = false, indent = 6): HTMLElement {
  const row = document.createElement('div'); row.className = 'cat-row'; row.style.paddingLeft = indent + 'px';
  const tri = document.createElement('span'); tri.className = 'tri';
  const nm = document.createElement('span'); nm.textContent = name; if (bold) nm.style.fontWeight = '600';
  row.append(tri, nm);
  const kids = document.createElement('div');
  tri.textContent = open ? '▾' : '▸'; kids.style.display = open ? 'block' : 'none';
  row.onclick = () => {
    const isOpen = kids.style.display !== 'none';
    kids.style.display = isOpen ? 'none' : 'block'; tri.textContent = isOpen ? '▸' : '▾';
  };
  container.append(row, kids);
  return kids;
}
function renderTree(node: Cat, container: HTMLElement, depth: number, q: string) {
  for (const s of [...node.subs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!catMatches(s, q)) continue;
    const kids = makeCatRow(s.name, container, !!q, false, 6 + depth * 13);
    renderTree(s, kids, depth + 1, q);
  }
  for (const b of [...node.blocks].filter(b => matchesQ(b, q)).sort((a, b) => a.label.localeCompare(b.label)))
    container.appendChild(makeBlockItem(b, 6 + depth * 13 + 16));
}

let LIB: any = { blocks: [] };
async function buildPalette() {
  const pal = el('palette');
  const search = document.createElement('input');
  search.className = 'palsearch'; search.placeholder = 'Search blocks…';
  const tree = document.createElement('div'); tree.className = 'tree';
  pal.append(search, tree);
  try {
    LIB = await (await fetch('/editor/dist/blocks.json').then(r => r.ok ? r : fetch('/editor/public/blocks.json'))).json();
  } catch (e) { log('block library not loaded: ' + e); }
  const draw = (q: string) => {
    tree.textContent = '';
    // convenience group of blocks the runner actually supports (expanded)
    const runnable = Object.keys(RUNNABLE).map(id => ({ id, label: RUNNABLE[id].label })).filter(b => matchesQ(b, q));
    if (runnable.length) {
      const kids = makeCatRow('★ Runnable blocks', tree, true, true, 6);
      runnable.sort((a, b) => a.label.localeCompare(b.label)).forEach(b => kids.appendChild(makeBlockItem(b, 22)));
    }
    renderTree(buildTree(LIB.blocks), tree, 0, q);
  };
  draw('');
  search.oninput = () => draw(search.value.trim().toLowerCase());
}

el('btnRun').addEventListener('click', run);
el('btnClear').addEventListener('click', () => { insts = []; conns = []; select(null); render(); });
el('btnExport').addEventListener('click', () => log(JSON.stringify(toFlowgraphJSON(), null, 1)));

buildPalette();
// Seed with a multi-source demo (signal + noise -> add -> throttle -> scope).
addBlock('analog_sig_source_x', 50, 70);
addBlock('analog_noise_source_x', 50, 230);
addBlock('blocks_add_xx', 300, 130);
addBlock('blocks_throttle', 500, 130);
addBlock('qtgui_time_sink_x', 690, 130);
const [src, noise, add, thr, snk] = insts;
conns.push({ from: src.uid, fp: 0, to: add.uid, tp: 0 });
conns.push({ from: noise.uid, fp: 0, to: add.uid, tp: 1 });
conns.push({ from: add.uid, fp: 0, to: thr.uid, tp: 0 });
conns.push({ from: thr.uid, fp: 0, to: snk.uid, tp: 0 });
select(null); render();
log('Editor ready. Click ▶ Run to execute the flowgraph in WebAssembly.');
