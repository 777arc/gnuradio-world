# Swapping the flowgraph scheduler

GNU Radio's scheduler is **not** patched here. There is no `__EMSCRIPTEN__` guard
anywhere in `gnuradio-runtime/lib/scheduler_tpb.cc`, `block_executor.cc`,
`tpb_thread_body.cc` or `flat_flowgraph.cc`, and the default is stock upstream
thread-per-block: one thread per primitive block, the same forecast /
`general_work` / `produce` / `consume` loop, the same tag and history semantics.
Everything below is about running a *different* scheduler over that same
unmodified machinery, and none of it touches the submodule.

## Why the runner picks the scheduler itself

Upstream already has a selection mechanism — `scheduler_list` plus the
`GR_SCHEDULER` environment variable, in `top_block_impl.cc`. Neither half fits:

- the list is a file-static with no registration API, so adding to it means
  patching the submodule;
- the chosen factory is cached in a function-local `static` that is resolved once
  and never re-read. One tab runs many flowgraphs, so a per-process choice is the
  wrong shape.

So `runner.cpp` never calls `top_block::start()`/`run()`. `start_prepared_flowgraph()`
does what `top_block_impl::start()` does — `flatten()`, `validate()`,
`setup_connections()`, make a scheduler — and picks the scheduler itself:

```cpp
g_ffg  = g_tb->flatten();
g_ffg->validate();
g_ffg->setup_connections();
g_sched = g_plugin->make(g_ffg, 100000000, /*catch_exceptions=*/true);
```

This works with no submodule change because `runner/CMakeLists.txt` already puts
`${GR}/gnuradio-runtime/lib` on the runner's private include path and
whole-archives `libgnuradio-runtime.a`. `gr::scheduler`, `gr::block_executor`,
`gr::tpb_detail` and `gr::flat_flowgraph` are therefore reachable, headers *and*
symbols.

**Consequences to keep in mind.** `top_block::start/stop/wait/run` are never used
and `d_state` stays `IDLE`, so calling any of them does nothing. Every lifecycle
call goes to `g_sched` instead, at four sites in `runner.cpp`: the start above,
`gr_shutdown_flowgraph()` (signal only — it must never join, see
[recording-viewer.md](recording-viewer.md)), `run_now()`'s teardown (which *does*
join, before the new graph takes the old buffers), and the worker-pool sizing.
`g_ffg` has to outlive `g_sched`, because the scheduler holds a reference to the
flat graph. One thing this buys: `validate()` now runs inside `run_now()`'s
try/catch, so an invalid graph reports `RUNNER_FAIL: <message>` instead of
throwing out of a detached thread with nothing to catch it.

## The plugin table

[`runner/src/schedulers.hpp`](../runner/src/schedulers.hpp), header-only:

```cpp
struct plugin {
    const char* name;            // "tpb", "sts", "det" — what a .grc and a URL name
    const char* label;           // what the console calls it
    gr::scheduler_sptr (*make)(gr::flat_flowgraph_sptr, int, bool);
    int (*thread_estimate)(int nblocks);
    bool deterministic;          // the same flowgraph gives the same run
};
```

`runner_sched::plugins()` is the whole registry; the **first entry is the
default**, and `select()` falls back to it for an unknown name rather than
failing the run, so a `.grc` written against a newer build still works.

`thread_estimate()` exists because the prewarmed Web Worker pool has to be sized
before the graph is built. It used to be hardcoded to TPB's shape
(`calc_used_blocks().size() + 1`). `deterministic` only drives a warning, but it
is on the plugin rather than a name comparison so a future scheduler gets the
same treatment for free.

### Adding one

1. Write a `gr::scheduler` subclass in `schedulers.hpp` (or a new header beside
   it). Reuse `gr::block_executor` — that is the block-running half, and it is
   public API; what a scheduler contributes is *policy*: which block runs when,
   on which thread, and what happens when one blocks.
2. Wrap every thread body in `gr::thread::thread_body_wrapper`. It is what
   catches an exception out of a block's `work()` and logs it, which
   `BrowserLogSink` mirrors into the editor console. Without it a throwing block
   looks like a graph that simply produces nothing.
3. Add a row to `plugins()`.
4. Add the name to the Options dropdown in `editor/src/block-defs.ts`, to
   `schedulerThreadCount()` in `runner/src/runner.html`, and to its mirror in
   `expectedPoolTier()` in `test/test_smoke.mjs` — the three have to agree on how
   many threads the scheduler makes, or the pre-start top-up re-inflates a pool
   the earlier stage had just sized correctly. `editor/test/grc.test.mjs` asserts
   the dropdown and the plugin table list the same names, and will fail until you
   do the first of these.

Nothing else has a list to update: `gen_registry.py` is not involved, and there
is no generated artifact behind any of this.

## Choosing one

Two places, in this precedence order:

1. **`runner.html?scheduler=<name>`** — wins. `?rounds=<n>` rides alongside it
   for the deterministic scheduler. This is how a headless harness
   picks one, because `scripts/run.mjs` and `test/test_smoke.mjs` hand a `.grc`
   straight to `runner.html` and have nowhere else to say it. The editor forwards
   its *own* `?scheduler=` onto the runner frame (`run-session.ts`), so
   `localhost:8090/?scheduler=sts` drives the whole app without editing a
   flowgraph.
2. **The Options block's `scheduler` parameter**, saved in the `.grc`.
   `grc_lower::scheduler_of()` reads it from the top-level `options:` key or from
   an `options` entry under `blocks:`, and `lower()` puts it in the lowered JSON
   as `"scheduler"`. Every other part of the options block is still dropped.

### The default is deliberately not written to the `.grc`

`grcParams()` serializes *every* Options parameter, so writing `scheduler: tpb`
out would add a key to every `.grc` in the repository and to every file a user
has ever saved. `buildGrcDoc()` in `editor/src/main.ts` therefore skips the
parameter when it equals `SCHEDULER_DEFAULT`. Three constants have to name the
same scheduler — that constant, the schema `def` in `block-defs.ts`, and the
first entry of `plugins()` — and `editor/test/grc.test.mjs` checks all three
against each other and against every committed example.

### What native GRC does with the key

It loads it **silently, with no error**: `Block.import_data()`
(`grc/core/blocks/block.py`) does `try: self.params[key].set_value(value)` /
`except KeyError: continue`, documented as *"Any param keys that do not exist
will be ignored."* The options block additionally runs `insert_grc_parameters()`,
which only reads keys it names. Nothing validates or warns.

The one cost: `export_data()` rebuilds `parameters` from `self.params` only, so
**a native-GRC round-trip silently drops the key**. Open the file in GRC, save,
and the scheduler choice is gone. That is strictly gentler than the browser-only
`gui_layout` *block*, which native GRC turns into a visible `_dummy` error block
on the canvas.

## The single-threaded scheduler (`sts`)

`sts` and `det` are one loop with different policy — `detail::round_robin_body`
and its `round_robin_config` (chunk size, round budget, idle backoff). Adding a
third variant of the same shape means another config, not another loop.

One thread runs every block's `block_executor::run_one_iteration()` in a
round-robin over the topologically sorted block list. It is a policy variant of
`tpb_thread_body.cc` — the message pump, the state handling and the neighbour
notifications are the same logic — and the only real difference is what happens
on `BLKD_IN` / `BLKD_OUT`: TPB waits on the block's condition variable, this
moves on to the next block. A full round with no progress backs off ~200 µs so an
input-starved graph does not spin a core.

The point is worker count. Every GNU Radio thread here is a Web Worker costing
50–100 ms to spawn plus real memory, so a 22-block flowgraph on TPB prewarms a
tier of 32 before its first sample; on `sts` it prewarms 8 and uses 2.

### It cannot run a block that blocks inside `work()`

This is the whole trade, and it is silent when you hit it: the graph starts, the
console says nothing, and everything simply stops producing.

Several blocks here own their scheduler thread by design and wait on a futex or a
condition variable inside `work()` — Audio Sink and Audio Source, the four blocks
that read a file, SigMF Sink, the RTL-SDR / PlutoSDR / HackRF sources and sinks,
and the Embedded Python Block. On `sts` that one wait stalls every other block on
the thread. A throttle is a milder version of the same thing: its ~128 ms sleep
pauses the whole graph rather than just itself.

`runner_sched::blocks_in_work()` lists them, and `run_now()` posts an error to the
editor console naming the offending block ids when a single-threaded scheduler is
chosen for such a graph. It warns rather than refusing — which of them actually
blocks depends on whether the browser granted the device. **Keep that list in
step** with the blocks whose `work()` waits: `browser_audio.cpp`,
`browser_file_source.cpp`, `browser_file_sink.cpp`, `rtlsdr_source.cpp`,
`plutosdr_common.cpp`, `hackrf_common.cpp` and `python_block.hpp`.

JS blocks are *not* on the list. Their `work()` is synchronous JavaScript on the
block's own thread and returns; it does not wait. A JS `work()` that never
returns wedges `sts` completely rather than just its own thread, but that already
wedges the thread until the tab is reloaded either way — see
[js-blocks.md](js-blocks.md).

A JavaScript exception has the same boundary whether it came from `work()` or a
message handler: the JS entry point writes the stack into C++'s error buffer and
the block throws `std::runtime_error`. Under TPB, `thread_body_wrapper` contains
one block, so that block's thread ends and the rest of the graph may limp on.
Under STS and deterministic scheduling, the wrapper contains the whole shared
round-robin loop, so either callback ends the entire scheduler thread. The
asymmetry is between schedulers, not between callback kinds; the JS browser test
covers a throwing handler under both.

## The deterministic scheduler (`det`)

The same single thread and the same fixed round-robin as `sts`, plus the two
things that make a run repeat itself:

- **A constant chunk size.** Every `work()` call is capped at 4096 items,
  overriding both the graph-wide `max_noutput_items` and any block's own
  `set_max_noutput_items()`. Call boundaries then stop depending on what the
  buffer allocator happened to do — vmcircbuf granularity, `minoutbuf` rounding —
  which is what otherwise moves tag positions and filter-state alignment between
  runs.
- **A round budget.** The run ends after a fixed number of complete passes over
  the block list, not after some wall-clock duration. This is the part that
  actually makes two runs comparable: without it you are diffing two graphs
  sampled at arbitrary moments. The idle backoff is off for the same reason — a
  sleep would let elapsed time decide how much work a run gets through.

A run therefore produces an exact, predictable item count: `rounds × 4096` per
block. The default budget is 1000 rounds, and there is no budget that suits every
graph — 1000 rounds is well under a second for a chain of Multiply Const and far
too much for a 10001-tap FIR — so it is a knob rather than a constant to tune:

```
runner.html?scheduler=det&rounds=250
```

**The graph stops when the budget runs out**, and nothing announces it. The
scheduler thread cannot post to the editor: `window` does not exist on a pthread,
and the proxying `MAIN_THREAD_EM_ASM` form would deadlock against `run_now()`'s
teardown, which joins that thread from the browser main thread. Frozen item
counters are the signal, and they are the point.

### What voids the guarantee

Two kinds of block, and the runner names them in the editor console when you pick
this scheduler:

- **A throttle** (`wall_clock_block()`) paces itself by elapsed time, so in a
  fixed number of rounds it produces however much the clock allowed. A
  deterministic run does not need one — the budget is the brake.
- **Anything in `blocks_in_work()`**, which waits on something outside the
  flowgraph entirely, and stalls a shared thread besides.

Measured on `test/fixtures/deterministic_chain.grc`, four runs each:

| | items per block |
|---|---|
| `det` (default 1000 rounds) | 4,096,000 — identical every run |
| `det&rounds=250` | 1,024,000 — identical every run |
| `sts`, same flowgraph | 550,440,960 / 544,325,632 / 540,717,056 / 543,162,368 |

That last row is why the guarantee is worth stating: the same graph on the same
single thread, differing by ~2% per run, because nothing bounds where it stops.

### Reaching the message pump without patching the submodule

`gr::basic_block` keeps `msg_queue`, `has_msg_handler()` and `dispatch_msg()`
protected, and grants access to exactly one scheduler body:
`friend class tpb_thread_body;`. A second scheduler needs the same reach, and
most of it turns out to be public after all — `message_ports_in()` returns the
very keys of `msg_queue`, and `empty_p()` / `empty_handled_p()` / `nmsgs()` /
`delete_head_nowait()` cover the rest. (`empty_handled_p()` is
`empty_p() || !has_msg_handler()`, so on a queue known to be non-empty it is
exactly "a handler is attached".)

`dispatch_msg()` is the one thing with no public equivalent. It is reached
through the standard explicit-instantiation idiom in `schedulers.hpp`:
[temp.explicit] says access checking is not applied to the names in an explicit
instantiation's template-arguments, which makes naming a protected member there
well-defined rather than a cast around the type system. The pointer is only ever
called, and it is virtual, so it dispatches exactly as the block's own code
would. The alternative was a `friend` declaration in the submodule, which a
native build would see — and [gnuradio-patches.md](gnuradio-patches.md) is
explicit that a change there has to be justified upstream instead.

## Three places that count threads, and must agree

A scheduler changes how many Web Workers a run needs, and that number is decided
in stages — see [diagnostics.md](diagnostics.md) for the pool machinery itself.

| where | when | what it knows |
|---|---|---|
| `schedulerThreadCount()` in `runner/src/runner.html` | before the WASM module starts, from the URL | the scheduler name, and a regex guess at the block count |
| `plugin::thread_estimate()` in `schedulers.hpp` | after construction, from `calc_used_blocks()` | the real primitive block count; tops the pool up |
| `expectedPoolTier()` in `test/test_smoke.mjs` | in the test | mirrors both |

All three must give the same answer for the same graph, or the pre-start top-up
re-inflates a pool the earlier stage had just sized correctly. `g_scheduler_workers`
— the `dsp_threads` field of the `__grstats` snapshot and the debug panel's
`dsp threads` headline — is the scheduler's **actual** thread count, which is the
block count only on TPB.

## Testing

```bash
# the lowering, in a second, with no Emscripten involved
(cd runner/test && g++ -std=c++17 -I../src -I../third_party grc_test.cpp -o grc_test && ./grc_test)

# the editor half: the dropdown against the plugin table, the omitted default,
# and that no committed .grc carries the key
(cd editor && npm run check)

# the default path, unchanged, plus one case per alternative scheduler
node test/test_smoke.mjs

# any flowgraph, either scheduler, by hand
node scripts/run.mjs "/runner/build/runner.html?scheduler=sts#<encoded grc>" RUNNER_PASS
```

The `sts` smoke case is `wasm_pmt_blocks.grc` rather than a stream-only graph on
purpose: the riskiest part of a second scheduler is the message pump, and every
line that case expects is a message or a tag that only appears if handlers are
still being dispatched.

The `det` case is `deterministic_chain.grc`, and it is the only case in that file
that runs its flowgraph **twice** and compares the item counts exactly — which is
legitimate there and nowhere else, because a budgeted run has already stopped by
the time the snapshot is taken. It also pins `rounds × chunk` as a literal item
count, so changing either constant fails the suite rather than quietly making
every "deterministic" run a different one. That fixture carries `scheduler: det`
in its own Options block rather than taking the query, which makes it the end-to-
end cover for the `.grc` path.
