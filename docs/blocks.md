# Implementing a block: the registry, and what browsers change

Where a block's C++ lives, which side of the registry line it belongs on, and the
per-block traps that are not guessable from the code. [AGENTS.md](../AGENTS.md)
carries the short version — the one placement rule and its table. For adding a
whole *module* of blocks, read [adding-modules.md](adding-modules.md) instead.

## Where a block's source lives

One rule decides it: **`blocks/` is what a human wrote about blocks; `runner/` is
the app plus everything generated.** So `generated_registry*.cpp`,
`generated_modules.cpp` and `generated_blocks.json` stay under `runner/` — they
are build outputs — and the `gr-<m>/` submodules stay at the repository root,
because they are pristine checkouts rather than anything of ours.

| what | where |
|------|-------|
| metadata for a block with no upstream definition | `blocks/grc/<id>.block.yml` |
| its implementation, any browser replacement of an **in-tree** GNU Radio block, and any C++ rebuild of an in-tree Python hier block | `blocks/src/` — `<module>_hier.hpp` per GNU Radio module rebuilt |
| browser-only metadata for one module's blocks | `blocks/overlays/<module>/metadata.yml` |
| a headers-only stand-in for a host-only dependency | `blocks/overlays/gr-<m>/shims/` |
| C++ rebuilt from an **out-of-tree** module's Python-only block | `blocks/overlays/gr-<m>/` |

`blocks/overlays/gnuradio/` is the one directory holding metadata alone. The
GNU Radio submodule is not one module but fifteen, so there is no single module
to attribute its C++ to and no single module its block ids can be checked
against — which is exactly why `blocks/src/` exists and why `validate()` skips
the ownership check for that directory only. Everything else is uniform: a
module is a directory, and `block_overrides.load()` discovers it by name, so
adding a module is adding a directory rather than editing a list.

The overlay directories are on the compiler's include path (`GR_INCLUDE_DIRS` in
`runner/CMakeLists.txt`), so a rebuilt block's header resolves by bare name from
the generated registrar that constructs it. Keep those filenames unique across
modules — they share one flat search path.

## Registry and module conventions

Direct C++ factories are generated from GRC `.block.yml` `cpp_templates`.
The factory *table* — every `block-id → factory` entry, including the
hand-written ones needing browser widgets, live setters, or a browser-specific
composed block — lives in [`runner/src/registry.cpp`](../runner/src/registry.cpp).
The classes those factories construct live in `blocks/` per the table above; the
table stays whole because it is the index.

The line between the two is **whether the code reads a flowgraph parameter**.
Anything taking a `const json&` — the `*_from()` decoders, the widget builders,
the `make_*()` factory helpers — is factory-side and stays in `registry.cpp`
beside the table. A block class, and the pure functions it is built out of (the
OFDM sync words, the PSK constellation), take plain C++ arguments and belong in
`blocks/`. That is what lets the block headers stay free of `nlohmann/json` and
of `BuiltBlock`.

- Add handwritten factory IDs to `CUSTOM_IDS` in `runner/gen_registry.py` to
  avoid duplicate generated factories.
- Put block metadata that cannot be rendered in `INVALID_CPP_TEMPLATES`, with a
  reason.
- A block that *builds* fine but should not be offered in the browser goes in
  `EXCLUDED_BLOCKS` instead, mapping its id to the reason the palette shows on
  hover. It stays visible and greyed out like a Python-only block, and its C++
  is left in place so re-enabling it is one line. `satellites_sat_3cat_1_deframer`
  is the worked example: see "A correlator with a loose threshold" below.
- Python-only `gr.hier_block2` definitions are unavailable unless explicitly
  rebuilt as C++ hierarchies in `blocks/src/<module>_hier.hpp` (or, for
  gr-satellites, `blocks/overlays/gr-satellites/satellites_{hier,deframers}.cpp`).
- Blocks absent from the WASM registry remain visible but disabled in the editor
  palette.
- Symbol exports for side modules are generated automatically by
  `gen_side_exports.py`; do not maintain a manual export list.

`runner/generated_blocks.json` is the authoritative runtime support manifest,
used to mark palette entries runnable or unavailable. Blocks whose constructors
require a separately typed GRC companion object (an OFDM equalizer, packet
formatter, or message queue) are listed under `skipped` with a reason; the runner
has a small typed-object registry for the exceptions it does support —
constellation variables for Constellation Modulator, and gr-fec's CC Decoder
Definition (`variable_cc_decoder_def`), which `fec_async_decoder` and
`fec_extended_decoder` look up by name.

## Writing the C++

### `registry.cpp` compiles its includes with Qt's macros in scope

`emit` is one of them — it expands to nothing, so a member function called
`emit()` compiles to `();` and the error points at the call site with "expected
expression" rather than at the name. `signals` and `slots` are the other two.
`blocks/src/text_sink.hpp` calls its line flusher `flush_line()` for exactly this
reason. A block header pulled in only by a *side* module is unaffected: no Qt
there.

### A block that prints text has somewhere to print it

A byte stream of characters — gr-ham's Varicode Decoder, say — goes to
`wasm_text_sink` ("Text Sink"), which writes lines to the console pane; upstream
flowgraphs end such a chain in a File Sink and open the file afterwards, which
cannot work against Emscripten's in-memory filesystem. It is line-oriented
because Emscripten's print hook only calls out to JS on a newline, so a Max Line
Length break is what makes a decode that never sends one visible at all.

### A correlator with a loose threshold can starve the main thread

`satellites_sat_3cat_1_deframer` is in `EXCLUDED_BLOCKS` for this. Its syncword
search accepts a 32-bit pattern with up to 4 bit errors, so on noise-like input
it reports a frame constantly and runs a full decode on each one. At 200 kS/s the
page stops responding altogether — not a crash and not a deadlock: the same
flowgraph at 2 kS/s finishes in under a second, and `syncword_threshold: 0`
clears it at full rate, which is what points at the search rather than the
Reed-Solomon decode that several other deframers also use. Worth remembering when
judging another block: measure at two rates and two thresholds before blaming the
arithmetic.

### Python hier blocks

`gr.hier_block2` compositions such as PSK Mod or the OFDM Transmitter have no C++
path at all, so the browser gets the same block id backed by the same chain
rebuilt as a C++ `hier_block2` in `blocks/src/digital_hier.hpp`
(`digital_psk_mod`, `digital_ofdm_tx`). Where the Python block computes defaults
with numpy (the OFDM sync words), reproduce them exactly: numpy's legacy
`RandomState(seed)` is MT19937 seeded identically to `std::mt19937(seed)`, and
`randint(2)` is one 32-bit draw's low bit.

### Python GUI blocks

The same story with a `QWidget` instead of a chain: gr-rds's `rds_panel` is a
Python QWidget, and it is the only place an RDS receiver ever shows its decoded
ASCII, so `registry.cpp` rebuilds it as a message-sink block whose handler records
the parser's `(type, text)` tuples and whose QTimer paints them (message handlers
run on GR threads; widgets are main-thread only). See
`example_flowgraphs/rds/rds_receiver.grc`.

### Python blocks whose dependency is a browser capability

These get rebuilt around the browser's version of it. gr-paint's
`paint_image_source` ("Image File Source") decodes an image with PIL upstream;
there is neither PIL nor a filesystem here, so
[`blocks/overlays/gr-paint/paint_image_source.cpp`](../blocks/overlays/gr-paint/paint_image_source.cpp)
names a local picture or a URL and lets the platform decode it
(`__grLoadImageSource` in `runner.html`). Two things generalize from it:

- **A decode is asynchronous and a GNU Radio constructor is not.** The
  constructor only *starts* the job (returning an id); the wait is a futex in
  `work()`, on the source's own scheduler thread, where blocking stalls nothing
  else — the same split `BrowserFileSource` uses. Do not try to resolve it in the
  constructor: that runs on the browser main thread, which cannot block in a
  non-Asyncify build.
- **A dimension the decode discovers is not available when buffers are sized.**
  Buffers are sized before any block's `start()`, so unlike the Python this block
  cannot `set_output_multiple(width)`; it emits at line granularity instead,
  tagging `image_width`/`line_num` at each line start.

A **local picture** rides the same session-only binding a local recording does:
`LOCAL_FILE_PARAMS` in `main.ts` names the parameter each such block keeps its
file in, which is what puts a Browse control in its Properties dialog and rewrites
that parameter to a `/local-files/...` path on the Run path (`RUN_BOUND_PARAMS`
adds Public HTTP Recording's URL, rewritten the same way to
`/recordings/external/...`). A `.grc` still stores only the file name. An image on
another origin must be served with permissive CORS headers, which is why the
`example_flowgraphs/paint/` examples paint same-origin assets from
`editor/public/example_images/`.

## GUI blocks

### A QT GUI control is two objects, not one

Most of GRC's "GUI Widgets/QT" family are Python QWidgets upstream, rebuilt in
[`blocks/src/qtgui_controls.hpp`](../blocks/src/qtgui_controls.hpp). Each is a
*variable* (it publishes a value under its block ID, which
`is_variable_control()` in `grc_lower.hpp` marks so run_now() builds it before
anything else) and usually also a *message* block (a `state`/`value` port), and
those cannot be the same object: a QWidget is not a `gr::block`. So the factory
returns a `BuiltBlock` carrying both, and the flowgraph connects the block by the
control's own name. Three things follow, and none is guessable:

- **The value model is a double**, so a control's `type: string` option has
  nothing to publish. The factories throw by name and
  `blocks/overlays/gnuradio/metadata.yml` prunes the option, rather than letting
  the palette offer one the runtime always refuses.
- **A state control announces itself in `start()`**, which upstream's Python
  widgets do not do. Without it a receiver wired to a Toggle Switch has no idea
  which way the switch is set until someone flips it, and gr-qtgui's own C++
  control (`edit_box_msg_impl::start`) already publishes its default this way.
  The Msg Push Button deliberately does not: a momentary trigger announces an
  event, and an event that did not happen must not be announced.
- **`VARIABLE_CONTROL_IDS` in `editor/src/validation.ts` is a hand-kept copy of
  that C++ rule**, and the two drifting is silent: the editor refuses a parameter
  naming a control it does not know is one, with the wrong reason. A case in
  `editor/test/validation.test.mjs` asserts them equal against blocks.json.

A control's own parameters are read when it is constructed, before any other
control exists, so they cannot reference one — except QT GUI Label's Value, which
is *bound* through a numeric setter rather than read, and so may name a control
and track it. `example_flowgraphs/qtgui/control_widgets.grc` exercises every one
of them.

### The fosphor sink

The gr-fosphor Qt sink is a dual-backend GUI path (its standalone GLFW
counterpart is hidden — a separate desktop window has no browser meaning).
`runner.html` asks for a WebGPU adapter before starting such a flowgraph and
compiles the pipelines in `runner/src/fosphor_webgpu.js`; a C++ sink in
[`blocks/overlays/gr-fosphor/`](../blocks/overlays/gr-fosphor/) publishes IQ
frames through a lock-free double buffer in shared WASM memory, and WGSL does the
window, 1024-point FFT, waterfall and render without reading signal data back. It
reproduces the native fosphor visual model (persistent 1024x128 density
histogram, upstream rise/decay constants and palette, live and max-hold traces).
If adapter, device, pipeline or canvas setup fails, the registry constructs the
Qt6 CPU spectrum/waterfall hierarchy instead.

### A widget's placement is not the block's business

`gui_hint` does nothing here; a singleton **GUI Layout** block arranges the whole
runner window. Whether a block *has* a widget is decided in C++ and carried to the
editor by `GUI_IDS` in `gen_registry.py` → the `gui` flag in blocks.json, so a
factory that grows a `QWidget` without an entry there silently loses its tile. See
[gui-layout.md](gui-layout.md).

### The three blocks that read a file

File Source, GR World Recording and Public HTTP Recording are all
`BrowserFileSource` over a path the browser resolves a binding through, and they
differ only in where that path comes from — a session-bound local file, an R2
bucket key the *runner's factory* expands, or a public URL the editor rewrites on
the Run path. Read [recording-viewer.md](recording-viewer.md) before touching any
of them.
