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
| a block whose `work()` is **JavaScript** rather than C++ | `blocks/js/<id>.js`, with `flags: [js]` in its `blocks/grc/<id>.block.yml` — see [docs/js-blocks.md](js-blocks.md) |

A JS block is the one entry above that needs no C++ at all: its id binds to one
generic factory through a generated table, and its source is fetched at run time
rather than compiled in, so editing a shipped block is a file copy. Adding one
still relinks, because that generated table is. `gen_registry.py` skips the
generated-C++ path for it for free, because that path is gated on
`"cpp" in flags`. The yml stays authoritative — it
is what gives the block its palette entry, its parameters and its ports, and the
generator fails the build if the descriptor's own port declaration disagrees
with it.

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

- A hand-written factory needs no declaration anywhere else. `gen_registry.py`
  reads the set of custom ids back out of `registry.cpp`'s own factory table, so
  registering one there is what stops a duplicate generated factory being
  emitted for it. Document *why* it is hand-written above the factory itself.
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

### Native output-buffer controls

The editor mirrors GRC's implicit **Min Output Buffer** (`minoutbuf`) and
**Max Output Buffer** (`maxoutbuf`) fields at the top of a block's Advanced tab.
They appear on every DSP block whose definition declares an output port,
including a message output, and do not appear on variables, virtual blocks, or
input-only sinks. Values are counts of output items, not bytes; `0` retains GNU
Radio's allocator default.

The runner applies positive values through `set_min_output_buffer()` and
`set_max_output_buffer()` immediately after constructing each primitive or
hierarchical block, before connecting and starting the flowgraph. Keep that
timing: the scheduler allocates stream buffers while the graph is flattened at
start. These settings size the buffers between blocks; they are distinct from
`set_max_noutput_items()`, which limits a scheduler work call.

### Live setters come from the yaml's callbacks

GRC's own generator re-emits a block's `callbacks:` whenever a parameter's
expression changes; that is how a native flowgraph's Range slider moves a
running block. There is no generator in the browser, so the runner binds a QT
GUI Range straight to an entry in the factory's `numeric_setters` map — see the
parameter loop in [`runner/src/runner.cpp`](../runner/src/runner.cpp), which
looks the setter up **by GRC parameter id** and skips the binding in silence
when there is none. A parameter with no setter is frozen at its
construction-time value while the slider still moves and still publishes, which
is the failure that looks most like a working flowgraph.

`gen_registry.py` therefore emits one setter per translatable callback, so a
generated factory is as live as a hand-written one. Simple callbacks — one
argument that is exactly one numeric parameter
(`set_noise_voltage(${noise_voltage})`) — become direct setters. Compound method
callbacks become one setter per referenced numeric or boolean parameter, backed
by shared state so changing any input recomputes the callback with the latest
values of all the others. That is what makes tap-design callbacks such as
`set_taps(firdes.low_pass(...))` live. Vector, string and enum parameters are not
themselves controllable through the double-valued GUI controls, but their fixed
values may be arguments to a compound callback. Structural parameters are
skipped too: they picked which class was constructed and cannot change on a
running graph. Generator-specific snippets that are not ordinary `set_*`,
`update_*`, or no-argument `reset()` method calls still need a hand-written
factory. If one of those snippets references a numeric or boolean parameter,
generation rejects that block instead of silently emitting a frozen parameter.

Two things about the yaml can break the build, both fixed with the `callbacks`
overlay key (`blocks/overlays/<module>/metadata.yml`), which replaces just the
callback list and leaves the rest of `cpp_templates` alone:

- **Upstream names a method the C++ class does not have.** GRC's Python
  generator only ever emitted the text, so nothing upstream compiled it —
  `digital_mpsk_snr_est_cc` says `set_tag_nsamples`, the class declares
  `set_tag_nsample`. Overlay the corrected list.
- **A Python-only block rebuilt here as a `hier_block2`** cannot expose its
  upstream setters at all, because the factory holds a `hier_block2`, not the
  class the callbacks name. `callbacks: []` is how that rebuild says so; the
  four gr-satellites rebuilds are the worked examples.

Where no `cpp_templates` callback list exists, the Python one is used — the two
agree throughout GNU Radio today, and it is what makes Message Strobe's period
and Probe Rate's alpha live.

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

### The musical keyboard is a source and a widget

`wasm_musical_keyboard_source` combines the SamSonic piano widget with a
hand-written polyphonic source in
[`blocks/src/musical_keyboard_source.hpp`](../blocks/src/musical_keyboard_source.hpp).
The QWidget records pressed roots and chord choices in a mutex-protected note
snapshot; the block's scheduler thread reads that snapshot and emits a mono
float stream. With no active or releasing notes, every emitted sample is exact
zero so the source continues to schedule like any other signal source.

The Qt-free engine in
[`blocks/src/musical_keyboard_synth.hpp`](../blocks/src/musical_keyboard_synth.hpp)
is a small subtractive synth: up to three detuned oscillators per note, PolyBLEP
anti-aliasing for saw and square, an ADSR envelope, a per-note topology-preserving
resonant low-pass filter whose cutoff follows that envelope, and soft saturation
after the polyphonic mix. Its numeric sound controls have matching
`numeric_setters` in the hand-written factory so QT GUI Range blocks can change
them while the graph is running. The waveform and initial chord remain
construction-time choices; the running widget owns subsequent chord changes.

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
- **`isVariableControl()` in `editor/src/validation.ts` is that C++ rule**, spelled
  the same way — the `variable_qtgui_` prefix plus Digital Number Control — so the
  editor cannot decide a block is not a control when the runner decides it is.
  Every editor-side judgement goes through it, including `isControlWidget()` in
  `gui-layout.ts`, which is what picks a one-row tile over a four-row one and has
  to agree with `apply_gui_layout()` for the preview to match the window.
  `VARIABLE_CONTROL_IDS` beside it is the enumerable list of the controls the
  palette offers today, and a case in `editor/test/validation.test.mjs` asserts it
  against blocks.json — it is for listing, never for deciding.

A control's own parameters are read when it is constructed, before any other
control exists, so they cannot reference one — except QT GUI Label's Value, which
is *bound* through a numeric setter rather than read, and so may name a control
and track it. `example_flowgraphs/qtgui/control_widgets.grc` exercises every one
of them.

### The FFT window defaults to rectangular, not Blackman-harris

The Frequency Sink and the Waterfall Sink both take upstream's `wintype`, with
upstream's seven options, but their default here is `window.WIN_RECTANGULAR`
where native GRC's is `window.WIN_BLACKMAN_hARRIS` — an unconfigured sink shows
the unweighted spectrum. The default lives in two places that must agree, since
the editor writes the parameter into every `.grc` it saves but a hand-authored
one may omit it: the schema in `editor/src/block-defs.ts` and the fallback
argument to `window_type_from()` in `registry.cpp`. A `.grc` carrying `wintype`
— native or ours — always wins over both.

Read that parameter through `window_type_from()` and never through
`p.value<int>()` or `number_from()`. It arrives as the *string* `window.WIN_*`,
so an integer read throws (`type_error.302`, or "must be numeric") and takes the
whole flowgraph with it; both sinks had that bug, unnoticed because the editor
was dropping the parameter before the runner ever saw it.

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
runner window. Whether a block *has* a widget is decided in C++, and the block
says so in its metadata with `gui: true` → the `gui` flag in blocks.json, so a
factory that grows a `QWidget` without that declaration silently loses its tile.
See [gui-layout.md](gui-layout.md).

### The block that reads hardware

RTL-SDR Source is the one block whose data comes from a USB device rather than a
file, a URL or another block. It is the same shape as `BrowserFileSource` — a
worker fills a ring in shared WASM memory, `work()` drains it on the source's own
scheduler pthread — with the differences a live source forces: a full ring drops
rather than waits, and the block sends commands *back* through a mailbox so a QT
GUI Range can retune the dongle while the graph runs. Its device permission has
to be obtained under a user gesture before the flowgraph starts, which is why the
editor prompts on the Run click. Read [rtlsdr.md](rtlsdr.md) before touching any
of it.

### The two blocks that reach the sound card

Audio Sink and Audio Source keep gr-audio's ids, parameters and ports over an
entirely different device: gr-audio is not built (there is no ALSA, OSS or
PortAudio in a tab), so `blocks/src/browser_audio.cpp` drives a Web Audio
`AudioWorkletProcessor` through a ring in shared memory instead. Audio Sink is
the flowgraph's clock, exactly as it is natively, by blocking on ring space —
with a wall-clock fallback for the browser's autoplay policy, which can leave a
context suspended until the page is clicked. Read [audio.md](audio.md) before
touching either.

### The three blocks that read a file

File Source, GR World Recording and Public HTTP Recording are all
`BrowserFileSource` over a path the browser resolves a binding through, and they
differ only in where that path comes from — a session-bound local file, an R2
bucket key the *runner's factory* expands, or a public URL the editor rewrites on
the Run path. Read [recording-viewer.md](recording-viewer.md) before touching any
of them.
