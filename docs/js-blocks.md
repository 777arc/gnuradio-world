# The JavaScript Block

Read this before touching `runner/src/js_runtime.js`, `blocks/src/js_block.hpp`,
`editor/src/js-block.ts`, `editor/src/code-modal.ts`, or anything under
`blocks/js/`.

A **JavaScript Block** (`wasm_js_block`) is the other escape hatch: you write a
`work()` in the Properties dialog or the popup code editor, and the block's label,
parameters and ports are derived from your source. Unlike the Embedded Python
Block there is nothing to download and nothing to wait for, because the language
is already in the browser — on every thread.

Read [docs/embedded-python.md](embedded-python.md) first if you have not. This
design is deliberately *not* shaped like that one, and the reasons only make sense
against it.

## The idea in one paragraph

GNU Radio's thread-per-block scheduler gives each block an Emscripten pthread — a
Web Worker that has already loaded the full `runner.js` glue — and that worker can
compile user source with `new Function` and read GNU Radio's circular buffers as
zero-copy typed arrays straight out of the shared WebAssembly memory. So a JS
block's `work()` is a plain synchronous call made from the block's own scheduler
thread. Every mechanism that defines the Embedded Python Block exists to work
around a constraint JavaScript does not have, so all of it goes.

| Concern | Embedded Python Block | JS Block |
|---|---|---|
| Where user code runs | a dedicated Pyodide worker | the block's own GR scheduler thread |
| Crossing into it | control block in shared memory, futex, sequence number | one `EM_ASM` call |
| Buffers | copied in and out of Pyodide's separate heap | zero-copy typed-array views on GR's buffers |
| Interface at construction | an async prepare step before any block is built | evaluated synchronously inside the factory |
| Editor introspection | opt-in ~16 MB download, explicit re-read, Apply disabled until it lands | instant and local; ports follow the code as you type |
| consume / produce | recorded as intents, applied after the call returns | `this.consume()` recorded and applied on return, with no thread to wake |
| A call that never answers | 30 s timeout, then an error | cannot time out — see [The hang](#the-hang) |
| Deploy-gated smoke test | excluded; the runtime is optional | included; there is no optional runtime |

```
    Embedded Python Block
    ─────────────────────
    GR thread ──seq/notify──► shared control block ──► Pyodide worker ──► second heap
    futex_wait ◄──────────────  (state)  ◄──────────   Atomics.waitAsync   copy in/out

    JS Block
    ────────
    ┌── one GR scheduler thread (one Web Worker) ──┐        GNU Radio's
    │  general_work()  ──EM_ASM──►  work(n,in,out) │ ◄────► circular buffer
    └──────────────────────────────────────────────┘  Float32Array, zero copy
```

**Measured cost of the crossing: under 100 ns, fixed.** At GR's
few-thousand-`work()`-calls a second that is noise, and it amortizes away entirely
at realistic buffer sizes — a ~4000-item call spends about 0.1% of itself on the
crossing. `outputMultiple` stays available as a lever but is not needed.

## The authoring contract

One rule: the source calls `gr.export` exactly once, with a descriptor. It is the
same contract for an inline block and for a file in `blocks/js/`, the file stays
lint-clean, and a source that never calls it gets a real error instead of a
mystery.

```js
// blocks/js/js_gain.js — or the Code field of an inline JS Block
gr.export({
  label:   'JS Gain',
  inputs:  ['complex'],
  outputs: ['complex'],
  params:  { gain: 1.0 },        // numeric params get live setters

  start() { this.count = 0; },   // optional; runs on this block's thread

  // input[0] / output[0] are zero-copy views on GNU Radio's buffers, re-derived
  // fresh for every call. Never stash one on `this`.
  // complex -> Float32Array, interleaved I/Q, length 2 * nout.
  work(nout, input, output) {
    const x = input[0], y = output[0], g = this.gain;
    for (let i = 0; i < nout * 2; i++) y[i] = x[i] * g;
    this.count += nout;
    return nout;                 // items produced
  },
});
```

**Ports.** `'complex'`, `'float'`, `'int'`, `'short'`, `'byte'`, or
`{ dtype, vlen }`. The view type follows: complex and float give a
`Float32Array` (complex interleaved, so length `2 * n * vlen`), int an
`Int32Array`, short an `Int16Array`, byte an `Int8Array`.

**Parameters.** An object of scalar defaults. They arrive on `this` under their
own names — the same shape as `self.example_param` in a Python block, which is the
point. Every *numeric* parameter becomes a `numeric_setters` entry, so a QT GUI
Range drives a JS block exactly as it drives a C++ one: the main thread writes a
double into a slot and atomically ORs one bit into a dirty mask, and the block
drains the mask immediately before calling `work()`, so a change lands *between*
calls and none is lost. Same mechanism as `set_callback_value()` in
[blocks/src/python_block.hpp](../blocks/src/python_block.hpp).

**Block kind.** `decimation` or `interpolation` present makes it a decimating or
interpolating block; supplying `generalWork(nout, nin, input, output)` instead of
`work` makes it a general block, with `this.consume(port, n)` available. To C++
these are all the same `gr::block`, exactly as the four Python base classes are.
A `work()` block is handed `nout * decimation / interpolation` input items and
consumes that many of them per call, exactly as GNU Radio's `sync_block`,
`sync_decimator` and `sync_interpolator` do. A `generalWork()` block consumes
nothing it did not ask to consume.

**Also optional.** `history`, `outputMultiple`, `relativeRate`, `forecast(nout,
required)`, `start()`, `stop()`, `doc`.

**Printing.** `this.log(...)` puts a line in the console pane below the flowgraph.
`console.log` from a scheduler worker reaches only devtools, where nobody looks,
so lines are queued and drained by C++ into `printf()` — the path every other
block's output already takes. A word flag in the control array makes the common
case (a block that never logs) free.

**Not in v1.** Stream tags and message ports. The architecture supports them —
synchronously, which is precisely what the Python block can never have — but they
need a JS↔PMT bridge. It is a scope decision, not a limitation.

## Two rules a block author has to know

### Module-level side effects run twice, and per-thread

The descriptor is data; the instance is per-thread. A JS object cannot cross a
worker boundary, and the factory runs on the browser main thread while `work()`
runs on the block's thread. So the source is evaluated twice:

- **Main thread, inside the factory.** Evaluate the source, read the descriptor,
  take from it the item sizes, decimation/interpolation, history, output multiple
  and the parameter names. All pure data; it becomes a plain `JsBlockConfig`
  exactly as `PythonBlockConfig` is today. Unlike the Python path, nothing has to
  be fetched or awaited first — which is why there is no prepare step.
- **Block thread, before the first `work()`.** Evaluate the same source again,
  build the instance, seed `this` from the flowgraph's parameters, call `start()`.

**Per-instance state belongs in `start()` or on `this` — never in the source's
top-level scope.** A top-level `const` that is genuinely constant is fine (see
`DECIMATION` in [blocks/js/js_peak_hold_ff.js](../blocks/js/js_peak_hold_ff.js));
a top-level array a block writes into is not.

Constructing lazily on the first `work()` rather than in `gr::block::start()` is
deliberate: `general_work()` is definitionally on the block's own thread, whereas
`start()` can arrive on the browser main thread, where an instance would be built
in the wrong realm. The cost is one honest difference from GNU Radio: **a JS
block's `start()` is an init hook and cannot refuse the run.**

### Never cache a view across calls

Take views through `GROWABLE_HEAP_*` on every call, which is what
`runner/src/js_runtime.js` does, and never stash a `subarray` on `this`.

On the `-pthread` shared heap, `ALLOW_MEMORY_GROWTH` does *not* detach the old
`SharedArrayBuffer`: `wasmMemory.buffer` is a new object after growth, so identity
checks work, but a view onto the old one keeps reading and writing the *same real
memory*, correctly. What a stale view cannot do is address memory that only exists
*after* the growth. So the failure a cached view causes is not a crash and not a
zero-read — it is a **silent out-of-range against a buffer allocated after a
growth**. That is a much quieter bug than a detach would be, which makes the rule
more load-bearing, not less.

A `subarray` costs tens of nanoseconds against a `work()` that moves thousands of
items, so there is no reason to ever bend it.

## The pieces

The repo's own rule decides where each one goes: *`blocks/` is what a human wrote
about blocks; `runner/` is the app plus everything generated.* `blocks/js/` is the
JavaScript sibling of `blocks/src/`.

| path | what it is |
|------|------------|
| [blocks/src/js_block.hpp](../blocks/src/js_block.hpp) | `JsBlockWasm : gr::block` — the half the scheduler sees. Holds the source, an integer handle, the parameter slots and the dirty mask; calls into JS from `general_work()` with a plain `EM_ASM`. Header-only, like `python_block.hpp` |
| [runner/src/js_runtime.js](../runner/src/js_runtime.js) | the JS half: the `new Function` harness, `gr.export`, descriptor validation, view construction from `GROWABLE_HEAP_*`, error capture. Linked with `--pre-js` so it is in the glue every pthread worker loads, and copied to `runner/build/js_runtime.js` so the editor can read it |
| [blocks/grc/wasm_js_block.block.yml](../blocks/grc/wasm_js_block.block.yml) | the inline block's palette entry, its default source, and three hidden parameters: `_source_code`, `_js_io` and `_js_source` |
| [runner/src/registry.cpp](../runner/src/registry.cpp) | `make_js_block()` — descriptor on the main thread → `JsBlockConfig`, plus one `numeric_setters` entry per numeric parameter. Sits beside `make_python_block()` and is a good deal shorter |
| `blocks/js/<id>.js` | a repo JS block's implementation |
| `blocks/grc/<id>.block.yml` | its palette metadata, carrying `flags: [js]` |
| [runner/gen_registry.py](../runner/gen_registry.py) | reads `flags: [js]`: emits `generated_js_blocks.cpp` (block id → source file, plus the registration of each id against the generic factory) and marks the ids supported |
| [editor/src/js-block.ts](../editor/src/js-block.ts) | descriptor → `RunnableDef`, the sandboxed introspection client, the Run-consent record, and the browser-local block library |
| [editor/src/code-modal.ts](../editor/src/code-modal.ts) | the popup code editor |
| [editor/src/code-editor.ts](../editor/src/code-editor.ts) | CodeMirror, with the language chosen from the field's dtype rather than hard-coded to Python |

`flags:` is already a real GRC field, and `gen_registry.py` gates its
generated-C++ path on `"cpp" in flags`. A yml carrying `flags: [js]` and no `cpp`
is therefore skipped by that path for free.

## How the source reaches the runner

**One rule covers every case, and it is what makes a shared link work before a
pull request merges: use the inline source when a block instance carries one,
otherwise fetch by id.**

- **Inline block** (`wasm_js_block`): nothing to do. The source is a parameter, so
  it is already in the flowgraph JSON the runner parses; the factory reads
  `_source_code` straight out of it.
- **A block from the browser-local library**: its instances are ordinary
  `wasm_js_block` instances carrying the source under `_js_source`, which is what
  makes a flowgraph shared as a link work for someone who does not have that
  library.
- **Repo block** (`flags: [js]`): the factory needs the text at construction, and
  construction cannot await. One small step joins the load chain in
  [runner/src/runner.cpp](../runner/src/runner.cpp), before any block is built:
  scan the lowered flowgraph for ids in `block_js_map()`, hand them to
  `__grLoadJsBlockSources(ids)` in [runner/src/runner.html](../runner/src/runner.html),
  which fetches `js/<id>.js` and hands the texts back to be copied into WASM
  memory. A handful of kilobytes of text — the same shape as the deferred
  side-module fetch that already exists, not a runtime.

Fetching rather than baking the sources in as string literals is what keeps the
*source* out of the wasm: editing a shipped block's `.js` is a file copy, not a
rebuild. Its **id** is still baked in — `block_js_map()` and the factory
registration both live in the generated `generated_js_blocks.cpp`, which is
compiled into the main module — so *adding* a block does relink. See the checklist
below for what that costs.

## Adding a repo JS block

1. `blocks/js/<id>.js` — the implementation, one `gr.export()` call.
2. `blocks/grc/<id>.block.yml` — `id`, `label`, `category`, `flags: [js]`,
   `documentation`, `parameters:`, `inputs:`/`outputs:`. **This file is what the
   generator scans**; a `.js` with no yml beside it is invisible, and a yml
   carrying `flags: [js]` with no `.js` fails the build.
3. `python3 runner/gen_registry.py` — rewrites `runner/src/generated_js_blocks.cpp`
   with the new id, and marks it supported in `runner/generated_blocks.json`
   (without which the palette greys it out).
4. `python3 editor/gen/gen_blocklib.py editor/public/blocks.json` — the palette
   entry.
5. `cmake -S runner -B runner/build && cmake --build runner/build`. The
   re-configure is for `runner/build/js/manifest.json`, which is a configure-time
   `file(GLOB)`; the build recompiles the one generated `.cpp` and relinks, which
   is about 40 s — not the ~2 minutes a full runner rebuild costs, because nothing
   else changed. The link's `POST_BUILD` step is also what copies `blocks/js/` into
   `runner/build/js/`, so it is not optional.
6. `(cd editor && npm run build)`.

**Editing** a block already in the tree is cheaper: only step 5's copy is needed
(`cmake --build runner/build` with any relink), and no generator has to run at all
unless the descriptor's ports changed.

**The yml is authoritative, not the descriptor.** It unlocks the whole GRC
parameter and port vocabulary — enums with `option_attributes`, `${type}`-templated
port dtypes, `hide` expressions, categories, documentation — that a JS object
would re-invent badly. The descriptor's own port declaration is then optional, and
`gen_registry.py` **fails the build** when a descriptor that declares ports
disagrees with its yml.

The three shipped blocks are worth reading as examples, because each exercises a
different part of the runtime:
[js_clip_cc](../blocks/js/js_clip_cc.js) (two live numeric parameters),
[js_phase_unwrap_ff](../blocks/js/js_phase_unwrap_ff.js) (per-instance state
carried across `work()` calls), and
[js_peak_hold_ff](../blocks/js/js_peak_hold_ff.js) (decimation).

## The editor

### Deriving ports, safely

Introspection runs inside an `<iframe sandbox="allow-scripts" srcdoc=…>` — an
opaque origin, with no reach into the editor's `localStorage` (which holds the
OpenRouter key Flowgraph Copilot uses) and no credentialed same-origin fetch. The
descriptor comes back as JSON over `postMessage`. It costs a few milliseconds, so
it is debounced on every keystroke, and the Python block's whole ceremony — a
re-read button, Apply and OK disabled until the runtime has answered — simply does
not exist. **Ports follow the code as you type.**

The sandbox evaluates `runner/build/js_runtime.js` itself: the editor fetches the
text and embeds it in the `srcdoc` (an opaque origin cannot fetch it for itself).
That is what makes the editor's view of a descriptor *the same* as the runner's
rather than a second implementation of it.

An infinite loop at the top level of a source would wedge the frame. It cannot
wedge the editor: the frame is disposable and a 2 s timeout disposes of it. There
is no such rescue for a `work()` that never returns — see [The hang](#the-hang).

### `defFor`, generalized rather than special-cased twice

`defFor(inst)` in [editor/src/main.ts](../editor/src/main.ts) is the seam every
consumer that reads a definition *for an instance* goes through. It is
`RUNNABLE[inst.id]` plus a `DERIVED` map that both `epy_block` and `wasm_js_block`
register into. Everything downstream — ports, the dialog, validation, the `.grc`
writer — is unchanged.

This is load-bearing, not tidying. The repo's most common hand-authored-flowgraph
failure is that *the editor silently drops parameters its schema does not declare*,
because a hand-written `RUNNABLE` schema supersedes the generated one. A JS block's
parameters are derived rather than declared, so `defFor` is the only thing standing
between that trap and every JS block.

### `_js_io`

The same role as the Python block's `_io_cache`, for the same two reasons: a
flowgraph draws its ports before anything is evaluated, and — the one that matters
more here — **opening a `.grc` never executes its JavaScript.** A hidden JSON
parameter with sorted keys, so re-deriving identical source leaves the file byte
for byte unchanged.

### The popup editor

Double-clicking a JS block (or "Edit Code ⤢" in Properties) opens a large
resizable modal: CodeMirror with `javascript()` on the left, and a live panel on
the right showing the derived label, ports, parameters and any error. The footer
carries *Save as Block…*, *Revert*, *Close* and *Save & Close*. The Properties
dialog keeps the smaller inline field, so a JS block and a Python block still look
like siblings.

[editor/src/code-editor.ts](../editor/src/code-editor.ts) keeps its two existing
invariants — mounted over the textarea, which stays the field's value;
dynamically imported, so nothing is fetched by a session that never opens a code
field — and takes the language as a parameter. Both language modes are separate
chunks, so a session that never opens a JS block never fetches one.

### Consent on Run

A `.grc` arriving from a link can carry arbitrary JavaScript, and the runner
iframe is same-origin with the editor. Pressing Run on a flowgraph containing a JS
block whose source has not already been accepted shows the code and asks — the
same shape as the RTL-SDR device prompt on the Run click, remembered per source
hash in `localStorage`.

Three sources never ask, because they were already reviewed or already yours:
the palette's shipped default, anything typed in this session (every successful
derivation accepts it), and a flowgraph loaded out of `example_flowgraphs/`. A
repo JS block never asks either — its source is not in the `.grc` at all.

## Save as Block

Prompt for an id, a label and a category. Then two things happen at once:

- It is **installed into the browser-local library** (IndexedDB) and appears in
  the palette immediately, in the category you named. Its instances are ordinary
  `wasm_js_block` instances with the source inlined under `_js_source`, so a
  flowgraph shared as a link works for someone who does not have that library.
- It **offers the two repo files** — `blocks/js/<id>.js` and
  `blocks/grc/<id>.block.yml`, both generated from the descriptor — to download or
  copy, with GitHub's new-file page one click away (the same hand-off
  [editor/src/contribute.ts](../editor/src/contribute.ts) uses for an example
  flowgraph). GitHub's new-file page commits to a branch; the second file goes onto
  that same branch, and the pull request is the two of them.

The repo pair is the real destination — a JS block that ships is a block everyone
gets. But a static site with no backend cannot commit for you, so without the local
library every block would be unusable until a pull request merged.

## What failure looks like

Every crossing is wrapped on the JS side — a JS exception is never allowed to
unwind through a wasm frame. The harness catches, writes `error.stack` into a
fixed error buffer in WASM memory, and returns a negative code. `general_work()`
throws a `std::runtime_error` carrying it; GR's `thread_body_wrapper` logs that
through `BrowserLogSink`, which is what puts it in the editor's console pane below
the canvas and turns it into `RUNNER_FAIL: <message>` rather than an opaque
`Uncaught <pointer>`.

That last part is only true because everything is compiled with `-fexceptions`. It
already is; this design depends on it staying that way.

### The hang

There is one honest cost to running on the block's own thread. A `work()` that
never returns **cannot be interrupted**: there is no timeout to fire and no worker
to `terminate()`, because the call is on the scheduler thread's own stack. That
thread is wedged until the tab is reloaded. The Python block's 30-second timeout
does not carry over.

This is the same thing a C++ block that spins already does, and it is the price of
everything else on this page.

## Build invariants

- **`--pre-js`, not `--post-js`.** `runner/src/js_runtime.js` has to be inside the
  module factory, which every em-pthread worker re-enters, so `__grJs` exists in
  the worker's own realm. Qt links with `MODULARIZE`; the pthread worker re-enters
  the same factory, so `--pre-js` content is constructed in that worker's realm.
  `LINK_DEPENDS` carries it, because `--pre-js` is not a tracked dependency.
- **`stringToUTF8` must stay in `-sEXPORTED_RUNTIME_METHODS`.** The runtime writes
  an error message into a fixed buffer C++ already owns rather than allocating one.
- **`MAIN_THREAD_EM_ASM` is the trap, not `EM_ASM`.** Every other JS-crossing
  helper in this tree uses the proxying form, because they all run from
  constructors on the main thread. Copying one into the JS block's hot path would
  compile, run, produce correct samples, and silently serialize every JS block in
  the flowgraph onto the main thread behind Qt's event loop. Related, and for the
  same reason: `window` is undefined on a pthread, so the runtime uses `globalThis`
  throughout.
- **`js_block.hpp` compiles into the main module**, exactly as `python_block.hpp`
  does. `EM_ASM` from inside a `dlopen`'d `SIDE_MODULE` is known-fragile in
  Emscripten and this design does not rely on it. If a deferred category module
  ever wants a JS block, that is a new investigation.
- **There is no Content-Security-Policy, and if one is ever added it must keep
  `script-src 'unsafe-eval'`** — `new Function` is how a block is compiled. See
  [docs/ci.md](ci.md).
- `MAIN_MODULE=2`, `EXPORT_ALL=1`, `ALLOW_MEMORY_GROWTH=1`,
  `PTHREAD_POOL_SIZE_STRICT=0`, `NO_DISABLE_EXCEPTION_CATCHING` and `-fexceptions`
  are all already set and are all load-bearing here.

## Testing

| suite | covers |
|---|---|
| [runner/test/js_runtime.test.mjs](../runner/test/js_runtime.test.mjs) | the harness on plain Node, no browser: descriptor validation, view shapes and lengths, decim/interp arithmetic, `generalWork`, `forecast`, logging, error capture — and the arithmetic of every shipped `blocks/js/*.js`. Runs in a second, the same bargain [runner/test/grc_test.cpp](../runner/test/grc_test.cpp) makes for the parser |
| [test/test_js_block.mjs](../test/test_js_block.mjs) | two flowgraphs whose `work()` is JavaScript, end to end in the runner, checked on probe *values* rather than liveness |
| [test/test_smoke.mjs](../test/test_smoke.mjs) | **a case, not an exemption.** There is no optional runtime to skip over, so the deploy gate covers JS blocks — which the Python block has never been able to claim |
| [editor/test/js-block.test.mjs](../editor/test/js-block.test.mjs) | descriptor → `RunnableDef`, `defFor` coverage, `_js_io` byte stability, the generated repo pair, the editor wiring — all on plain Node |
| [test/test_js_block_editor.mjs](../test/test_js_block_editor.mjs) | the editor in a real browser: the sandboxed introspection itself, and a block's ports following the code as it is typed with nothing pressed |
| [example_flowgraphs/javascript/js_amplifier_model.grc](../example_flowgraphs/javascript/js_amplifier_model.grc) | an inline JS block and a repo one in one flowgraph, run through `node scripts/run_example.mjs javascript/js_amplifier_model` |
| Help ▸ Benchmark Tool | a JS filter row beside the Python `fftconvolve` row, at the same tap counts. The comparison is the point of the row |

One lesson worth carrying into any new test here: **`-O2` deletes an allocation
whose memory is never observed.** A test that means to force memory growth must
make the allocation escape.

## Not supported yet

- **Stream tags and message ports.** The architecture supports them
  *synchronously* — a JS↔PMT bridge through small exported C shims, callable on
  the block's own thread, because that thread is awake and on the stack. This is
  precisely what the Python block cannot have, and it is the first thing after v1.
- **A JS block that draws.** The runner's GUI is Qt widgets placed by the GUI
  Layout block; a JS block wanting its own canvas needs a `gui: true`
  declaration and a widget to host it. See [docs/gui-layout.md](gui-layout.md).
- **Importing anything.** The source is a function body, not a module. There is no
  module graph and no network fetch from inside a block — which is also half of
  why the security story stays simple.
- **A long source in a hand-written `.grc`.** The same folding problem the Python
  block has: [runner/src/grc_yaml.hpp](../runner/src/grc_yaml.hpp) is line-oriented
  and cannot rejoin PyYAML's folded continuations. The editor writes one unbroken
  double-quoted scalar, which covers every path but a natively authored file.
- **Scaling past a handful of concurrent JS blocks.** Nothing suggests a problem —
  each JS block costs nothing beyond the GR scheduler pthread it was always going
  to need — but a flowgraph with dozens has not been run.
