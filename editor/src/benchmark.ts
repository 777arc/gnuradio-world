// The Help ▸ Benchmark Tool dialog: how fast this browser/machine can push
// complex samples through GNU Radio's filter blocks.
//
// It is deliberately unrelated to whatever the editor has on its canvas. Each
// cell of the matrix is its own generated flowgraph — Null Source → filter →
// Null Sink — run on its own in a private offscreen runner iframe, one after
// another, so the filter under test has the whole machine to itself. Null
// Source also keeps the samples at zero, the one input that can never drag a
// float path into denormal territory.
//
// The rate is end-to-end: samples the filter has produced divided by the time
// the flowgraph has been running. Both numbers come from a single diagnostics
// snapshot (window.__grstats, published ~3 Hz by the runner), whose `uptime_s`
// is measured from the instant the runner launched tb->run(). So the elapsed
// time includes graph start-up and every per-sample cost in the chain, not just
// the filter kernel — which is the honest answer to "how fast can this machine
// pump samples through the block?".
//
// Like debug-panel.ts, it touches the editor only through BenchmarkDeps.
export interface BenchmarkDeps {
  /** main.ts's modal opener: (title, buildBody, wide) -> the overlay element. */
  openDialog: (title: string, build: (body: HTMLElement) => void, wide?: boolean) => HTMLElement;
  /** Editor console, for the summary line and any per-case failure. */
  log: (message: string) => void;
  /** True while the editor's own flowgraph is running, which skews results. */
  isFlowgraphRunning: () => boolean;
}

const TAP_COUNTS = [101, 1001, 10001];

interface FilterCase {
  key: string;
  label: string;
  id: string;
  /** The .grc parameters for the device under test, at `taps` taps. */
  params: (taps: number) => Record<string, string>;
}

// Both filters are complex in, complex out, real taps (`ccf`), decimation 1.
// Tap *values* do not affect the cost of either, so they are short constants
// that keep the URL small at 10001 taps.
const FILTERS: FilterCase[] = [
  {
    key: 'fir', label: 'Null Source -> Decimating FIR Filter -> Null Sink', id: 'fir_filter_xxx',
    params: taps => ({ type: 'ccf', decim: "'1'", taps: quoted(repeat('1e-4', taps)), samp_delay: "'0'" }),
  },
  {
    key: 'fft', label: 'Null Source -> FFT Filter -> Null Sink', id: 'fft_filter_xxx',
    params: taps => ({
      type: 'ccf', decim: "'1'", taps: quoted(repeat('1e-4', taps)),
      nthreads: "'1'", samp_delay: "'0'",
    }),
  },
];

const POLL_MS = 40;
/**
 * How long a flowgraph must have been running before its counters are read.
 *
 * An end-to-end rate is a *cumulative* average — every sample since the graph
 * started, over every second since the graph started — so it approaches the
 * sustained rate from below and only gets there once start-up is a small part
 * of the total. How long that takes depends on the flowgraph: a three-block
 * filter chain is within ~5% after half a second, but a 25-block chain is still
 * filling its pipeline then, because the block being counted sits at the *end*
 * of it. Read too early and that case reports a rate 40x too low.
 *
 * Two seconds puts every case here within ~10-15% of where it settles, and one
 * value for all of them keeps the cells comparable with each other. It is also
 * most of what a run costs: nine cases, two seconds each.
 */
const MIN_RUN_SECONDS = 2;
/** Nominal cost of one case, used to pace the progress bar (not a timeout). */
const CASE_ESTIMATE_MS = 3200;
/**
 * Ceiling on Qt + WASM startup plus the flowgraph producing its first samples.
 * Generous because of the 256-worker tier: the 30-block chain spends ~28s
 * spawning workers on this machine before its first sample, so a slower one
 * must not trip the timeout and report a case that was merely still starting.
 */
const START_TIMEOUT_MS = 90000;

const repeat = (value: string, count: number) => '[' + new Array(count).fill(value).join(',') + ']';
const quoted = (value: string) => `'${value}'`;

function grcBlock(name: string, id: string, params: Record<string, string>): string {
  return `-   name: ${name}\n    id: ${id}\n    parameters:\n` +
    Object.entries(params).map(([key, value]) => `        ${key}: ${value}`).join('\n') +
    '\n    states:\n        coordinate: [0, 0]\n        rotation: 0\n        state: enabled\n';
}

const NULL_SOURCE = grcBlock('src', 'blocks_null_source',
  { type: 'complex', num_outputs: "'1'", vlen: "'1'" });
const NULL_SINK = grcBlock('snk', 'blocks_null_sink',
  { type: 'complex', num_inputs: "'1'", vlen: "'1'" });

function flowgraph(blocks: string, connections: string): string {
  return 'options:\n    parameters:\n        id: gr_world_benchmark\n' +
    '    states:\n        coordinate: [0, 0]\n        rotation: 0\n        state: enabled\n' +
    `blocks:\n${NULL_SOURCE}${blocks}${NULL_SINK}connections:\n${connections}`;
}

// How many Multiply Const blocks to string together. Length costs more than
// arithmetic here, because GNU Radio runs one thread per block and the runner's
// pool ladder (poolTierForBlockCount in runner.html, worker_tier_for in
// runner.cpp) jumps straight from 32 workers to 256. 30 blocks plus the source
// and sink needs 33 workers, so it lands in the 256 tier and spends ~28s
// spawning them before its first sample; 25 would have needed 28 and booted in
// ~4s like every other case. Rounding the ladder to multiples of 8 would fix
// it, in both copies.
const CHAIN_LENGTHS = [10, 20, 30];

/** A chain of `count` Multiply Const blocks between the source and the sink. */
function multiplyChainFlowgraph(count: number): string {
  let blocks = '';
  let connections = '';
  let upstream = 'src';
  for (let index = 0; index < count; index++) {
    // The last one is the block the rate is read from, so it carries the name
    // every case uses; being last it has also seen the whole chain's latency.
    const name = index === count - 1 ? 'dut' : `mult${index}`;
    blocks += grcBlock(name, 'blocks_multiply_const_vxx',
      { type: 'complex', mode: 'scalar', const: "'1'", vlen: "'1'" });
    connections += `- [${upstream}, '0', ${name}, '0']\n`;
    upstream = name;
  }
  return flowgraph(blocks, connections + `- [${upstream}, '0', snk, '0']\n`);
}

export interface BenchmarkCase { key: string; column: string; grc: string }
export interface BenchmarkTable {
  /** `columnHeading` doubles as the group's label: it heads the first column. */
  key: string; columnHeading: string;
  rows: { key: string; label: string; cases: BenchmarkCase[] }[];
}

/**
 * Every case a run measures, grouped the way the dialog tabulates it. Filters
 * first, then the Multiply Const chains; a run walks them in this order, one
 * flowgraph at a time.
 */
export function benchmarkTables(): BenchmarkTable[] {
  return [
    {
      key: 'filters', columnHeading: 'Filter',
      rows: FILTERS.map(filter => ({
        key: filter.key,
        label: filter.label,
        cases: TAP_COUNTS.map(taps => ({
          key: `${filter.key}:${taps}`,
          column: `${taps.toLocaleString()} taps`,
          grc: flowgraph(grcBlock('dut', filter.id, filter.params(taps)),
            "- [src, '0', dut, '0']\n- [dut, '0', snk, '0']\n"),
        })),
      })),
    },
    {
      key: 'chain', columnHeading: 'Long Chain of Blocks',
      rows: [{
        key: 'mult',
        label: 'Null Source -> N x Multiply Const -> Null Sink',
        cases: CHAIN_LENGTHS.map(count => ({
          key: `mult:${count}`,
          column: `${count} blocks`,
          grc: multiplyChainFlowgraph(count),
        })),
      }],
    },
  ];
}

/** The cases a run walks, flattened into measurement order. */
export function benchmarkCases(): (BenchmarkCase & { label: string })[] {
  return benchmarkTables().flatMap(table =>
    table.rows.flatMap(row => row.cases.map(item => ({ ...item, label: row.label }))));
}

// The one iframe a run drives, so the editor can tell the runner messages it
// posts (gr-error, gr-print, gr-module) apart from its own runner's.
let benchFrame: HTMLIFrameElement | null = null;

/** True for a message posted by the benchmark's private runner. */
export function isBenchmarkFrameSource(event: MessageEvent): boolean {
  return !!benchFrame && !!benchFrame.contentWindow && event.source === benchFrame.contentWindow;
}

/** Samples the block under test has produced, and the flowgraph's own uptime. */
interface Reading { seconds: number; items: number }

/**
 * `search` identifies the case whose document this must be. Navigation is not
 * instant, so for a while after `frame.src` is set the old document is still
 * there with the *previous* case's `__grstats` on it — a reading that passes
 * every sanity check while belonging to the wrong filter.
 */
function readSnapshot(frame: HTMLIFrameElement, search: string): Reading | null {
  let live: any;
  try {
    live = frame.contentWindow;
    if (!live || live.location.search !== search) return null;
  } catch { return null; }   // mid-navigation
  const raw = live.__grstats;
  if (!raw) return null;
  try {
    const stats = JSON.parse(raw);
    const dut = (stats.blocks || []).find((block: any) => block.name === 'dut');
    if (!dut) return null;
    return { seconds: Number(stats.uptime_s), items: Number(dut.items) };
  } catch { return null; }
}

/** The runner's own pass/fail banner, once this case's document has one. */
function readRunnerFailure(frame: HTMLIFrameElement, search: string): string | null {
  try {
    if (frame.contentWindow?.location.search !== search) return null;
  } catch { return null; }
  const result = frame.contentDocument?.getElementById('result');
  if (!result || result.getAttribute('data-status') !== 'fail') return null;
  return (result.textContent || 'flowgraph failed').replace(/^RESULT:\s*RUNNER_FAIL\s*/, '');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Run one case on its own and return its end-to-end rate in samples/second. */
async function measureCase(
  frame: HTMLIFrameElement, benchmark: BenchmarkCase, alive: () => boolean,
): Promise<number> {
  // A hash-only change does not reload a document, so the query string carries
  // the case: without it every case after the first would re-measure the first.
  // It doubles as the identity every read below is checked against.
  const search = `?benchmark=${encodeURIComponent(benchmark.key)}`;
  frame.src = `/runner/build/runner.html${search}#${encodeURIComponent(benchmark.grc)}`;

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    await sleep(POLL_MS);
    if (!alive()) throw new Error('cancelled');
    const failure = readRunnerFailure(frame, search);
    if (failure) throw new Error(failure);
    const reading = readSnapshot(frame, search);
    if (reading && reading.items > 0 && reading.seconds >= MIN_RUN_SECONDS)
      return reading.items / reading.seconds;
    if (Date.now() > deadline) throw new Error('the flowgraph produced no samples');
  }
}

function formatRate(samplesPerSecond: number): string {
  return `${(samplesPerSecond / 1e6).toPrecision(3)} MS/s`;
}

// Results survive closing the dialog, so reopening it shows the last run rather
// than an empty matrix. Keyed "<filter>:<taps>".
const results = new Map<string, { rate?: number; error?: string }>();
let lastRunLabel = '';

export function showBenchmarkDialog(deps: BenchmarkDeps): void {
  const { openDialog, log, isFlowgraphRunning } = deps;
  let overlay: HTMLElement | null = null;
  let running = false;

  overlay = openDialog('Benchmark Tool', body => {
    body.classList.add('debug-body', 'bench-body');

    const intro = document.createElement('div');
    intro.className = 'bench-intro';
    intro.textContent =
      'Measures how fast this machine pushes complex samples through ' +
      'blocks in WebAssembly. Rate is end-to-end: samples through the flowgraph divided by how ' +
      'long it ran, so startup overhead is included.';
    body.appendChild(intro);

    const warning = document.createElement('div');
    warning.className = 'bench-warn';
    warning.hidden = true;
    body.appendChild(warning);

    const controls = document.createElement('div');
    controls.className = 'bench-controls';
    const button = document.createElement('button');
    button.className = 'bench-run';
    button.textContent = 'Run Benchmark';
    const status = document.createElement('span');
    status.className = 'bench-status';
    status.textContent = lastRunLabel || 'Not run yet.';
    controls.append(button, status);
    body.appendChild(controls);

    const track = document.createElement('div');
    track.className = 'bench-progress';
    track.hidden = true;
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const fill = document.createElement('div');
    fill.className = 'bench-progress-fill';
    track.appendChild(fill);
    body.appendChild(track);

    // One table per group of cases: the filters, then the Multiply Const chains.
    // Every cell is addressable by case key, which is all the run loop needs.
    const cells = new Map<string, HTMLTableCellElement>();
    for (const spec of benchmarkTables()) {
      const table = document.createElement('table');
      table.className = 'debug-table bench-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      headRow.appendChild(Object.assign(document.createElement('th'),
        { textContent: spec.columnHeading }));
      for (const item of spec.rows[0].cases) {
        const th = document.createElement('th');
        th.className = 'num';
        th.textContent = item.column;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement('tbody');
      for (const row of spec.rows) {
        const tr = document.createElement('tr');
        tr.appendChild(Object.assign(document.createElement('td'), { textContent: row.label }));
        for (const item of row.cases) {
          const td = document.createElement('td');
          td.className = 'num';
          cells.set(item.key, td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      body.appendChild(table);
    }

    const paint = (key: string) => {
      const cell = cells.get(key);
      if (!cell) return;
      const result = results.get(key);
      cell.classList.remove('bench-busy', 'bench-error');
      if (!result) { cell.textContent = '—'; cell.title = ''; return; }
      if (result.error) {
        cell.textContent = 'failed';
        cell.title = result.error;
        cell.classList.add('bench-error');
      } else {
        cell.textContent = formatRate(result.rate!);
        cell.title = `${Math.round(result.rate!).toLocaleString()} samples/second`;
      }
    };
    for (const key of cells.keys()) paint(key);

    const alive = () => !!overlay && overlay.isConnected && running;

    const runAll = async () => {
      running = true;
      button.disabled = true;
      button.textContent = 'Running…';
      warning.hidden = !isFlowgraphRunning();
      warning.textContent = warning.hidden ? ''
        : 'A flowgraph is running in the QT GUI tab and is competing for CPU — stop it for a clean measurement.';

      const frame = document.createElement('iframe');
      frame.id = 'benchFrame';
      frame.title = 'benchmark runner';
      frame.setAttribute('aria-hidden', 'true');
      // Offscreen rather than display:none: Qt for WebAssembly needs a laid-out
      // canvas to start at all, and a same-origin offscreen frame is not
      // timer-throttled the way a hidden cross-origin one would be.
      frame.style.cssText = 'position:fixed; left:-10000px; top:0; width:420px; height:280px; border:0;';
      document.body.appendChild(frame);
      benchFrame = frame;

      const benchmarks = benchmarkCases();
      // The bar is paced, not polled: booting Qt and the WASM runtime has no
      // progress to report, so each case creeps across its own segment against
      // a nominal case time and snaps forward as the case lands.
      let done = 0;
      let caseStart = Date.now();
      const drawProgress = () => {
        const withinCase = Math.min(0.95, (Date.now() - caseStart) / CASE_ESTIMATE_MS);
        const fraction = Math.min(1, (done + withinCase) / benchmarks.length);
        fill.style.width = `${(fraction * 100).toFixed(1)}%`;
        track.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
      };
      track.hidden = false;
      drawProgress();
      const ticker = window.setInterval(drawProgress, 50);

      const startedAt = Date.now();
      try {
        for (const benchmark of benchmarks) {
          if (!alive()) return;
          caseStart = Date.now();
          results.delete(benchmark.key);
          const cell = cells.get(benchmark.key)!;
          cell.textContent = 'measuring…';
          cell.title = '';
          cell.classList.remove('bench-error');
          cell.classList.add('bench-busy');
          status.textContent = `Measuring ${benchmark.label} at ${benchmark.column} ` +
            `(${done + 1} of ${benchmarks.length})…`;
          try {
            results.set(benchmark.key, { rate: await measureCase(frame, benchmark, alive) });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === 'cancelled') return;
            results.set(benchmark.key, { error: message });
            log(`benchmark: ${benchmark.label} at ${benchmark.column} failed: ${message}`);
          }
          paint(benchmark.key);
          done++;
        }
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        lastRunLabel = `Last run ${new Date().toLocaleTimeString()} (${seconds}s).`;
        status.textContent = lastRunLabel;
        log(`benchmark complete in ${seconds}s: ` + benchmarkTables().flatMap(spec =>
          spec.rows.map(row => `${row.label} ` + row.cases.map(item => {
            const result = results.get(item.key);
            return result?.rate != null ? formatRate(result.rate) : 'failed';
          }).join(' / '))).join('; '));
      } finally {
        running = false;
        window.clearInterval(ticker);
        track.hidden = true;
        fill.style.width = '0%';
        frame.src = 'about:blank';   // unloading the iframe stops its WASM workers
        frame.remove();
        if (benchFrame === frame) benchFrame = null;
        button.disabled = false;
        button.textContent = 'Run Benchmark';
      }
    };

    button.onclick = () => { void runAll(); };
  }, true);

  // Closing the dialog (Close, backdrop, or another dialog replacing it) has to
  // stop the run: `alive()` reads isConnected, and the finally block tears the
  // iframe down on the next poll.
  const observer = new MutationObserver(() => {
    if (overlay && !overlay.isConnected) { running = false; observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true });
}
