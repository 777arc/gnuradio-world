# JavaScript Blocks — implementation plan

**Status.** The design is settled and its foundation is *proven*: phase 1, the
spike that had to establish the runtime mechanism actually works in this tree,
is **complete and passing**. Nothing else in this document is built yet.

When the feature lands, this file becomes `docs/js-blocks.md` and gains a row in
the doc table at the top of [AGENTS.md](AGENTS.md).

Read [docs/embedded-python.md](docs/embedded-python.md) first if you have not.
This design is deliberately *not* shaped like the Embedded Python Block, and the
reasons only make sense against that one.

---

## The idea in one paragraph

JavaScript is already in the browser, on every thread. GNU Radio's
thread-per-block scheduler gives each block an Emscripten pthread — a Web Worker
that has already loaded the full `runner.js` glue — and that worker can compile
user source with `new Function` and read GNU Radio's circular buffers as
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
| consume / produce / tags | recorded as intents, applied after the call returns | direct synchronous calls back into C++ |
| A call that never answers | 30 s timeout, then an error | cannot time out — but see "The hang", below |
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

---

## Phase 1 is done: the mechanism is proven

The one thing that could have invalidated this whole design was that the
combination is untried here. `EM_JS` under `-sMAIN_MODULE=2` is proven by
[blocks/src/browser_file_source.cpp](blocks/src/browser_file_source.cpp), but
nobody had run *that plus a pthread plus a growable shared heap*. That has now
been settled, twice.

The spike lives in **[tools/js-block-spike/](tools/js-block-spike/)** with its
own [README](tools/js-block-spike/README.md). It is throwaway code, wired into
no build and no test suite; delete it when the feature lands.

### Leg 1 — standalone, with the runner's own link flags

[spike.cpp](tools/js-block-spike/spike.cpp) plus
[js_runtime_spike.js](tools/js-block-spike/js_runtime_spike.js), built by
[build.sh](tools/js-block-spike/build.sh) with `-sMAIN_MODULE=2 -sEXPORT_ALL=1
-pthread -sALLOW_MEMORY_GROWTH=1 -fexceptions`, threads taken from
`PTHREAD_POOL_SIZE` exactly as GR scheduler threads are. **15/15 checks pass in
Node 20 and in headless Chrome**, both as a plain build and with
`-sMODULARIZE=1` — the shape Qt links the real runner in.

| what was checked | result |
|---|---|
| a plain `EM_ASM` body executes on the calling pthread | yes — `ENVIRONMENT_IS_PTHREAD` is 1 inside the body |
| `MAIN_THREAD_EM_ASM` from that same thread still proxies | yes — 0 inside the body; the two macros stay distinguishable |
| `--pre-js` code exists in an em-pthread worker's realm | yes |
| `new Function` compiles user source there | yes |
| the `gr.export()` contract, params on `this`, `start()` | works |
| zero copy: JS writes GR's buffers through `GROWABLE_HEAP_*` | works, byte-exact |
| a live parameter change lands between calls | works |
| a JS `throw` becomes a catchable `std::runtime_error` | works, `error.stack` preserved |
| several JS `work()` bodies run genuinely concurrently | 4/4 threads cleared a JS-side barrier |
| each pthread gets its own JS realm | 4/4 saw only their own compiled block |

### Leg 2 — the real runner

[runner_probe.hpp](tools/js-block-spike/runner_probe.hpp) is a `gr::sync_block`
whose `work()` is an `EM_ASM`. It was wired into the runner temporarily — one
`#include` plus one registry-table line in
[runner/src/registry.cpp](runner/src/registry.cpp), one `--pre-js` line in
[runner/CMakeLists.txt](runner/CMakeLists.txt) — and driven with
[js_spike_probe.grc](tools/js-block-spike/js_spike_probe.grc) through
[run_runner_probe.mjs](tools/js-block-spike/run_runner_probe.mjs).

```
runner verdict: RESULT: RUNNER_PASS blocks=3 sinks=0
  block src:   items=164557898
  block probe: items=164557898
  block sink:  items=164557898

JS_SPIKE pthread=1 main_proxied=0 pre_js=1 compiled=1 calls=2000
         items=8178794 wrong=0  84562 ns/call (20.7 ns/item)  JS_SPIKE_RUNNER_PASS
```

164 million complex samples through a JavaScript `work()` on a genuine GR
scheduler thread, zero incorrect samples, with Qt on the browser main thread and
side modules `dlopen`'d in the same process. **Those three lines have been
reverted and the runner relinked clean**; re-apply them to repeat the run.

### Measured cost

| | empty `EM_ASM` | full `work()`, nout=64 | per item |
|---|---|---|---|
| headless Chrome, `-O2` | 77–87 ns | ~1.0 µs | 15.0 ns |
| Node 20, `-O2` | ~136 ns | ~1.5 µs | 22.8 ns |
| real runner, `-O0`, nout ≈ 4090 | — | 84.6 µs | 20.7 ns |

**The fixed crossing cost is under 100 ns.** At GR's few-thousand-`work()`-calls
a second that is noise, and it amortizes away entirely at realistic buffer sizes
— the real runner's ~4090-item calls spend about 0.1% of the call on the
crossing. `outputMultiple` stays available as a lever but is not needed.

### Reproducing

```bash
source deps/env.sh
bash tools/js-block-spike/build.sh                 # plain
bash tools/js-block-spike/build.sh --modularize    # Qt's shape

# Node. The module must be kept alive; running the file directly exits first.
node -e "require('./tools/js-block-spike/build/spike.js'); setTimeout(()=>{},9000);"

# Browser, against the repository server (node server.mjs 8090 "$PWD")
node scripts/run.mjs /tools/js-block-spike/spike.html     SPIKE_PASS 8090 60000
node scripts/run.mjs /tools/js-block-spike/spike_mod.html SPIKE_PASS 8090 60000
```

Expected: `SPIKE_PASS`.

---

## What the spike changed about the design

Four things. The first is a correction to a rule both drafts stated wrongly; the
rest are invariants that were assumptions before and are facts now.

### 1. Memory growth does not detach a view — on a shared heap it cannot

Both earlier drafts said a retained typed-array view "reads zeros or throws"
once `ALLOW_MEMORY_GROWTH` replaces the backing buffer. On the `-pthread` shared
heap the measured behaviour is different, and gentler:

- `wasmMemory.buffer` **is** a new object after growth, so identity checks work;
- but the old `SharedArrayBuffer` is **not detached**, and a view onto it keeps
  reading and writing the *same real memory*, correctly;
- what a stale view cannot do is address memory that only exists *after* the
  growth.

So the rule is unchanged — **take views through `GROWABLE_HEAP_*` on every call
and never cache a `subarray` across calls** — but its justification is sharper.
The failure it prevents is not a crash and not a zero-read; it is a *silent
out-of-range* against a buffer allocated after a growth. That is a much quieter
bug than either draft described, which makes the rule more load-bearing, not
less. Write it into `docs/js-blocks.md` in exactly those terms, and into the
Runtime gotchas list in [AGENTS.md](AGENTS.md).

A `subarray` costs tens of nanoseconds against a `work()` that moves thousands
of items, so there is no reason to ever bend the rule.

### 2. `MAIN_THREAD_EM_ASM` is the trap, not `EM_ASM`

`EM_ASM` runs on the calling thread. `MAIN_THREAD_EM_ASM` proxies to the browser
main thread and blocks until it answers — confirmed in the same spike run, from
the same thread. Every existing JS-crossing helper in this tree uses the
proxying form, because they all run from constructors on the main thread:
[blocks/src/browser_file_source.cpp](blocks/src/browser_file_source.cpp),
[blocks/src/rtlsdr_source.cpp](blocks/src/rtlsdr_source.cpp),
[blocks/src/hackrf_common.cpp](blocks/src/hackrf_common.cpp),
[blocks/src/plutosdr_common.cpp](blocks/src/plutosdr_common.cpp), and
[runner/src/registry.cpp](runner/src/registry.cpp).

Copying one of those into the JS block's hot path would compile, run, produce
correct samples, and silently serialize every JS block in the flowgraph onto the
main thread behind Qt's event loop. **The JS block's `work()` path uses plain
`EM_ASM` only.** This is the single easiest way to destroy the design by
accident, and it deserves a comment at the call site.

Related, and for the same reason: `window` is undefined on a pthread. Those same
helpers reach for `window`; the JS runtime uses `globalThis` throughout.

### 3. `--pre-js` really does reach pthread realms, through Qt

Qt links the runner with `MODULARIZE` — `runner.js` opens with
`var runner_entry = (() => {` and ends with:

```js
var isPthread = globalThis.self?.name?.startsWith('em-pthread');
...
isPthread && runner_entry();
```

The pthread worker re-enters the same factory, so everything inside it —
including `--pre-js` and `--post-js` content — is constructed in that worker's
realm. The spike confirmed this structurally, then in a MODULARIZE build, then
in the real runner (`pre_js=1` in the output above), which also proves it
survives Qt's regeneration of `runner.html` and the
[patch_runner_js.py](runner/src/patch_runner_js.py) post-build step.

`GROWABLE_HEAP_I8/U8/I16/U16/I32/U32/F32/F64` are likewise defined at the top of
`runner.js`, in the same scope, and are therefore callable from both `--pre-js`
code and `EM_ASM` bodies.

### 4. The build needs `stringToUTF8`, which the runner does not currently export

The runner links with
`-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,stringToNewUTF8,UTF8ToString,FS`. The JS
runtime needs **`stringToUTF8`** as well — it writes an error message into a
fixed buffer that C++ already owns, rather than allocating. The spike's error
path exercised this in the standalone build (where it was exported) but not in
the real-runner leg, which never hit an error. Add it when wiring the runtime in.

---

## There is no Content-Security-Policy — keep it that way

[site/_headers](site/_headers) sets `Cross-Origin-Opener-Policy`,
`Cross-Origin-Embedder-Policy` and `Cross-Origin-Resource-Policy`, plus
`Content-Type` and `Cache-Control` lines. No CSP, so `new Function` is
available. This becomes a build invariant: **if a CSP is ever added it must keep
`script-src 'unsafe-eval'`.** Write that into [docs/ci.md](docs/ci.md) at the
same time as the feature.

---

## Why the source is evaluated twice

The descriptor is data; the instance is per-thread. A JS object cannot cross a
worker boundary, and the factory runs on the browser main thread while `work()`
runs on the block's thread. So:

- **Main thread, inside the factory.** Evaluate the source, read the descriptor,
  take from it the item sizes, decimation/interpolation, history, output multiple
  and the parameter names. All pure data; it becomes a plain `JsBlockConfig`
  exactly as `PythonBlockConfig` is today. Unlike the Python path, nothing has to
  be fetched or awaited first — which is why there is no prepare step.
- **Block thread, before the first `work()`.** Evaluate the same source again,
  build the instance, seed `this` from the flowgraph's parameters, call the
  block's `start()`.

> **Document this loudly for block authors.** Module-level side effects run
> twice. Per-instance state belongs in `start()` or on `this` — never in the
> source's top-level scope.

Constructing lazily on the first `work()` rather than in `gr::block::start()` is
deliberate: `general_work()` is definitionally on the block's own thread, whereas
who calls `start()` is a scheduler detail not worth depending on. The cost is one
honest difference from GNU Radio: **a JS block's `start()` is an init hook and
cannot refuse the run.**

---

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

That exact block is what the spike ran for 164 million samples, so the contract
below is not hypothetical.

**Ports.** `'complex'`, `'float'`, `'int'`, `'short'`, `'byte'`, or
`{ dtype, vlen }`. The view type follows: complex and float give a
`Float32Array` (complex interleaved, so length `2 * n * vlen`), int an
`Int32Array`, short an `Int16Array`, byte an `Int8Array`.

**Parameters.** An object of defaults. They arrive on `this` under their own
names — the same shape as `self.example_param` in a Python block, which is the
point. Every *numeric* parameter becomes a `numeric_setters` entry, so a QT GUI
Range drives a JS block exactly as it drives a C++ one. Keep the Python block's
mechanism here verbatim: the main thread writes a double into a slot and
atomically ORs one bit into a dirty mask; the block drains the mask immediately
before calling `work()`, so a change lands *between* calls and none is lost. See
`set_callback_value()` in
[blocks/src/python_block.hpp](blocks/src/python_block.hpp).

**Block kind.** `decimation` or `interpolation` present makes it a decimating or
interpolating block; supplying `generalWork(nout, nin, input, output)` instead of
`work` makes it a general block, with a synchronous `this.consume(port, n)`
available. To C++ these are all the same `gr::block`, exactly as the four Python
base classes are.

**Also optional.** `history`, `outputMultiple`, `relativeRate`, `forecast()`,
`stop()`, `doc`.

**Not in v1.** Stream tags and message ports — see "Deliberately out of scope"
below. The architecture supports them; it is a scope decision, not a limitation.

---

## The pieces

The repo's own rule decides where each one goes: *`blocks/` is what a human wrote
about blocks; `runner/` is the app plus everything generated.* `blocks/js/` is
the JavaScript sibling of `blocks/src/`.

| path | what it is |
|------|------------|
| `blocks/src/js_block.hpp` **(new)** | `JsBlockWasm : gr::block` — the half the scheduler sees. Holds the source pointer, an integer handle, the parameter slots and the dirty mask; calls into JS from `general_work()` with a plain `EM_ASM`. Header-only, like `python_block.hpp` |
| `runner/src/js_runtime.js` **(new)** | the JS half: the `new Function` harness, `gr.export`, descriptor validation, view construction from `GROWABLE_HEAP_*`, error capture. Linked with `--pre-js` so it is in the glue every pthread worker loads. [js_runtime_spike.js](tools/js-block-spike/js_runtime_spike.js) is a working sketch of it |
| `blocks/grc/wasm_js_block.block.yml` **(new)** | the inline block's palette entry, its default source, and two hidden parameters: `_source_code` and `_js_io` |
| [runner/src/registry.cpp](runner/src/registry.cpp) | `make_js_block()` — descriptor on the main thread → `JsBlockConfig`, plus one `numeric_setters` entry per numeric parameter. Sits beside `make_python_block()` and is a good deal shorter. Read numeric parameters with the existing `number_from(p, "gain", 1.0)` helper; GRC parameters arrive as JSON numbers *or* strings depending on the path |
| `blocks/js/<id>.js` **(new)** | a repo JS block's implementation |
| `blocks/grc/<id>.block.yml` | its palette metadata, carrying `flags: [js]` |
| [runner/gen_registry.py](runner/gen_registry.py) | learns `flags: [js]`: emits `generated_js_blocks.cpp` (block id → source path) and binds every such id to the one generic factory |
| `editor/src/js-block.ts` **(new)** | descriptor → `RunnableDef`, the sandboxed introspection client, and the local block library |
| `editor/src/code-modal.ts` **(new)** | the popup code editor |
| [editor/src/code-editor.ts](editor/src/code-editor.ts) | gains `@codemirror/lang-javascript`; the language is chosen from the field's dtype rather than hard-coded to Python |
| `docs/js-blocks.md` **(new)** | this file, once it is true — plus its row in the AGENTS.md table and the Runtime gotchas bullets |

`flags:` is already a real GRC field, and
[gen_registry.py](runner/gen_registry.py) already gates its generated-C++ path on
`"cpp" in flags`. A yml carrying `flags: [js]` and no `cpp` is therefore skipped
by that path for free — the new work is only the JS table beside it.

---

## How the source reaches the runner

**Inline block:** nothing to do. The source is a parameter, so it is already in
the flowgraph JSON the runner parses; the factory reads `_source_code` straight
out of it.

**Repo block:** the factory needs the text at construction, and construction
cannot await. One small step joins the load chain in
[runner/src/runner.cpp](runner/src/runner.cpp), before any block is built: scan
the lowered flowgraph for ids in `block_js_map()`, hand them to
`__grLoadJsBlockSources(ids)` in [runner/src/runner.html](runner/src/runner.html),
which fetches `js/<id>.js` and hands back the texts to be copied into WASM
memory. A handful of kilobytes of text — the same shape as the deferred
side-module fetch that already exists, not a runtime.

Generating the sources into the main module as string literals would also work
and needs no fetch, but then adding a JS block means a wasm relink. Fetching
means **adding a repo JS block needs no relink at all**: two files, rerun the two
Python generators, rebuild the editor. That agility is most of the reason to want
JS blocks in the first place.

One rule covers both, and it is what makes a shared link work before a pull
request merges: **use the inline source when a block instance carries one,
otherwise fetch by id.**

---

## The editor

### Deriving ports, safely

Introspection runs inside an `<iframe sandbox="allow-scripts" srcdoc=…>` — an
opaque origin, with no reach into the editor's `localStorage` (which holds the
OpenRouter key used by Flowgraph Copilot) and no credentialed same-origin fetch.
The descriptor comes back as JSON over `postMessage`. It costs a few
milliseconds, so it can be debounced on every keystroke, and the Python block's
whole ceremony — a re-read button, Apply and OK disabled until the runtime has
answered — simply does not exist here. **Ports follow the code as you type.**

### `defFor`, generalized rather than special-cased twice

`defFor(inst)` at [editor/src/main.ts:450](editor/src/main.ts#L450) is already
the right seam — it is `RUNNABLE[inst.id]` plus one `epy_block` branch, and the
comment above it already states the invariant ("Every consumer that reads a
definition *for an instance* goes through here"). Replace that branch with a
small `DERIVED: Record<blockId, (base, inst) => RunnableDef>` map that both
`epy_block` and `wasm_js_block` register into. Everything downstream — ports, the
dialog, validation, the `.grc` writer — stays unchanged, and
[editor/test/epy-block.test.mjs](editor/test/epy-block.test.mjs)'s "every
consumer goes through defFor" assertion extends to cover JS blocks rather than
being duplicated.

This is load-bearing, not tidying. The repo's most common hand-authored-flowgraph
failure is that *the editor silently drops parameters its schema does not
declare*, because a hand-written `RUNNABLE` schema supersedes the generated one.
A JS block's parameters are derived rather than declared, so `defFor` is the only
thing standing between that trap and every JS block.

### `_js_io`

The same role as the Python block's `_io_cache`, for the same two reasons: a
flowgraph draws its ports before anything is evaluated, and — the one that
matters more here — **opening a `.grc` never executes its JavaScript.** A hidden
JSON parameter with sorted keys, so re-deriving identical source leaves the file
byte for byte unchanged.

### The popup editor

Double-clicking a JS block (or "Edit Code ⤢" in Properties) opens a large
resizable modal: CodeMirror with `javascript()` on the left, and a live panel on
the right showing the derived label, ports, parameters and any error. The footer
carries *Save as Block…*, *Revert* and *Close*. The Properties dialog keeps the
smaller inline field, so a JS block and a Python block still look like siblings.

[editor/src/code-editor.ts](editor/src/code-editor.ts) keeps its two existing
invariants — mounted over the textarea, which stays the field's value;
dynamically imported, so nothing is fetched by a session that never opens a code
field — and gains one parameter for the language.

### Consent on Run

A `.grc` arriving from a link can carry arbitrary JavaScript, and the runner
iframe is same-origin with the editor. Pressing Run on a flowgraph containing a
JS block whose source hash has not already been accepted shows the code and asks
— the same shape as the RTL-SDR device prompt on the Run click, remembered per
hash in `localStorage`. Repo blocks are trusted because they went through review;
source typed in this session is trusted from the moment it was typed.

---

## Save as Block

Prompt for an id, a label and a category. Then two things happen at once:

- It is **installed into the local library** (IndexedDB) and appears in the
  palette under `[Custom]` immediately, through the same `installGeneratedBlocks`
  path in [editor/src/block-library.ts](editor/src/block-library.ts) that
  `blocks.json` uses.
- It **offers the two repo files** — `blocks/js/<id>.js` and
  `blocks/grc/<id>.block.yml`, both generated from the descriptor — as a
  download, or as GitHub new-file links reusing the approach in
  [editor/src/contribute.ts](editor/src/contribute.ts). GitHub's new-file page
  commits to a branch; the second file goes onto that same branch, and the pull
  request is the two of them.

**The yml is authoritative for a repo block, not the descriptor.** The yml
unlocks the whole GRC parameter and port vocabulary — enums with
`option_attributes`, `${type}`-templated port dtypes, `hide` expressions,
categories, documentation — that a JS object would re-invent badly. The
descriptor's own port declaration is then optional, used only where there is no
yml, and `gen_registry.py` fails the build when a descriptor that declares ports
disagrees with its yml. No human writes the yml by hand: the editor generates it.

Instances of a *local* block inline their source into the `.grc` under
`_js_source`, so a flowgraph shared as a link works for someone who does not have
that local library. Instances of a merged repo block carry only the block id.
That is the same one rule from "How the source reaches the runner", seen from the
editor's side.

---

## Generators and build

- **[runner/gen_registry.py](runner/gen_registry.py).** `wasm_js_block` joins
  `CUSTOM_IDS`. Repo JS blocks are a third category beside "generated C++" and
  "custom", so the `CUSTOM_IDS` ↔ registered-factories assertion has to learn
  about them — they are registered from a generated table rather than by hand in
  `registry.cpp`. They also need marking as supported in
  [runner/generated_blocks.json](runner/generated_blocks.json), or the palette
  greys them out.
- **[editor/gen/gen_blocklib.py](editor/gen/gen_blocklib.py).** Nothing special.
  A `blocks/grc/<id>.block.yml` with `flags: [js]` is palette metadata like any
  other.
- **[runner/CMakeLists.txt](runner/CMakeLists.txt).** Four changes:
  1. `--pre-js ${CMAKE_CURRENT_SOURCE_DIR}/src/js_runtime.js` beside the existing
     `--post-js src/diag.js`, with a `LINK_DEPENDS` entry so editing it relinks
     (mirroring what `diag.js` already does — `--pre-js` is not a tracked dep).
  2. Add `stringToUTF8` to `-sEXPORTED_RUNTIME_METHODS` (see "What the spike
     changed", item 4).
  3. Copy `blocks/js/*.js` into `runner/build/js/` and generate
     `js/manifest.json` from the directory contents — exactly what the POST_BUILD
     step already does for `runner/build/pyodide/py/`.
  4. Nothing else. `MAIN_MODULE=2`, `EXPORT_ALL=1`, `ALLOW_MEMORY_GROWTH=1`,
     `PTHREAD_POOL_SIZE_STRICT=0`, `NO_DISABLE_EXCEPTION_CATCHING` and
     `-fexceptions` are all already set and are all load-bearing here.
- **[site/_headers](site/_headers).** A `Cache-Control` line for
  `/runner/build/js/*`, beside the ones already there. And the CSP invariant
  above written into [docs/ci.md](docs/ci.md).
- **[scripts/assemble-site.mjs](scripts/assemble-site.mjs).** Include
  `runner/build/js/` in the deployed site.

---

## What failure looks like

Every crossing is wrapped on the JS side — a JS exception is never allowed to
unwind through a wasm frame. The harness catches, writes `error.stack` into a
fixed error buffer in WASM memory, and returns a negative code. `general_work()`
throws a `std::runtime_error` carrying it; GR's `thread_body_wrapper` logs that
through `BrowserLogSink`, which is what puts it in the editor's console pane
below the canvas and turns it into `RUNNER_FAIL: <message>` rather than an opaque
`Uncaught <pointer>`. The spike verified this whole chain end to end, message and
stack intact.

That last part is only true because everything is compiled with `-fexceptions`.
It already is; this design depends on it staying that way.

### The hang

There is one honest cost to running on the block's own thread, and neither
earlier draft stated it. A `work()` that never returns **cannot be interrupted**:
there is no timeout to fire and no worker to `terminate()`, because the call is
on the scheduler thread's own stack. That thread is wedged until the tab is
reloaded. The Python block's 30-second timeout does not carry over, and there is
no cheap way to reproduce it here.

This is an acceptable trade — it is exactly what a C++ block that spins does —
but say so in the docs, and make the editor's *introspection* path (which does
run in a disposable iframe) enforce a short timeout, so at least an infinite loop
in a constructor cannot wedge the editor while you are typing.

---

## Testing

Following the repo's restraint rule — a new suite is for a genuinely new area of
behaviour, and a JS block runtime is one; anything smaller folds into the suite
that already covers the code it touches.

| suite | covers |
|---|---|
| `runner/test/js_runtime.test.mjs` **(new)** | the harness on plain Node, no browser: descriptor validation, view shapes and lengths, decim/interp arithmetic, error capture. Runs in a second — the same bargain [runner/test/grc_test.cpp](runner/test/grc_test.cpp) makes for the parser |
| `test/test_js_block.mjs` **(new)** | a flowgraph whose `work()` is JavaScript, end to end in the runner |
| [test/test_smoke.mjs](test/test_smoke.mjs) | **a case, not an exemption.** There is no optional runtime to skip over, so the deploy gate covers JS blocks — which the Python block has never been able to claim |
| `editor/test/js-block.test.mjs` **(new)** | descriptor → `RunnableDef`, `defFor` coverage, `_js_io` byte stability, the local-library round trip. The "CodeMirror stays out of the eager import chain" assertion joins the existing epy one rather than being copied |
| `example_flowgraphs/js/…` | one real example, run through `node scripts/run_example.mjs` for `EXAMPLE_PASS` and auto-arranged with `node scripts/arrange_example.mjs` before it is committed, per the repo rule |
| Help ▸ Benchmark Tool | a JS filter row beside the existing Python `fftconvolve` row, at the same tap counts. The comparison is the point of the row |

One lesson from the spike worth carrying into these tests: **`-O2` deletes an
allocation whose memory is never observed.** The spike's first growth probe
called `malloc(96 MB)`, never read it, and LLVM removed the allocation entirely —
the heap never grew and the check failed while looking exactly like a platform
limitation. Any test that means to force memory growth must make the allocation
escape (the spike uses a `volatile` sink).

---

## Remaining risks

The big one — "the combination is untried" — is **resolved**; see phase 1 above.
What is left is smaller.

**`EM_ASM` from inside a `dlopen`'d side module** is known-fragile in Emscripten
and was not tested. It does not matter for this design, because `js_block.hpp`
compiles into the main module exactly as `python_block.hpp` does. **Keep it
there.** If a deferred category module ever wants a JS block, that is a new
investigation, not a small change.

**Scaling past a handful of concurrent JS blocks.** Four threads is a concurrency
proof, not a scaling curve. Nothing suggests a problem — each JS block costs
nothing beyond the GR scheduler pthread it was always going to need — but a
flowgraph with dozens has not been run.

**A long source in a hand-written `.grc`.** The same folding problem the Python
block has: [runner/src/grc_yaml.hpp](runner/src/grc_yaml.hpp) is line-oriented and
cannot rejoin PyYAML's folded continuations. The editor writes one unbroken
double-quoted scalar, which covers every path but a natively authored file — note
the limitation the way [docs/embedded-python.md](docs/embedded-python.md) already
does for `epy_block`.

**`runner.js` and `runner.wasm` are one indivisible build.** `runner.html` already
warns about this: emcc bakes the `EM_ASM` string addresses of a given link into
`runner.js`, so a stale `runner.js` beside a fresh `runner.wasm` produces garbage.
Adding a JS runtime that lives in that same glue does not change the rule, but it
does raise the cost of breaking it. Leave the existing guard in place.

---

## Phases

Ordered because each is gated on the last. Nothing here is parallelizable except
the doc.

1. ~~**Spike.** Prove the mechanism in the real runner.~~ **Done** — see phase 1
   above. [tools/js-block-spike/](tools/js-block-spike/) holds the throwaway code;
   delete it when phase 2 lands.
2. **Runtime core.** `js_block.hpp`, `js_runtime.js`, `make_js_block()`,
   `wasm_js_block.block.yml`, the Node harness test and a fixture flowgraph.
   Ports and parameters derived; no new editor UI yet beyond the existing code
   field.
   *Gate: `RUNNER_PASS` on a fixture, `js_runtime.test.mjs` green.*
3. **Editor.** Sandboxed introspection, the `defFor` generalization, `_js_io`,
   the popup editor, live derivation, `lang-javascript`, the Run consent.
   *Gate: ports follow the code as you type; `npm run check` green.*
4. **Repo library.** `blocks/js/`, `flags: [js]`, the generator and CMake work,
   the source fetch — and two or three real blocks shipped, chosen so they earn
   their place rather than demonstrating the mechanism.
   *Gate: a repo JS block placed from the palette runs, with no wasm relink to
   add it.*
5. **Save as Block.** The local IndexedDB library, the palette category, the
   two-file generation, the contribute hand-off.
   *Gate: author → save → place → share a link that works for someone else.*
6. **Docs and gates.** `docs/js-blocks.md`, the AGENTS.md row and gotcha bullets,
   the smoke-test case, the example flowgraph, the benchmark row.
   *Gate: `test_smoke.mjs` covers a JS block; `run_example.mjs` gives
   `EXAMPLE_PASS`.*

---

## Deliberately out of scope for v1

**Stream tags and message ports.** The architecture supports them *synchronously*
— a JS↔PMT bridge through small exported C shims, callable on the block's own
thread, because that thread is awake and on the stack. The spike confirms that
property directly. This is precisely what the Python block cannot have, and it is
worth being the first thing after v1 rather than a someday item.

**A JS block that draws.** The runner's GUI is Qt widgets placed by the GUI
Layout block. A JS block wanting its own canvas needs a `GUI_IDS` entry and a
widget to host it — a real feature, not an extension of this one. See
[docs/gui-layout.md](docs/gui-layout.md).

**A copilot tool that writes blocks.** The obvious follow-on: `write_js_block`
beside the existing structured graph tools in
[editor/src/ai/tools.ts](editor/src/ai/tools.ts). Wait until the block exists and
its errors are good.

**Importing anything.** The source is a function body, not a module. There is no
module graph and no network fetch from inside a block — which is also half of why
the security story stays simple.

---

## Decisions already made, and why

**Run on the block's own scheduler thread, not in a per-block Web Worker.** The
rejected alternative (`JAVASCRIPT_BLOCKS_PLAN1.md`) reused the Python block's
shared-memory control block, futex handshake and async prepare step, swapping
Pyodide for a plain worker. It would have worked, and its safety net was that the
protocol is already written and already tested. But every part of that protocol
exists to work around a second heap that cannot be touched synchronously, and
JavaScript has no second heap. Running inline is simpler, measurably faster,
needs no prepare step, and is the only option that can ever have synchronous tags
and message ports. The one thing the worker design buys that this does not is
containment of a hung `work()` — see "The hang" above, where that cost is stated
plainly.

**`gr.export(descriptor)` rather than "the first class in the file wins".** The
Python block copies GRC's rule of instantiating the first class it finds, which
needs a fragile scan of the evaluated scope; a bare top-level `return` would be
simplest of all but is not valid in a module, so linters and editors flag every
block file. An explicit registration call is one unambiguous rule, works
identically inline and in a file, and lets the harness say "your code never
called `gr.export()`" instead of failing obscurely.

**Repo files *and* a browser-local library, not one or the other.** The repo pair
is the real destination — a JS block that ships is a block everyone gets. But a
static site with no backend cannot commit for you, so without the local library
every block is unusable until a pull request merges. Local blocks inline their
source into the `.grc`, which keeps a shared flowgraph working in the gap.

**Stream ports and live parameters in v1; tags and messages after.** Tags and
message ports are the more interesting capability and the one the Python block
will never get, but they need a PMT bridge, and shipping the runtime first means
that bridge gets built against something that already works.
