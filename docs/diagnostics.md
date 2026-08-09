# Runner diagnostics panel — design note

Status: **implemented** — see [runner/src/diag.js](../runner/src/diag.js) (panel) and
`build_stats_json()` / `publish_stats()` in [runner/src/runner.cpp](../runner/src/runner.cpp).

A pinned, collapsible diagnostics bar at the bottom of the **runner** page (the
one hosting the live plots / canvas) that shows CPU, memory, and how well the
flowgraph is "keeping up" — plus per-block drill-down for finding bottlenecks.

## Goals / non-goals

- **Goal:** answer "is it keeping up, and if not, which block is the problem?"
  at a glance, with drill-down when you want it.
- **Goal:** near-zero cost — collection reads atomics only, runs off the DSP
  threads, stays under ~1% CPU, and is toggleable.
- **Non-goal (for v1):** history persistence, export, or per-edge tag counts.

## Data sources (three)

The panel is an **HTML/JS overlay**, not a Qt widget, fed by a cheap poll so it
never competes with the scheduler threads.

1. **Browser / JS** — read directly in the panel (`navigator.*`,
   `performance.*`, `requestAnimationFrame`).
2. **Emscripten runtime** — `Module.HEAP8.byteLength`, thread-pool state.
3. **GNU Radio scheduler** — a new exported C function `gr_stats_json()` that
   snapshots counters and returns a JSON string, polled at ~3 Hz from the panel.

### Decision: build with `ENABLE_PERFORMANCE_COUNTERS`

The runner (and the GR runtime it links) will be built with GR's
**`ENABLE_PERFORMANCE_COUNTERS`** flag. The per-block "keeping up" numbers map
1:1 onto the counters GR already maintains under that flag, so we reuse them
rather than reinventing:

| panel metric        | GR performance counter        |
|---------------------|-------------------------------|
| avg work() time     | `work_time` / `work_time_avg` |
| input buffer %full  | `input_buffers_full`          |
| output buffer %full | `output_buffers_full`         |
| items produced      | `nproduced`                   |

`gr_stats_json()` walks the flowgraph's blocks, reads these counters, and emits
the JSON the panel renders. Poll rate 3 Hz, 60 s rolling history for sparklines.

## The two metrics that answer "is it keeping up?"

Everything else is diagnosis; these two are the verdict:

- **Realtime factor** = (items/sec actually flowing at a reference point, e.g. a
  sink input) ÷ (configured `samp_rate`). `1.0` = keeping up, `<1.0` = falling
  behind, `>1.0` = running ahead of a throttle. This is the headline gauge.
- **Buffer occupancy** (per block, from the counters above). The pattern says
  *why*:
  - buffers full **upstream** of a block → that block is the bottleneck
  - buffers empty everywhere → source/throttle-limited (CPU has headroom)
  - a `throttle` that's the limiter vs. CPU saturation → tells you whether the
    graph *could* go faster

## Layout

Collapsed = one glanceable status line; expanded = per-block table + sparklines.
Color (green / amber / red) keys off the realtime factor and the fullest buffer,
so the bottleneck lights up without reading numbers.

```
┌─ diagnostics ──────────────────────────────────────────── [▲ expand] ─┐
│ ● realtime 1.00×  cpu 38%  tier 32 +0 extra  active workers 25         │  ← always visible
│   bottleneck: qtgui_time_sink ▓                                        │
├───────────────────────────────────────────────────────────────────────┤
│ block            work µs  CPU%  in▓full out▓full  items/s   ▁▂▃▅▇  ▐   │  ← expanded
│ sig_source_c        2.1    4%     —      12%      1.02 M   ▁▁▂▁▁       │
│ multiply_cc         5.8   11%    8%      31%      1.02 M   ▂▃▂▃▂       │
│ complex_to_mag      3.0    6%    5%      44%      1.02 M   ▂▂▃▂▂       │
│ qtgui_time_sink    19.4   61%   88%       —       0.98 M   ▅▇▆▇▅  ⚠    │  ← red row
└───────────────────────────────────────────────────────────────────────┘
```

## Metric set, by tier

### Host / browser (JS)
- Logical cores `navigator.hardwareConcurrency`; coarse device RAM `navigator.deviceMemory`
- JS heap used / limit (`performance.memory`, Chrome only)
- Page render **FPS** (rAF delta)
- Main-thread **jank** — `PerformanceObserver('longtask')` count/sec (catches the
  UI thread stalling even when DSP is fine)

### WASM runtime (Emscripten)
- Linear memory current (`HEAP8.byteLength`), **peak**, and growth-event count
  (memory growth is expensive — worth surfacing)
- Optional `mallinfo` in-use vs. arena
- **Active pool tier and DSP thread count** (e.g. `tier 32 +0 extra`, `dsp
  threads 24`) —
  the tier makes the runner's prewarmed capacity explicit, while a DSP count
  approaching it warns of worker starvation
- **Dynamically-created and active workers** (e.g. `tier 256 +2 extra`, `active
  workers 257`) — the extra count is cumulative for the life of the runner,
  while active is the number of Emscripten pthread workers currently assigned
- Flowgraph uptime

### Scheduler / DSP — the "keeping up" core
- **Realtime factor** (headline) + throttle-limited vs. CPU-limited flag
- Aggregate throughput (items/sec) at the sink reference
- **Per-block:** avg `work()` time (µs), **CPU share %**, work-call rate, avg
  `noutput_items`/call, input/output buffer %full, `nproduced`
- **Bottleneck attribution** — one derived field: block with max downstream-full
  or max CPU share
- Sink **underruns / late frames** (dropped qtgui updates)

### GUI / render
- qtgui sink actual update rate vs. requested
- Canvas frame render time

## Open technical unknowns to spike before building

1. **Buffer %full under the WASM buffer backend.** Confirm
   `input_buffers_full` / `output_buffers_full` report fill level as cleanly with
   the software-emulated double-mapped buffer as with a native `vmcircbuf`.
2. **Overhead of `ENABLE_PERFORMANCE_COUNTERS`** in the WASM build — measure the
   per-`work()` cost; if material, gate collection behind the panel's on/off.
3. **`gr_stats_json()` snapshot safety** — reads must be lock-free atomics so the
   3 Hz poll never stalls a DSP thread.

## Implementation notes (as built)

1. `GR_PERFORMANCE_COUNTERS` was already defined in the existing `build-gr`
   config (GR default `ON`), so the counters are compiled into the runtime `.a`
   — **no GR rebuild**. Only the runtime pref had to be flipped:
   `gr::prefs::singleton()->set_bool("PerfCounters", "on", true)` before `run()`.
2. **Data flow is push, not pull.** Qt's WASM build overrides Emscripten's
   `EXPORTED_RUNTIME_METHODS`, so `ccall`/`cwrap` are unavailable and — worse —
   *touching any non-exported `Module.*` symbol (`Module.PThread`, `Module.HEAP8`)
   aborts the whole runtime*. So all metrics are gathered C++-side (including
   `emscripten_get_heap_size()` and the thread count) and pushed to
   `window.__grstats` by a main-thread `QTimer` (3 Hz) via `EM_ASM`. The panel
   never calls into C or reads `Module`.
3. The panel JS is linked with `--post-js`, which is also bundled into every
   pthread worker; it early-returns unless it is on the main thread with a DOM
   (`importScripts`/`document`/`window` guard) — otherwise a worker touching
   `document` aborts the runtime.
4. Buffer-fullness (spike #1) is buffer-implementation-agnostic: the counters read
   `items_available` / `space_available` / `bufsize`.
5. Worker-pool counts come from Emscripten's closure-local `PThread` object in
   `diag.js` (never the unavailable `Module.PThread`). The panel snapshots the
   prewarmed arrays on its first tick, then wraps `allocateUnusedWorker()` so
   `additionalCreated` remains cumulative even after an extra worker returns to
   the unused pool. The toolchain is pinned, and the smoke test guards this
   internal integration.
6. `runner.html` selects the smallest prewarmed tier in **8 / 16 / 32 / 256** that
   fits the top-level flowgraph block count plus one scheduler-launch worker.
   The choice happens before the modularized Emscripten runtime starts, because
   `PTHREAD_POOL_SIZE` is evaluated during module initialization. Top-level
   variables make the estimate conservative; hierarchy expansion can require
   extra workers, which the separate `+N extra` counter exposes.
7. Before scheduler startup, the runner flattens the fully constructed graph and
   calls the same `calc_used_blocks()` used by GNU Radio's thread-per-block
   scheduler. If hierarchy expansion crosses a tier boundary, the missing
   workers are allocated and initialized before `tb->run()`. The exact count and
   any corrective preload are written to the editor console; the same exact
   count drives the headline's `dsp threads` value.

### Findings worth remembering

- **A throttle's `work()` sleeps to pace the graph, and that sleep lands in its
  work-time counter** (~128 ms/call), so its raw "cpu" is meaningless. The panel
  excludes any `*throttle*` block from CPU-sum and bottleneck attribution and
  shows `sleep`/`·` in its row.
- Sources (incl. throttle) produce in bursts larger than one 333 ms poll, so
  single-poll item diffs alias (a `▁█▁█` sparkline). The panel smooths
  throughput/CPU over a ~2 s (6-sample) window.

Verified headless: a `src → multiply_const → throttle → null_sink` graph reports
`realtime 0.92×`, correct per-block throughput (~29.5k/s at samp_rate 32k),
`sleep` for the throttle, `bottleneck none`, and smooth sparklines.

## Second consumer: the Benchmark Tool

Help ▸ Benchmark Tool ([`editor/src/benchmark.ts`](../editor/src/benchmark.ts))
reads the same `window.__grstats` snapshot, for a different question: not "is
this flowgraph keeping up?" but "how fast is this machine?". It fills a
six-cell matrix — Decimating FIR and FFT Filter, complex in/out with real taps,
at 101, 1001 and 10001 taps.

- **One case per flowgraph, run one at a time.** Each cell is its own Null
  Source → filter → Null Sink `.grc`, loaded into a private offscreen runner
  iframe, so the filter under test has the machine to itself. Null Source keeps
  the samples at zero, the one input that can never drag a float path into
  denormals. `grc.test.mjs` parses all six, because they are hand-written text
  going straight to the runner.
- **The rate is end-to-end**: the block's `items` divided by the snapshot's own
  `uptime_s`, both from a single snapshot. `uptime_s` runs from the instant
  `start_prepared_flowgraph()` launched `tb->run()`, so the divisor covers graph
  start-up and every per-sample cost in the chain — the source and the sink as
  much as the filter kernel. It is *not* the per-block work timer: that one
  (`work_total_s`, what the debug panel uses) excludes waiting, and under
  Emscripten it is not CPU time either, because GR only reaches for
  `CLOCK_THREAD_CPUTIME_ID` on the `__linux__` branch of `high_res_timer.h`,
  which this toolchain does not define.
- **A reading is taken at the first snapshot past `MIN_RUN_SECONDS`** (0.25 s;
  counters publish at ~3 Hz, so it lands in 0.25–0.6 s). Whatever its arrival
  time, that snapshot's own uptime is the divisor, so arrival costs accuracy
  only through how much start-up ramp is still in the average. On a warm machine
  the first snapshot is within ~5% of where the rate settles after two seconds;
  on a heat-soaked laptop the ramp is much longer and short runs read low.
- **Every read is checked against the case's own document.** `frame.src` does
  not navigate synchronously, so for a moment after it is set the *previous*
  case's document is still there with its `__grstats` and its `#result` on it —
  a reading that passes every sanity check while belonging to the wrong filter.
  Both reads compare `contentWindow.location.search` against the
  `?benchmark=<case>` this navigation used. That query also exists because a
  hash-only change does not reload a document at all.
- The iframe is offscreen rather than `display:none`, because Qt for
  WebAssembly needs a laid-out canvas to start at all. It is torn down when the
  run finishes or the dialog closes, which is also what cancels a run in
  progress.
- Its runner posts the usual `gr-error`/`gr-print`/`gr-module` messages to the
  parent, so `main.ts` filters them out by frame (`isBenchmarkFrameSource`) —
  otherwise a benchmark case would flip the editor's Run status.
- The progress bar is **paced, not polled**: booting Qt and the WASM runtime has
  no progress to report, so each case creeps across its own sixth of the bar
  against a nominal case time and snaps forward as the case lands.

A run costs about 8–10 s, and start-up dominates it: ~1.1 s of Qt + WASM boot
per case against ~0.3–0.6 s of measurement. Six isolated runs cannot be much
faster without giving up the isolation — batching a whole row into one flowgraph
does fit in ~3 s, but the chains then share the machine, which read the FIR row
~20% low on a 2 P-core + 8 E-core laptop and all six together ~40% low.

Worth knowing when reading results: absolute numbers track machine state
heavily. On this laptop the same filter measured 12.3 MS/s early in a session
and 3.8 MS/s after an hour of repeated benchmarking, recovering after an idle
period — CPU power and thermal behavior, not leaked workers (iframe teardown
was checked). The dialog says so.
