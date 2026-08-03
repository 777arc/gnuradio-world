// The Help ▸ WebAssembly Modules & Debug Info dialog: what the browser gives us
// (cross-origin isolation, SharedArrayBuffer, cores), what each category module
// costs and whether it has been fetched yet, and the live runner's heap and
// thread count. It is the reader-facing half of docs/diagnostics.md.
//
// It reaches into the editor only through the handles in DebugInfoDeps, so it
// stays independent of the editor's own state.
export interface DebugInfoDeps {
  /** main.ts's modal opener: (title, buildBody, wide). */
  openDialog: (title: string, build: (body: HTMLElement) => void, wide?: boolean) => void;
  /** The loaded blocks.json, for per-module block counts. */
  library: () => { blocks?: any[] };
  /** Where blocks.json was fetched from, so its size can be reported too. */
  blocksUrl: string;
  /** Short names of the category side modules dlopen'd so far this session. */
  loadedModules: ReadonlySet<string>;
}

const WASM_BASE = '/runner/build/';
function fmtBytes(n: number | null): string {
  if (n == null || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
async function headSize(url: string): Promise<number | null> {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return null;
    const len = r.headers.get('content-length');
    return len ? parseInt(len, 10) : null;
  } catch { return null; }
}
function dbgHeading(text: string): HTMLElement {
  const h = document.createElement('div'); h.className = 'debug-h'; h.textContent = text; return h;
}
function dbgKV(k: string, v: string, mono = false): HTMLElement {
  const row = document.createElement('div'); row.className = 'debug-kv';
  const kk = document.createElement('span'); kk.className = 'debug-k'; kk.textContent = k;
  const vv = document.createElement('span'); vv.className = 'debug-v' + (mono ? ' mono' : ''); vv.textContent = v;
  row.append(kk, vv); return row;
}
export function showDebugInfo(deps: DebugInfoDeps): void {
  const { openDialog, library, blocksUrl, loadedModules } = deps;
  openDialog('WebAssembly Modules & Debug Info', body => {
    body.classList.add('debug-body');

    // --- environment ---
    const env = document.createElement('div'); env.className = 'debug-section';
    env.appendChild(dbgHeading('Environment'));
    const iso = (self as any).crossOriginIsolated === true;
    env.appendChild(dbgKV('Cross-origin isolated', iso ? 'yes' : 'NO — WASM threads unavailable'));
    env.appendChild(dbgKV('SharedArrayBuffer', typeof SharedArrayBuffer !== 'undefined' ? 'available' : 'MISSING'));
    env.appendChild(dbgKV('Logical cores', String((navigator as any).hardwareConcurrency ?? '?')));
    env.appendChild(dbgKV('Device pixel ratio', String(window.devicePixelRatio || 1)));
    env.appendChild(dbgKV('User agent', navigator.userAgent, true));
    body.appendChild(env);

    // --- wasm modules (sizes fetched async) ---
    const sec = document.createElement('div'); sec.className = 'debug-section';
    sec.appendChild(dbgHeading('WebAssembly modules'));
    const tbl = document.createElement('table'); tbl.className = 'debug-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>File</th><th>Category</th><th class="num">Blocks</th>' +
                      '<th class="num">Size</th><th>State</th></tr>';
    const tbody = document.createElement('tbody');
    const loading = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 5; td.textContent = 'measuring…'; loading.appendChild(td);
    tbody.appendChild(loading);
    tbl.append(thead, tbody); sec.appendChild(tbl);
    const totals = document.createElement('div'); totals.className = 'debug-totals'; sec.appendChild(totals);
    body.appendChild(sec);

    // --- data assets + live runtime ---
    const extra = document.createElement('div'); extra.className = 'debug-section';
    extra.appendChild(dbgHeading('Data & runtime'));
    body.appendChild(extra);

    void (async () => {
      const blocks: any[] = library().blocks || [];
      const counts: Record<string, number> = {};
      for (const b of blocks) { const m = b.module || 'core'; counts[m] = (counts[m] || 0) + 1; }
      // core first, then deferred alphabetically
      const mods = Object.keys(counts).sort((a, b) =>
        a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b));

      tbody.textContent = '';
      let coreBytes = 0, deferredBytes = 0, downloadedBytes = 0;
      for (const m of mods) {
        const core = m === 'core';
        const file = core ? 'runner.wasm' : `${m}.wasm`;
        const size = await headSize(WASM_BASE + file);
        const loaded = core || loadedModules.has(m);
        if (size != null) {
          if (core) coreBytes += size;
          else { deferredBytes += size; if (loaded) downloadedBytes += size; }
        }
        const tr = document.createElement('tr');
        const cells: [string, string][] = [
          [file, 'mono'], [core ? 'core' : m, ''], [String(counts[m]), 'num'],
          [fmtBytes(size), 'num'],
          [core ? 'always loaded' : loaded ? 'downloaded' : 'on demand',
           core ? 'state-core' : loaded ? 'state-loaded' : 'state-pending'],
        ];
        for (const [text, cls] of cells) {
          const cell = document.createElement('td'); if (cls) cell.className = cls; cell.textContent = text;
          tr.appendChild(cell);
        }
        tbody.appendChild(tr);
      }
      totals.textContent =
        `Core (always downloaded): ${fmtBytes(coreBytes)}   •   ` +
        `Deferred total: ${fmtBytes(deferredBytes)}   •   ` +
        `Downloaded this session: ${fmtBytes(downloadedBytes)}`;

      // block-library metadata size
      extra.appendChild(dbgKV('blocks.json (palette metadata)',
        fmtBytes(await headSize(blocksUrl))));
      extra.appendChild(dbgKV('Block definitions', `${blocks.length} total, ${blocks.filter(b => b.runnable).length} runnable`));

      // live runner stats, if the runner iframe is active (same-origin)
      let live = 'runner not started';
      try {
        const frame = document.getElementById('runFrame') as HTMLIFrameElement | null;
        const raw = (frame?.contentWindow as any)?.__grstats;
        if (raw) {
          const s = JSON.parse(raw);
          live = `heap ${fmtBytes(s.wasm_heap)}, ${s.dsp_threads} DSP thread(s), uptime ${Math.round(s.uptime_s)}s`;
        }
      } catch { /* cross-frame not ready */ }
      extra.appendChild(dbgKV('Runner runtime', live));
    })();
  }, true);
}
