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
// Two rows are not C++ at all: the same filter written as an Embedded Python
// Block over scipy.signal.fftconvolve, and again as a JavaScript Block, which is
// what makes the C++ numbers mean something in the direction people actually ask
// about. The Python one needs the Python runtime, so those cells report the fetch
// failing on a build without pyodide/ (deps/fetch-pyodide.sh) rather than
// dragging the rest down; the JavaScript one needs nothing at all, which is half
// of what the comparison is about.
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
 * value for most of them keeps the cells comparable with each other. It is also
 * most of what a run costs: two seconds a case, once each case is running —
 * which is why the one row that is slow to *get* running (the Python Block,
 * whose interpreter has to start first) halves it, through `runSeconds`.
 *
 * Declared before the cases because one of them reads it.
 */
const MIN_RUN_SECONDS = 2;

interface FilterCase {
  key: string;
  label: string;
  id: string;
  /** The .grc parameters for the device under test, at `taps` taps. */
  params: (taps: number) => Record<string, string>;
  /** Overrides MIN_RUN_SECONDS for this row; see the Python row below. */
  runSeconds?: number;
}

/**
 * The Embedded Python Block's row: the same FIR filter, convolved by scipy.
 *
 * It answers the question the other two rows raise on their own — what does it
 * cost to write the filter in Python instead? — with everything else held
 * fixed: same Null Source, same tap count, an FFT convolution either way. What
 * differs is the whole Python path, and all of it is in the measurement: the
 * hop to the Pyodide worker and back on every work() call, the copy of the
 * input into Pyodide's separate WebAssembly memory and of the result back out
 * (two memories cannot alias, so upstream's zero-copy view is not available
 * here), and scipy's own FFT against gr-fft's.
 *
 * `set_history(ntaps)` is what makes `mode='valid'` yield exactly
 * `noutput_items` samples: GNU Radio then hands work() the ntaps-1 samples of
 * overlap the C++ FIR filters get from their own history. Taps are a constant
 * for the same reason as above — their values cost nothing either way.
 */
const SCIPY_FIR_SOURCE = `import numpy as np
from scipy.signal import fftconvolve
from gnuradio import gr


class blk(gr.sync_block):
    """A FIR filter convolved by scipy, for comparison with the C++ filters"""

    def __init__(self, ntaps=101):
        gr.sync_block.__init__(self, name='scipy fftconvolve',
                               in_sig=[np.complex64], out_sig=[np.complex64])
        self.taps = np.full(ntaps, 1e-4, dtype=np.float32)
        self.set_history(ntaps)

    def work(self, input_items, output_items):
        n = len(output_items[0])
        output_items[0][:] = fftconvolve(input_items[0], self.taps, mode='valid')[:n]
        return n
`;

/**
 * The JavaScript Block's row: the same FIR filter, convolved in JavaScript.
 *
 * The comparison with the row above it is the point. Both are the user's own
 * work() in a scripting language; what differs is everything around it. The
 * Python block hops to a Pyodide worker and back on every call and copies the
 * input and the output between two WebAssembly memories, because two memories
 * cannot alias. The JavaScript block's work() is a synchronous call on the
 * block's own scheduler thread, reading and writing GNU Radio's buffers through
 * typed-array views -- nothing copied, nothing proxied. So this row measures a
 * plain time-domain convolution in a JIT against gr-fft's C++, with no runtime
 * overhead worth the name in between.
 *
 * A direct convolution rather than an FFT one, deliberately: JavaScript has no
 * FFT in the standard library, and shipping one here would measure that
 * implementation rather than the block. It is O(ntaps) per sample, so at 10001
 * taps this row is honestly, visibly slow -- which is itself the answer to "can
 * I just write my filter in JavaScript?".
 *
 * `history: ntaps` is what gives work() the ntaps-1 samples of overlap the C++
 * FIR filters get from their own history, exactly as set_history() does above.
 */
const JS_FIR_SOURCE = `gr.export({
  label: 'JS FIR filter',
  inputs: ['complex'],
  outputs: ['complex'],
  params: { ntaps: 101 },
  history: NTAPS,
  start() {
    // Per-instance, in start(): this file is evaluated once per thread, so a
    // top-level array would be shared and rebuilt in ways a block cannot see.
    this.taps = new Float32Array(NTAPS).fill(1e-4);
  },
  work(nout, input, output) {
    const x = input[0], y = output[0], taps = this.taps, n = taps.length;
    for (let i = 0; i < nout; i++) {
      let re = 0, im = 0;
      // input[] carries history's overlap ahead of the current sample, so the
      // window is [i, i + n) with no bounds check needed.
      for (let k = 0; k < n; k++) {
        const t = taps[k], base = (i + k) * 2;
        re += x[base] * t;
        im += x[base + 1] * t;
      }
      y[i * 2] = re;
      y[i * 2 + 1] = im;
    }
    return nout;
  },
});
`;

// Every filter is complex in, complex out, real taps, decimation 1. Tap *values*
// do not affect the cost of any of them, so they are short constants that keep
// the URL small at 10001 taps.
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
  {
    key: 'scipy',
    label: 'Null Source -> Python Block (scipy.signal.fftconvolve) -> Null Sink',
    id: 'epy_block',
    // JSON is a subset of YAML's double-quoted scalar, so stringify emits the
    // source as the one escaped line the runner's YAML reader wants -- the same
    // form the editor's own .grc writer produces for it.
    params: taps => ({ _source_code: JSON.stringify(SCIPY_FIR_SOURCE), ntaps: quoted(String(taps)) }),
    // Half the samples of the other rows: this is the slowest row to get
    // through, and it is a three-block chain, which MIN_RUN_SECONDS says is
    // within a few percent of its sustained rate well before a second.
    runSeconds: MIN_RUN_SECONDS / 2,
  },
  {
    key: 'js',
    label: 'Null Source -> JS Block (direct convolution) -> Null Sink',
    id: 'wasm_js_block',
    // `history` has to be a literal in the source: it is read from the
    // descriptor on the main thread, before any parameter is applied, because GR
    // sizes buffers from it at construction. Substituting it here is what lets
    // one source serve all three tap counts.
    params: taps => ({
      _source_code: JSON.stringify(JS_FIR_SOURCE.replace(/NTAPS/g, String(taps))),
    }),
  },
];

const POLL_MS = 40;
/** Nominal cost of one case, used to pace the progress bar (not a timeout). */
const CASE_ESTIMATE_MS = 3200;
/**
 * Ceiling on Qt + WASM startup plus the flowgraph producing its first samples.
 * Generous on purpose: the longest chain prewarms a 40-worker pool and takes
 * ~3.5s to first sample here, and a slower machine must not trip the timeout
 * and report a case that was merely still starting. The Python row raises the
 * ceiling again — on a cold cache it fetches the interpreter and scipy, ~30 MB,
 * before its flowgraph starts.
 *
 * That fetch does not distort the rates. Both come from the runner's own
 * `uptime_s`, which starts at `tb->run()` — and the Python Block's interpreter
 * is loaded before that, in the prepare step, because a block's io signature
 * has to be known before GR can size its buffers.
 */
const START_TIMEOUT_MS = 180000;

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
// arithmetic here, because GNU Radio runs one thread per block: 30 blocks plus
// the source and sink is 33 threads, which both oversubscribes a typical CPU
// and sets the runner's prewarmed worker pool (40 workers, ~3.5s of boot). It
// used to be far worse — the pool ladder jumped 32 -> 256 and this case spent
// ~28s spawning workers before its first sample, which is what prompted
// rounding both copies of the ladder to multiples of 8. That whole cost is what
// the single-threaded group below measures against: same lengths, same
// flowgraphs, one worker.
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

export interface BenchmarkCase {
  key: string; column: string; grc: string;
  /** Seconds of flowgraph uptime to measure over; MIN_RUN_SECONDS if absent. */
  runSeconds?: number;
  /**
   * Which scheduler the runner should use, as `runner.html?scheduler=` spells
   * it (see docs/schedulers.md). Absent means the default, thread-per-block.
   * The query is used rather than the flowgraph's own Options block because
   * these .grc are handed straight to runner.html, and because it keeps the two
   * chain groups measuring a byte-identical flowgraph.
   */
  scheduler?: string;
}
export interface BenchmarkTable {
  /** `columnHeading` doubles as the group's label: it heads the first column. */
  key: string; columnHeading: string;
  rows: { key: string; label: string; cases: BenchmarkCase[] }[];
}

/**
 * Every case a run measures, grouped the way the dialog tabulates it. Filters
 * first, then the Multiply Const chains on each scheduler; a run walks them in
 * this order, one flowgraph at a time.
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
          runSeconds: filter.runSeconds,
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
    // The same flowgraphs, byte for byte, on the single-threaded scheduler --
    // which is why the group above is the one worth pairing: its cost is length
    // rather than arithmetic, and length is exactly what thread-per-block turns
    // into workers. Read the two "with startup" columns against each other for
    // what the pool costs, and the two "without startup" columns for what one
    // thread costs a warm graph. Nothing in this chain waits inside work(), so
    // the scheduler's one disqualifying limitation does not apply here; see
    // docs/schedulers.md before pairing any other group this way.
    {
      key: 'chain-sts', columnHeading: 'Long Chain of Blocks (single-threaded scheduler)',
      rows: [{
        key: 'mult-sts',
        label: 'Null Source -> N x Multiply Const -> Null Sink',
        cases: CHAIN_LENGTHS.map(count => ({
          key: `mult-sts:${count}`,
          column: `${count} blocks`,
          grc: multiplyChainFlowgraph(count),
          scheduler: 'sts',
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

/** The two rates one run yields, in samples/second. */
export interface CaseRates {
  /** Samples since the flowgraph started, over seconds since it started. */
  withStartup: number;
  /** Samples between two warm snapshots, over the seconds between them. */
  withoutStartup: number;
}

/**
 * Run one case on its own and return both of its rates.
 *
 * A single run answers both questions, because the two differ only in which
 * snapshots they divide:
 *
 *   with startup — one snapshot: `items / uptime_s`, where `uptime_s` runs
 *     from `tb->run()`. The divisor covers thread creation and filling every
 *     buffer in the chain. What someone waiting on a flowgraph experiences.
 *   without startup — two snapshots differenced, the first taken once the
 *     graph is already warm. The sustained rate of a running graph.
 *
 * Taking both from one run is not just cheaper, it is the only fair
 * comparison: on a laptop, two runs 30s apart differ by more than the metrics
 * do, enough to reverse the sign of the difference.
 */
async function measureCase(
  frame: HTMLIFrameElement, benchmark: BenchmarkCase, alive: () => boolean,
): Promise<CaseRates> {
  // A hash-only change does not reload a document, so the query string carries
  // the case: without it every case after the first would re-measure the first.
  // It doubles as the identity every read below is checked against.
  const search = `?benchmark=${encodeURIComponent(benchmark.key)}` +
    (benchmark.scheduler ? `&scheduler=${encodeURIComponent(benchmark.scheduler)}` : '');
  frame.src = `/runner/build/runner.html${search}#${encodeURIComponent(benchmark.grc)}`;

  const deadline = Date.now() + START_TIMEOUT_MS;
  /** Poll until the case's own document reports a snapshot passing `ready`. */
  const readUntil = async (ready: (reading: Reading) => boolean): Promise<Reading> => {
    for (;;) {
      await sleep(POLL_MS);
      if (!alive()) throw new Error('cancelled');
      const failure = readRunnerFailure(frame, search);
      if (failure) throw new Error(failure);
      const reading = readSnapshot(frame, search);
      if (reading && reading.items > 0 && ready(reading)) return reading;
      if (Date.now() > deadline) throw new Error('the flowgraph produced no samples');
    }
  };

  // Halfway is late enough to be past the fill: even the longest chain here has
  // its last block producing within ~0.3s of uptime.
  const runSeconds = benchmark.runSeconds ?? MIN_RUN_SECONDS;
  const first = await readUntil(r => r.seconds >= runSeconds / 2);
  const last = await readUntil(r => r.seconds >= runSeconds && r.seconds > first.seconds);
  return {
    withStartup: last.items / last.seconds,
    withoutStartup: (last.items - first.items) / (last.seconds - first.seconds),
  };
}

function formatRate(samplesPerSecond: number): string {
  return `${(samplesPerSecond / 1e6).toPrecision(3)} MS/s`;
}

// Results survive closing the dialog, so reopening it shows the last run rather
// than an empty matrix. Keyed by case key; one run fills both rates.
const results = new Map<string, { rates?: CaseRates; error?: string }>();
let lastRunLabel = '';

/** Which of the two rates the matrix is currently showing. */
type RateView = keyof CaseRates;
// `hint` is the tab's hover title only — the matrix speaks for itself, so
// nothing explains the difference in the dialog body.
const VIEWS: { key: RateView; label: string; hint: string }[] = [
  { key: 'withStartup', label: 'With startup',
    hint: 'Samples since the flowgraph started, over seconds since it started: ' +
      'creating a thread per block and filling every buffer counts against the rate.' },
  { key: 'withoutStartup', label: 'Without startup',
    hint: 'Two readings taken once the flowgraph is warm, differenced: the sustained ' +
      'rate of a running graph.' },
];
// Both views come from the same run, so this only picks what is on screen —
// switching costs nothing and re-measures nothing.
let activeView: RateView = 'withStartup';

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
      'long it ran. Results are shown with and without including startup overhead. ' +
      'The Python Block row runs the same filter in Python, and downloads the Python ' +
      'runtime the first time — so a run takes a while longer than the others.';
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

    // The two rates share one set of tables: a run fills both, so switching tabs
    // only repaints. Building the matrix twice would just be two states to keep
    // in step, including the 'measuring...' one.
    const tabs = document.createElement('div');
    tabs.className = 'bench-tabs';
    tabs.setAttribute('role', 'tablist');
    const tabButtons = new Map<RateView, HTMLButtonElement>();
    for (const view of VIEWS) {
      const tab = document.createElement('button');
      tab.className = 'bench-tab';
      tab.type = 'button';
      tab.textContent = view.label;
      tab.title = view.hint;
      tab.setAttribute('role', 'tab');
      tab.onclick = () => selectView(view.key);
      tabButtons.set(view.key, tab);
      tabs.appendChild(tab);
    }
    body.appendChild(tabs);

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
        const rates = result.rates!;
        const rate = rates[activeView];
        cell.textContent = formatRate(rate);
        // The other rate is one hover away, which is where the comparison is
        // actually worth making: same run, same machine, same instant.
        cell.title = `${Math.round(rate).toLocaleString()} samples/second\n` +
          VIEWS.map(view => `${view.label}: ${formatRate(rates[view.key])}`).join('\n');
      }
    };

    function selectView(view: RateView) {
      activeView = view;
      for (const [key, tab] of tabButtons) {
        const on = key === view;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', String(on));
      }
      for (const key of cells.keys()) paint(key);
    }
    selectView(activeView);

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
          status.textContent = `Measuring... ` +
            `(${done + 1} of ${benchmarks.length})…`;
          try {
            results.set(benchmark.key, { rates: await measureCase(frame, benchmark, alive) });
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
        lastRunLabel = `Last run took ${seconds}s.`;
        status.textContent = lastRunLabel;
        log(`benchmark complete in ${seconds}s`);
        // Both rates reach the console, since only one of them is on screen.
        for (const view of VIEWS)
          log(`  ${view.label.toLowerCase()}: ` + benchmarkTables().flatMap(spec =>
            spec.rows.map(row => `${row.label} ` + row.cases.map(item => {
              const result = results.get(item.key);
              return result?.rates ? formatRate(result.rates[view.key]) : 'failed';
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
