# The Embedded Python Block

Read this before touching anything under `runner/src/pyodide/`,
`blocks/src/python_block.hpp`, `editor/src/epy.ts`, or `deps/fetch-pyodide.sh`.

GRC's **Embedded Python Block** (`epy_block`) is the escape hatch: you write a
`gr.sync_block` subclass in the Properties dialog, and GRC derives the block's
label, parameters, ports and callbacks from the source. This build has no Python
interpreter, so the block runs on **Pyodide** — CPython compiled to WebAssembly —
in a Web Worker of its own. A block written for desktop GNU Radio runs here
unmodified.

Upstream this block has no `.block.yml`: it is a GRC built-in
(`gnuradio/grc/core/blocks/embedded_python.py`). Here `blocks/grc/epy_block.block.yml`
gives it a palette entry, the default source, and one hidden parameter; everything
else is derived.

There is a second escape hatch beside this one: the **JavaScript Block**
([docs/js-blocks.md](js-blocks.md)), whose `work()` runs on the block's own GNU
Radio scheduler thread against GNU Radio's own buffers — no worker, no copy, no
runtime to fetch. Every mechanism on this page exists to work around a constraint
JavaScript does not have, so the two are worth reading against each other.

## Why it is shaped like this

Three constraints, and every design decision below follows from one of them.

1. **`Atomics.wait` is illegal on the browser main thread, and Asyncify is off.**
   A `work()` call has to block its caller until Python answers. So Python lives in
   a worker, and the thread that blocks is the block's own GR scheduler thread —
   the same split [`blocks/src/browser_file_source.cpp`](../blocks/src/browser_file_source.cpp)
   uses.

2. **A block's constructor cannot wait for anything.** It runs on the main thread
   (`run_now()` in [runner/src/runner.cpp](../runner/src/runner.cpp)), and GR sizes
   buffers at construction — so `io_signature`, `set_history()` and
   `set_output_multiple()` are all needed *before* the constructor returns, and
   none of them can be fetched from Python at that point. Hence the prepare step:
   the whole flowgraph waits once, before any block is built.

3. **Pyodide has its own WebAssembly memory.** Upstream's `pointer_to_ndarray`
   hands Python a zero-copy view of GNU Radio's circular buffer; two WASM memories
   cannot alias, so each `work()` call copies input in and output back. Writing to
   `input_items` therefore changes nothing, which is the one behavioural difference
   a block author can notice.

And one delivery constraint: the site is cross-origin-isolated (COOP/COEP, needed
for `SharedArrayBuffer` and pthreads), so **Pyodide cannot come from a CDN**. It is
vendored by `deps/fetch-pyodide.sh` into a git-ignored `pyodide/` at the repository
root and served same-origin — about 30 MB (9.6 MB interpreter, 2.5 MB stdlib,
2.9 MB numpy, 13.3 MB scipy), fetched only by a page that actually needs it, and
the scipy half only by a block that imports it. See "Packages" below.

## The pieces

| path | what it is |
|------|------------|
| `deps/fetch-pyodide.sh` | pins and installs the Pyodide distribution into `pyodide/`. The only place a version appears |
| `runner/src/pyodide/gr_pyodide_worker.js` | the worker. Owns the interpreter, serves both the editor and the runner |
| `runner/src/pyodide/py/gnuradio/gr/gateway.py` | the API a block's source runs against: the four base classes, `py_io_signature`, and `_Gateway` in place of upstream's pybind11 `block_gateway` |
| `runner/src/pyodide/py/pmt.py` | a PMT is an ordinary Python object here (symbols are `str`, dicts are `dict`, uniform vectors are numpy arrays) |
| `runner/src/pyodide/py/grworld.py` | introspection (a port of `grc/core/utils/epy_block_io.py`) and the per-call work driver |
| `blocks/src/python_block.hpp` | `PythonBlockWasm`: the `gr::block` the scheduler sees, and the control block |
| `runner/src/registry.cpp` | `make_python_block()`: reads the worker's report and builds the block |
| `runner/src/runner.cpp` | the prepare step in the load chain, plus `gr_finish_pyodide_prepare` |
| `runner/src/runner.html` | `__grPyodidePrepare` / `__grPyodideBindBlock` / `__grPyodideDescription` |
| `editor/src/epy.ts` | interface cache → `RunnableDef`, and the editor's client for the worker |
| `editor/src/code-editor.ts` | CodeMirror over the Code field's textarea, loaded on demand |

The worker script and the Python shim are copied to `runner/build/pyodide/` by the
POST_BUILD step in `runner/CMakeLists.txt`, which also **generates
`py/manifest.json`** from the directory contents — the worker loads the shim by
manifest, so adding a module to it needs no second edit.

## The run-time handshake

```
    GR scheduler thread                        Pyodide worker
    ───────────────────                        ──────────────
 general_work()
   fill in_ptr/in_avail/out_ptr,
   nitems_read/written
   state  = BUSY
   seq   += 1  (release)  ──── notify ───►  Atomics.waitAsync on seq returns
   futex_wait(&state)                       drain the parameter dirty-mask
        ⋮                                   copy inputs  → Pyodide heap
        ⋮                                   blk.handle_general_work(ii, oo)
        ⋮                                   copy outputs → the runner's heap
                                            write result / consume / produce
   wake  ◄──────────── notify ─────────     state = DONE
   apply consume_each / consume / produce
   return result
```

Things worth knowing about it:

- **The sequence number is what makes it unambiguous.** The host bumps `seq` last,
  with release ordering, so it publishes every word written before it; the worker
  waits for "`seq` != the value I last served". Waiting on the *state* word instead
  would spin on a response the host has not collected yet, or miss a request.
- **`bind` is asynchronous, and that is safe.** A block's constructor posts its
  control-block pointers and returns. A `work()` request that arrives before the
  worker starts pumping is not lost — it is a durable `seq` bump in shared memory.
- **A call back into C++ from inside `work()` is batched, not synchronous.** The GR
  thread is asleep and cannot service one. `consume`/`consume_each`/`produce` are
  recorded by `_Gateway` and applied by `general_work()` when Python returns;
  `nitems_read`/`nitems_written`/`history` are pre-supplied with the request.
- **`forecast()` usually does not cross the boundary.** The description reports
  `overrides_forecast`, and unless the block defines its own, C++ computes
  `noutput * decim / interp + history - 1` locally — otherwise every scheduler
  iteration would cost two round trips instead of one.
- **Live parameters do not use the handshake at all.** A QT GUI Range's handler
  runs on the main thread, which may never block, so `set_callback_value()` writes
  a double and atomically ORs one bit into `W_SET_MASK`. The worker drains the mask
  immediately before its next call into Python, so the change lands *between*
  `work()` calls. One slot per callback means no update is lost.
- **A call that never answers is an error, not a hang.** `request()` gives up after
  30 s and throws; GR's `thread_body_wrapper` logs it through `BrowserLogSink`.
- **The control-block layout is mirrored in three places** — `python_block.hpp`
  (the `Word`/`Slot` enums), `gr_pyodide_worker.js` (the `W_*`/`D_*` constants) and
  `runner.html` (the two widths). The widths are checked at bind time, so a
  mismatch is an error message rather than a wild write.

One worker serves every Python Block in a flowgraph, so their `work()` calls
serialize — the same behaviour the GIL gives them in desktop GNU Radio.

## The editor side

A Python Block is the only block whose parameters and ports are not a property of
its block id, so `defFor(inst)` in `main.ts` is the seam: it returns
`RUNNABLE[inst.id]` for everything else, and for `epy_block` synthesizes a
`RunnableDef` from the interface cached in the block's `_io_cache` parameter.
Everything downstream — ports, the dialog, validation, the `.grc` writer — is
unchanged. **Any new code that reads a definition for an instance must go through
`defFor`**; `editor/test/epy-block.test.mjs` asserts the existing callers do.

`_io_cache` is a hidden JSON parameter, where upstream keeps a Python tuple `repr`
under `states`. As a parameter it rides the editor's ordinary pipeline with no
special case, and desktop GRC reading such a file sees an unknown parameter it
ignores. Its **default describes the default source**, which is what lets a
freshly placed Python Block be wired up with no Pyodide fetched at all;
`runner/test/test_grworld.py` asserts the two defaults still agree.

### The Code field

Native GRC hands this parameter to an external editor and re-reads the block every
time the file is saved (`grc/gui_qt/external_editor.py`). The browser equivalent is
an editor in the dialog plus an explicit re-read, because re-reading means running
the source in Pyodide.

That editor is **CodeMirror 6** — Python syntax highlighting, line numbers,
four-space indentation, bracket matching, undo, search — mounted *over* a plain
`<textarea>` and mirrored to it, the arrangement CodeMirror 5's `fromTextArea`
offered and CodeMirror 6 dropped. [`editor/src/code-editor.ts`](../editor/src/code-editor.ts)
is the whole of it. Two things follow from the textarea staying the field's value:

- **CodeMirror is a chunk of its own**, dynamically imported the first time a Code
  field is built. Nothing is fetched by a session that never opens a Python Block,
  and if the chunk never arrives the textarea is still a working Python editor.
  Keep `code-editor.ts` out of any eagerly-evaluated import chain;
  `editor/test/epy-block.test.mjs` asserts both halves of that.
- **Nothing else in `main.ts` knows CodeMirror exists.** The dialog reads and
  writes `tmp.params` through the textarea's `input` event exactly as before, so
  an edit made in CodeMirror raises one. `closeDialog()` is the single seam that
  tears the view down — a mounted CodeMirror on a detached node keeps global
  listeners alive.

Loading Python in the editor is opt-in (a button under the Code field), and the
consent is remembered in `localStorage`. Two consequences:

- Edited code **cannot be applied until Python has re-read it** — Apply and OK are
  disabled. Committing would leave the block's ports describing the previous
  source, so the flowgraph would be wired one way and built another, and only the
  runner would notice.
- A `.grc` written by desktop GRC has no readable cache, so the block shows no
  ports until its code is read. The editor says so in the console on load.

## Packages

A block's source can import a package Pyodide ships, and `scipy.signal` is the
one a desktop GRC Python Block reaches for most, so scipy is vendored beside
numpy. Two rules keep that from costing every flowgraph 13 MB:

- **The wheels are listed in one place**, `WHEELS` in
  [`deps/fetch-pyodide.sh`](../deps/fetch-pyodide.sh), each with the file name
  and sha256 from `pyodide-lock.json`. Adding a package is adding a line.
  Nothing else in the repo names a package version.
- **They are installed from a block's own imports, not at start-up.**
  `loadImports()` in the worker runs `pyodide.loadPackagesFromImports(source)`
  before the source is executed, for both clients — the runner's prepare step
  and the editor's introspection — so `from scipy.signal import fftconvolve`
  pulls scipy in and a block that does not mention it never waits for it. numpy
  is the exception, loaded up front: every block needs it, because the base
  classes describe their ports with numpy dtypes.

The fetch is announced through the same `print` channel a block's own `print()`
uses, so "Loading scipy" lands in the console pane rather than leaving a
14 MB wait unexplained.

Help ▸ Benchmark Tool measures this path against the C++ filters: its third
filter row is a Python Block convolving with `scipy.signal.fftconvolve` at the
same tap counts as the Decimating FIR and FFT Filter rows. See
[docs/diagnostics.md](diagnostics.md).

## Adding to the Python surface

`gnuradio.gr` deliberately exposes only what a block's own source needs; anything
else raises with a message saying why (the DSP blocks are in the runner's separate
WASM instance and belong on the canvas). If a real block needs something more:

- a `gr::block` method → add it to `_Gateway` in `gateway.py`. A *read* has to be
  pre-supplied by `general_work()` in `python_block.hpp` and passed through
  `begin_call()`; an *action* is recorded as an intent and applied after the call.
- a PMT function → add it to `pmt.py`.
- new state the host must know before construction → add it to
  `_Gateway.declaration()`, `_describe()`, `PythonBlockConfig` and
  `make_python_block()`, in that order.

Run `python3 runner/test/test_grworld.py` after any of it. That suite is a host
CPython run — `grworld` degrades its two Pyodide conversion helpers to identity
when `js` is not importable, precisely so the block contract is testable in a
second instead of only in a browser. Its cases follow
`gnuradio/gr-blocks/python/blocks/qa_block_gateway.py` and the self-test at the
bottom of `grc/core/utils/epy_block_io.py`, which between them are upstream's
specification of what a Python block may do.

## Not supported yet

- **Message ports and stream tags.** Both still need a PMT bridge across the
  Pyodide worker boundary (`pmt.py` is the Python half; nothing serializes a
  `pmt_t` into that second WASM heap yet). A Python Block that registers a
  message port is refused at prepare time with a message saying so, rather than
  running and silently delivering nothing. Tags are already plumbed as far as
  `_Gateway`: `get_tags_in_range`/`get_tags_in_window` filter a pre-supplied list
  (currently always empty) and `add_item_tag` records an intent. The JavaScript
  Block now supports both synchronously because it runs on the awake GNU Radio
  thread and shares the runner heap; reach for it when tags or messages matter
  more than running the same source unchanged in desktop GNU Radio.
- **`epy_module`** (GRC's Python Module block), which exists to be imported into
  *other blocks' parameter expressions*. Those are evaluated by
  [`editor/src/expr.ts`](../editor/src/expr.ts), a TypeScript Python subset, so
  supporting it means routing the editor's whole expression scope through Pyodide.
- **A native-authored `.grc` fed straight to `runner.html#<grc>`.** PyYAML folds
  long double-quoted scalars across lines and the runner's YAML subset
  ([runner/src/grc_yaml.hpp](../runner/src/grc_yaml.hpp)) is line-oriented: it
  reads `\n` escapes but cannot rejoin continuations. Through the editor (js-yaml)
  such a file loads fine, and the editor re-emits the source unfolded. This is why
  `test/fixtures/epy_block_scale.grc` keeps its source on one unbroken line.
- **A package Pyodide ships but this site does not vendor.** The stdlib is
  complete and numpy and scipy are here; anything else has to be added to
  `WHEELS` in the fetch script. The import fails at the *fetch*, not as an
  `ImportError`, because Pyodide finds the package in its lock file and then
  404s on the wheel — the worker says so and names the list to add it to.

## Testing

```bash
python3 runner/test/test_grworld.py        # the Python contract, on the host
node test/test_python_block.mjs            # a flowgraph whose work() is Python
node test/test_python_block_editor.mjs     # the editor: read code, ports follow
node scripts/run_example.mjs python/epy_soft_limiter.grc
```

Both browser tests **skip with a message** when `pyodide/` is absent, so a tree
that never ran the fetch script still passes. That is also why the Python Block is
not a case in `test/test_smoke.mjs`: the suite the deploy is gated on should not
start failing over an optional runtime. `test_grworld.py` needs numpy on the host
and nothing else.
