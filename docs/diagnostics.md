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
│ ● 1.00× realtime   CPU 38%   mem 214/512 MB   28 fps   thr 3/64        │  ← always visible
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
- **Active pthreads busy vs. pool** (e.g. `3/64`) — pinning at pool size means
  worker starvation
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

1. **Buffer %full under single-mapped `host_buffer`.** We build with
   `-DFORCE_SINGLE_MAPPED`; confirm `input_buffers_full` / `output_buffers_full`
   report fill level as cleanly there as with the stock double-mapped
   `vmcircbuf`. This is the one metric worth verifying is reachable before
   committing to the buffer-occupancy column.
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
4. Buffer-fullness (spike #1) works fine under `FORCE_SINGLE_MAPPED`: the counters
   read `items_available` / `space_available` / `bufsize`, which are
   buffer-implementation-agnostic.

### Findings worth remembering

- **A qtgui GUI sink stalls the graph in headless Chromium** (no real display →
  its `work()` blocks after ~one buffer, back-pressuring the whole flowgraph to a
  halt; realtime → 0). A `null_sink` chain flows continuously at the throttle
  rate. The panel correctly *reports* the stall — that is the tool working, not a
  bug. Headless throughput validation therefore uses a `null_sink` chain.
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
