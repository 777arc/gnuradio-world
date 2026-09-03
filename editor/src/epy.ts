// The editor's half of the Embedded Python Block.
//
// Two jobs:
//
//   * turn a block's derived interface (its `_io_cache`) into a RunnableDef, so
//     the rest of the editor -- ports, the Properties dialog, validation, .grc
//     serialization -- treats a Python Block like any other block. Everything
//     downstream of defFor() in main.ts is unchanged; only the definition it
//     reads is per instance instead of per block id.
//
//   * re-derive that interface from the source, by running the *same*
//     introspection the runner uses, in the same Pyodide worker
//     (runner/src/pyodide/gr_pyodide_worker.js). That is what keeps the editor's
//     view of a Python Block identical to what the flowgraph will actually build.
//
// Loading Python is opt-in: it is ~16 MB, and a Python Block placed from the
// palette already has ports, because its `_io_cache` default in
// blocks/grc/epy_block.block.yml describes its default source. Nothing is fetched
// until the source is edited and the user asks for it.
import type { ParamDef, PortTemplate, RunnableDef } from './block-defs';

export const EPY_BLOCK_ID = 'epy_block';
export const EPY_SOURCE_PARAM = '_source_code';
export const EPY_IO_CACHE_PARAM = '_io_cache';
// Native GRC's dtype for a parameter holding Python source, which it hands to an
// external editor and never evaluates (grc/core/params/param.py). Here it selects
// the code field in the Properties dialog.
export const EPY_CODE_DTYPE = '_multiline_python_external';

// What runner/src/pyodide/py/grworld.py reports about one block. A tuple per
// stream port: [id, GRC type, vlen]; a pair per parameter: [id, repr of default].
export interface BlockIo {
  cls: string;
  label: string;
  doc: string;
  params: [string, string][];
  callbacks: string[];
  sinks: [string, string, number][];
  sources: [string, string, number][];
  msg_ports_in: string[];
  msg_ports_out: string[];
  block_type: string;
}

export function parseIoCache(text: unknown): BlockIo | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const io = JSON.parse(text);
    return io && Array.isArray(io.params) && Array.isArray(io.sinks) ? io as BlockIo : null;
  } catch {
    return null;   // a hand-edited or foreign cache is not worth an error
  }
}

// A .grc written by desktop GRC keeps the same thing as a Python tuple repr, so
// its cache is unreadable here. That is not a problem worth solving: the ports it
// describes are re-derived the moment the Python runtime loads, and until then the
// block simply shows none.
export function isForeignIoCache(text: unknown): boolean {
  return typeof text === 'string' && text.trim().startsWith('(');
}

const portTemplate = (
  [id, dtype, vlen]: [string, string, number], domain: string, label: string,
): PortTemplate => ({
  dtype, vlen: String(vlen), domain, id, label,
  multiplicity: '1',
  // A message port is optional, as it is on every other block: upstream's
  // _update_ports sets optional='1' on them too, so an unconnected one does not
  // make the block invalid.
  optional: domain === 'message', hide: false,
});

// Each stream port is its own template with multiplicity 1, so nothing numbers
// them the way a repeated port is numbered -- two inputs would both read "in".
// Name them here instead, and only when there is more than one to tell apart.
const streamTemplates = (
  ports: [string, string, number][], kind: 'in' | 'out',
): PortTemplate[] => ports.map((port, index) =>
  portTemplate(port, 'stream', ports.length > 1 ? `${kind}${index}` : ''));

/**
 * The definition for one Python Block instance: the static schema from
 * blocks.json (the Code parameter and the hidden cache) plus everything its own
 * source says about it.
 */
export function epyDef(base: RunnableDef, io: BlockIo | null): RunnableDef {
  const staticParams = base.params.filter(
    p => p.id === EPY_SOURCE_PARAM || p.id === EPY_IO_CACHE_PARAM);
  if (!io) return { ...base, params: staticParams, inputs: 0, outputs: 0,
                    inputTemplates: [], outputTemplates: [] };

  // Every introspected __init__ argument becomes a parameter, as upstream's
  // _update_params does. Deliberately not `raw`: a raw param is evaluated by
  // resolveParamsForRun and rewritten into the runner's own vector spelling,
  // which Python could not eval. These expressions are evaluated by Python
  // itself, in a namespace holding the flowgraph's variables -- which is what
  // the generated Python does natively.
  // Every introspected callback becomes a numeric setter in the factory, so the
  // underline is derived from the block's own source here rather than from
  // blocks.json, which knows only the three static parameters.
  const callbacks = new Set(io.callbacks || []);
  const derived: ParamDef[] = io.params.map(([id, def]) => ({
    id,
    // upstream's _update_params: `example_param` shows as "Example Param".
    label: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    type: 'string',
    def,
    live: callbacks.has(id),
  }));
  const inputTemplates = [
    ...streamTemplates(io.sinks, 'in'),
    ...(io.msg_ports_in || []).map(id => portTemplate([id, 'message', 1], 'message', id)),
  ];
  const outputTemplates = [
    ...streamTemplates(io.sources, 'out'),
    ...(io.msg_ports_out || []).map(id => portTemplate([id, 'message', 1], 'message', id)),
  ];
  return {
    ...base,
    label: io.label || io.cls || base.label,
    // The class docstring, as GRC shows it in the Documentation tab.
    documentation: io.doc || base.documentation,
    params: [...staticParams, ...derived],
    inputs: inputTemplates.length,
    outputs: outputTemplates.length,
    inputTemplates,
    outputTemplates,
  };
}

// One synthesized definition per distinct cache string, so dragging a block
// around does not rebuild its schema on every frame.
const defCache = new Map<string, RunnableDef>();

export function epyDefForCache(base: RunnableDef, cache: unknown): RunnableDef {
  const key = typeof cache === 'string' ? cache : '';
  let def = defCache.get(key);
  if (!def) {
    def = epyDef(base, parseIoCache(key));
    defCache.set(key, def);
  }
  return def;
}

// The last introspection failure per block instance, so a Python Block with a
// broken source reddens on the canvas rather than only in its dialog -- native
// GRC's `_epy_reload_error`, which it attaches to the Code parameter. Keyed by
// uid and kept out of `inst.params`, which is serialized wholesale into the .grc.
const sourceErrors = new Map<string, string>();

export function setEpySourceError(uid: string, message: string) {
  if (message) sourceErrors.set(uid, message);
  else sourceErrors.delete(uid);
}

export function epySourceError(uid: string): string {
  return sourceErrors.get(uid) || '';
}

// ---- the Python runtime ---------------------------------------------------

export type RuntimeState = 'absent' | 'loading' | 'ready' | 'failed';

const WORKER_URL = '/runner/build/pyodide/gr_pyodide_worker.js';
const PYODIDE_URL = '/pyodide/';
const SHIM_URL = '/runner/build/pyodide/py/';
const CONSENT_KEY = 'gnuradio-world.python-runtime';

type Pending = { resolve: (io: BlockIo) => void; reject: (error: Error) => void };

class PythonRuntime {
  state: RuntimeState = 'absent';
  error = '';
  onchange: (() => void) | null = null;
  onprint: ((line: string) => void) | null = null;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  /** True once the user has loaded Python in any session, so we do not re-ask. */
  get consented(): boolean {
    try { return localStorage.getItem(CONSENT_KEY) === 'yes'; } catch { return false; }
  }

  private setState(state: RuntimeState, error = '') {
    this.state = state;
    this.error = error;
    this.onchange?.();
  }

  /** Start the runtime, or return the in-flight start. Idempotent. */
  load(): Promise<void> {
    if (this.ready) return this.ready;
    try { localStorage.setItem(CONSENT_KEY, 'yes'); } catch { /* private mode */ }
    this.setState('loading');
    this.ready = new Promise<void>((resolve, reject) => {
      const worker = new Worker(WORKER_URL, { type: 'module' });
      this.worker = worker;
      worker.onerror = event => {
        const message = event.message || 'the Python runtime failed to start';
        this.setState('failed', message);
        this.failAll(message);
        reject(new Error(message));
      };
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.type === 'print') { this.onprint?.(String(message.line)); return; }
        if (message.type === 'ready') { this.setState('ready'); resolve(); return; }
        if (message.type === 'introspected') {
          this.pending.get(message.id)?.resolve(message.io);
          this.pending.delete(message.id);
          return;
        }
        if (message.type === 'failed') {
          const text = String(message.message || 'Python failed');
          const waiter = this.pending.get(message.id);
          if (waiter) {
            this.pending.delete(message.id);
            waiter.reject(new Error(text));
          } else {
            this.setState('failed', text);
            reject(new Error(text));
          }
        }
      };
      worker.postMessage({
        type: 'init',
        indexURL: new URL(PYODIDE_URL, location.href).href,
        shimURL: new URL(SHIM_URL, location.href).href,
      });
    });
    return this.ready;
  }

  private failAll(message: string) {
    for (const waiter of this.pending.values()) waiter.reject(new Error(message));
    this.pending.clear();
  }

  /** Derive a block's interface from its source. Loads the runtime if needed. */
  async introspect(source: string): Promise<BlockIo> {
    await this.load();
    if (!this.worker) throw new Error(this.error || 'the Python runtime is not running');
    const id = this.nextId++;
    return new Promise<BlockIo>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'introspect', id, source });
    });
  }
}

export const pythonRuntime = new PythonRuntime();
