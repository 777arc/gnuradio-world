# Recordings: the source blocks, R2, and the recording viewer

Four connected things: the browser-backed source blocks that read bytes, the one
sink block that writes them, the R2 bucket the hosted recordings come from, and
the recording tabs that display them.

`editor/src/recording/` is a focused viewer adapted from IQEngine — the SigMF
URL/blob reader, spectrogram, Time/Frequency/IQ plots, settings, annotations and
the metadata summary bar, and nothing else. IQEngine's plugins, Cyclostationary
view, backends/authentication and Pyodide path are not included, and neither are
its Global Properties and Raw Metadata editors: nothing here writes a
`.sigmf-meta` back. It is a second entry of the editor's own Vite build, emitted
at `/recording/` — there is no separate IQEngine checkout or build step.

`editor/test/recording-tabs.test.mjs` and `editor/test/real-recordings.test.mjs`
pin most of what follows. Neither runs a browser, so a change here also wants the
manual pass described in AGENTS.md's "Run and test".

## The four source blocks

The WASM registry replaces GNU Radio's POSIX-backed `blocks_file_source` with
`blocks/src/browser_file_source.cpp`, which reads a *path the browser resolves a
binding through* rather than a file on a filesystem. Four blocks are that same
class over four kinds of binding, and which one a flowgraph wants is decided by
where its samples are:

| block | parameter | the path it reads | who produces that path |
|-------|-----------|-------------------|------------------------|
| **File Source** (`blocks_file_source`) | `file` — a plain name, as native GNU Radio | `/local-files/<token>/<name>` | the editor's Run path, from the `File` picked with Properties → Browse |
| **SigMF Source** (`wasm_sigmf_source`) | `file` — a base name, no suffix | `/local-files/<token>/<base>.sigmf-data` | the editor's Run path, from the *pair* picked with Properties → Browse |
| **GR World Recording** (`wasm_gr_world_recording`) | `recording` — a bucket base key, `estevez/by701` | `/recordings/<key>.sigmf-data` | the *runner's factory*, from the key itself |
| **Public HTTP Recording** (`wasm_public_http_recording`) | `url` — any public http(s) URL | `/recordings/external/<encoded url>` | the editor's Run path, after probing the URL's size |

File Source is deliberately the native block and nothing more: it has no path
into the bucket and no URL of its own, so a flowgraph that reads a file this
project hosts, or one anybody hosts, says which by the block it uses. **SigMF
Source is kept separate from GR World Recording for the same reason** — both read
a SigMF recording, and the block title on the canvas is what says whether it came
from this computer or from the internet. Merging them would take that away.

GR World Recording's **Output Type is derived, not chosen**: the recording's
SigMF datatype says how its samples are laid out, so picking a recording writes
that parameter and the dialog shows it disabled (a `cf32_le` recording is
`complex`, a `ci16_le` one is `short` feeding IShort To Complex). For the same
reason the chooser lists only recordings whose datatype has a stream type here —
one that does not could not be corrected by hand — and the block has no vector
length at all.

Two consequences worth keeping straight. GR World Recording is the one whose path
the **C++** derives, so the editor rewrites nothing on its Run path and only
registers that path's URL and byte length; `recordingDataPath()` in
[`editor/src/recording-catalog.ts`](../editor/src/recording-catalog.ts) is the
other half of that mapping, and the two spellings have to agree or the reader
looks up a descriptor nobody registered. And every binding is session-only: a
`.grc` keeps the human-readable filename, the recording key or the URL, and never
a browser file handle.

Each running source owns a `browser_file_reader.js` worker. It reads local files
with bounded `File.slice()` calls and remote ones with required HTTP Range
requests, then feeds a fixed 16 MiB ring in shared WASM memory. Individual reads
are capped at 2 MiB, so source memory is independent of recording size. Servers
must return `206` with a matching `Content-Range`; a `200` response is rejected
before its body is consumed. Keep R2's CORS policy in `scripts/r2-cors.json`
configured to allow the `Range` request header and expose `Content-Range` — and
note that a Public HTTP Recording asks the same two things of a host nobody here
controls, which is why the editor probes it (HEAD, then a one-byte range) and
refuses the Run rather than letting the reader fail later.

`test/test_smoke.mjs` covers both backends. Its local-file case selects a sparse
file larger than 4 GiB through the actual editor and reads beyond the 32-bit
boundary; its HTTP case runs a GR World Recording against an endpoint that
refuses non-Range requests and verifies the exact range consumed.

## SigMF Source: metadata as stream tags

SigMF Source is the only local source that reads a recording's *metadata*. A
File Source pointed at a `.sigmf-data` gets `synthesizedSigmfMeta()`, which
infers a datatype from the block's own parameters and has no captures or
annotations to offer; SigMF Source reads the real `.sigmf-meta` beside the
samples.

Three things follow from that, and each is somewhere different:

- **Both files are picked at once.** A browser cannot derive a sibling file from
  a picked `File`, so the dialog's picker is `multiple` and
  [`editor/src/sigmf-blocks.ts`](../editor/src/sigmf-blocks.ts) pairs them by
  base name. Picking one half names the other rather than failing vaguely. The
  pair, and the metadata text read out of it, are bound for the session under the
  block's `localFileToken` in `sigmfBindingsByToken` — a `.grc` keeps the base
  name and nothing else, exactly as File Source keeps a file name.
- **Output Type is derived and disabled**, the same as GR World Recording's, from
  `core:datatype`. A datatype with no stream type here is refused at pick time
  rather than half-configuring the block, because the field could not then be
  corrected by hand. A `ci16_le` recording is a *short* stream — GNU Radio's own
  convention for an interleaved-integer file — so committing the dialog also
  drops an **IShort To Complex** on the canvas already connected to the block's
  output, exactly as the Recordings palette does for a ci16 card
  (`attachIShortToComplex`). It only ever adds: an output that already goes
  somewhere is a flowgraph the reader built, and the dialog's detail line says
  which of the two it is about to do.
- **The tags are built in the runner, not the editor.** The editor ships the
  `.sigmf-meta` *text* alongside the samples (the `meta` field on a local input
  binding); the factory parses it and hands `BrowserFileSource::set_tag_plan()` a
  sorted list of `(pass-relative offset, key, value)`. Keeping it C++-side is what
  lets one specification serve both directions — see below.

The mapping itself lives in two files that share their names and keys:

| file | what it holds |
|------|---------------|
| [`blocks/src/sigmf_tags.hpp`](../blocks/src/sigmf_tags.hpp) | the tag names, the metadata keys, `pmt_to_json()`, the ISO-8601 conversions, and `MetaBuilder` — the *sink* direction. Plain C++ and pmt, no nlohmann, per AGENTS.md's placement rule |
| [`runner/src/sigmf_meta.hpp`](../runner/src/sigmf_meta.hpp) | `json_to_pmt()` and `build_tag_plan()` — the *source* direction, which has to walk a parsed JSON document, so it is factory-side |

Each capture segment emits `rx_freq`, `rx_rate` and `rx_time` — the conventional
names other GNU Radio blocks already look for — plus a `sigmf:capture` dictionary
carrying the whole segment. Each annotation emits one `sigmf:annotation`
dictionary. **Tag offsets are pass-relative**: the block's `offset` parameter is
subtracted and anything before the selection is dropped, so a trimmed selection
tags the right samples and a `repeat` pass re-emits the plan from the top
(`d_tag_cursor` resets where `d_items_into_pass` does).

`test/test_smoke.mjs` runs the whole chain against a Tag Debug, asserting that a
capture past the Offset lands shifted, that an annotation carries its label, and
that a capture *before* the Offset is dropped.

## SigMF Sink: the only block that writes

There is no File Sink in this runner at all — Emscripten's filesystem is
in-memory, so anything written through it dies with the tab. SigMF Sink is the
one block whose bytes leave WASM, and it is the mirror image of the source: a
16 MiB ring in shared memory, the same `Control` struct and futex protocol, and
a worker on the other end.

- [`blocks/src/browser_file_sink.cpp`](../blocks/src/browser_file_sink.cpp) is
  the ring half. **A full ring blocks rather than drops** — the opposite of
  RTL-SDR Source, and correct here: a sink owns its scheduler pthread, so
  stalling it backpressures the flowgraph instead of losing samples, and losing
  samples is the one thing a recording must not do.
- [`blocks/src/sigmf_sink.hpp`](../blocks/src/sigmf_sink.hpp) adds the metadata.
  `on_written()` is called with the range actually accepted, while
  `nitems_read(0)` still addresses it, so `get_tags_in_range()` sees exactly those
  tags. `finish_payload()` builds the `.sigmf-meta` at stop, when the samples are
  finally counted.
- [`runner/src/browser_file_writer.js`](../runner/src/browser_file_writer.js) is
  the worker, with two modes. With the File System Access API it streams into a
  `FileSystemDirectoryHandle` the reader chose, and a recording is bounded only by
  the disk. Without one (Firefox, Safari) it buffers and hands both files back as
  blobs to download, bounded by `MAX_DOWNLOAD_BYTES` — **exceeding which fails the
  run** through the ring's error channel, because a recording silently missing its
  end is the worst outcome available.

**Chrome refuses the Downloads folder itself**, and will say it "contains system
files" — which reads like a bug in this app and is not one. Downloads is on
Chromium's File System Access blocklist as `kDontBlockChildren`, so the folder
cannot be taken as a directory handle while *everything inside it* can: a
subfolder works, and a single file saved into Downloads (an ordinary download) is
unaffected. `pickOutputDirectory()` in
[`editor/src/sigmf-blocks.ts`](../editor/src/sigmf-blocks.ts) is the one place
that opens the picker, and it carries the two options that make this a non-event:
`startIn: 'downloads'` (so the reader is already where they wanted to be, one
"New folder" click from done) and a stable `id` (so Chrome reopens wherever this
app was last pointed, making the choice once per browser rather than once per
run). The picker throws the same `AbortError` whether it was dismissed or a
blocked folder was chosen and then dismissed, so both call sites report
`SIGMF_OUTPUT_PICKER_HELP` rather than guessing which happened.

Three traps worth keeping straight:

- **Stop must be graceful, and the shutdown must not join.** The editor stops a
  flowgraph by unloading the runner iframe, which would kill the writer worker
  with the tail of the capture still in shared memory — and, in buffered mode,
  with the whole of it. So `stop()` posts `gr-shutdown`, `runner.html` calls the
  exported `gr_shutdown_flowgraph()`, and only the acknowledgement unloads the
  frame.

  `gr_shutdown_flowgraph()` calls `g_tb->stop()` and **returns immediately**. It
  must not do what `run_now()` does for a re-run (`stop()` then `wait()`): the
  browser main thread calls it, every block's `stop()` runs on that block's own
  scheduler thread, and `BrowserFileSink::stop()` makes a proxied
  `MAIN_THREAD_EM_ASM` call from there. Joining on the main thread deadlocks
  outright — the block waits for the main thread to run its JS, the main thread
  waits for the block to exit — and it does so for *any* flowgraph, not just one
  with a sink. What `runner.html` waits for instead is `__grSinkStats` reporting
  every writer's file closed, which is the only part of a shutdown that unloading
  the frame would actually lose; a flowgraph with no writer acknowledges on the
  first poll. The main thread never blocks, so the tab stays responsive while the
  recording finishes.

  On the editor side `stop()` stays *synchronous* — `loadFlowgraphAnimated()`
  needs the tab switch immediately — and only the unload is deferred, guarded by a
  `runGeneration` counter so a late unload cannot blank a newer run's frame.
- **The finish handshake is two messages.** `FINISHING` (an atomic) and the
  `.sigmf-meta` (a `postMessage`) are sent separately and either can land first,
  so the worker closes the file only once it has both. For the same reason the
  worker polls an empty ring with `await sleep()` rather than `Atomics.wait()`,
  which would block its event loop and never deliver that message.
- **`__grStopBrowserFileSink` defers its `terminate()` by a turn.** On the normal
  path the worker has already closed itself and posted its result — which in
  buffered mode *carries the blobs* — and that message is still queued when the
  block's `stop()` reaches the main thread.

Both output paths are covered on plain Node by
`runner/test/browser_file_writer.test.mjs`; neither is reachable from a headless
browser, since `showDirectoryPicker()` needs a real user gesture and a download
is not observable. The C++ half wants the manual pass in AGENTS.md.

## R2 recording source of truth

Production recordings live only in the Cloudflare R2 bucket
`gnuradio-wasm-recordings`, whose public custom domain is
`https://recordings.gnuradioworld.com`. The browser cannot address an R2 bucket
by its bucket name; it uses that HTTPS domain. The editor defaults to this base,
with `VITE_RECORDINGS_R2_BASE` available as a build-time override.

[`workers/sigmf-indexer/`](../workers/sigmf-indexer/) is bound to the bucket as
`RECORDINGS`. R2 object-create notifications for `.sigmf-data` and `.sigmf-meta`
enter `gnuradio-world-sigmf-events`; its consumer batches up to 100 notifications
for up to 60 seconds and performs one rebuild per batch. The rebuild lists every
object, pairs keys with the same base and SigMF suffixes, reads the metadata,
derives byte and sample counts, and replaces the bucket's `index.json`. A 09:00
UTC daily cron provides a fallback, and its authenticated `POST /rebuild`
endpoint performs the same job on demand.

The editor fetches that live index with `cache: no-store`, then constructs both
object URLs from each base key. Each card in the palette offers three things: the
card itself drops a GR World Recording (plus an IShort To Complex for `ci16`) on
the canvas, **View** opens the recording view alone, and 🔗 copies
`#recording=<base key>` — the same base key the index calls `base_filename`, and
the same one the block stores, so a link is readable and survives a re-index.
View and 🔗 are offered even when the datatype has no block representation, since
that recording is otherwise not viewable here at all. `server.mjs`,
`scripts/assemble-site.mjs`, and Cloudflare Pages never build or serve a
recording manifest, and no recording is ever checked into this repository.

To publish a recording, upload both matching objects directly to R2 using the
dashboard, the S3-compatible API, rclone, or another R2 client. The event batch
normally refreshes the index within about one minute; the daily and manual paths
remain fallbacks. Collection prefixes are part of the base key:
`estevez/ao73.sigmf-data` pairs with `estevez/ao73.sigmf-meta`. No checkout,
commit, editor rebuild, or Pages deploy is part of this workflow.

### CORS is a manual step

Keep [`scripts/r2-cors.json`](../scripts/r2-cors.json) applied to the bucket.
Committing the file changes nothing, and no workflow applies it:

```bash
# Node 20 cannot run wrangler v4. Needs a token with Workers R2 Storage: Edit,
# which the CI Pages token deliberately does not have -- `wrangler login` is the
# easy path. `set` REPLACES the whole policy, so diff `list` against the file
# first: an origin added through the dashboard and never committed back is
# dropped silently.
npx wrangler@3 r2 bucket cors list gnuradio-wasm-recordings
npx wrangler@3 r2 bucket cors set  gnuradio-wasm-recordings --file scripts/r2-cors.json
```

It allows the production origins, `https://*.gnuradio-world-previews.pages.dev`
(every PR preview) and `http://localhost:8090`, permits GET/HEAD and Range
requests, and exposes `Content-Length`/`Content-Range`. Local testing must use
`http://localhost:8090/`, matching that exact allowed origin. An origin missing
from this list is the one failure that looks like a working build: the editor
loads and flowgraphs run, and only the Recordings palette, GR World Recording's
range reads and recording tabs fail, as CORS errors in the console pane.

## Recording tabs

Every block with something to show — a GR World Recording, or a File Source
bound to a local file — gets its own workspace tab holding the recording view for
it, added when a recording is clicked in the palette, when an example that
references one is opened, or when a file is picked with Properties → Browse. A
Public HTTP Recording gets none: raw bytes at a URL are not a SigMF recording,
and nothing here knows how to describe them. A recording can also be viewed *without* being put on the canvas at all,
which is the one kind of tab no block owns. Each tab is an `<iframe>` on the
viewer at `/recording/`, driven through its base64url URL route
(`recordingViewUrl()` in `editor/src/main.ts` builds it). The rules that keep it
working:

- **The tab set is derived state.** `syncRecordingTabs()` rebuilds it from
  `insts` at the end of every `render()`, so no mutation path has to remember to
  update it, and nothing about a tab reaches the `.grc`. It must stay synchronous
  and network-free: a remote tab's label comes from the block's own recording
  key, not from the R2 recording index.
- **A pinned tab is the exception**, and the only one. The Recordings palette's
  **View** control and the `#recording=<base key>` link both open a recording
  view for a recording nothing on the canvas refers to, so `openRecordingPreview()`
  sets `pinned` and the sync destroys only unpinned tabs it no longer wants. Such
  a tab carries a `×`, shown exactly while no block owns its recording —
  the tab bar is `.workspace-tab-group`, a tab button plus that sibling button,
  because a `<button>` cannot contain one. Both origins key the tab by the same
  `/recordings/...` path `recordingSourceFor()` derives from a GR World Recording, so
  adding the block for a previewed recording *adopts* its tab (the `×` disappears)
  rather than opening a second one, and deleting the block hands it back.
- **`#recording=` composes with `#example=` rather than replacing it.** The
  fragment names two independent things — the flowgraph on the canvas and a
  recording open beside it — so `setUrlFragment()` rewrites one key at a time over
  a whitelist (the one-shot `#fg=`/`#duplicate=` keys are consumed and dropped
  before it runs), and `openRecordingFromUrl()` runs after `loadFlowgraphFromUrl()`
  and reports separately whether it opened anything. A link naming only a
  recording therefore leaves the canvas empty instead of loading the default
  example. Recording keys keep their `/` literal (`encodeRecordingPath`, not
  `URLSearchParams.toString()`) so a copied link stays readable.
- **The iframe is created on first activation, never at sync time.** That defers
  both the viewer bundle (later tabs hit the HTTP cache) and the recording's
  samples. Once created it is kept, so revisiting a tab refetches nothing.
- **Inactive recording panes hide with `visibility:hidden`, not the `hidden`
  attribute.** `display:none` collapses an iframe to zero size, and the viewer sizes
  its spectrogram off the window it is in; it would come back sized for nothing.
  Panels are also never re-inserted into the DOM when tabs reorder — moving an
  iframe reloads the document inside it — so only the buttons are reordered.
- **A SigMF Source's tab uses the recording's real metadata.** It is the only
  local source that has any, so its tab is handed the actual `.sigmf-meta` text
  rather than a synthesized one, and shows the recording's genuine sample rate,
  centre frequency and — uniquely — its own annotation boxes on the spectrogram.
  Everything below applies to a File Source, which has no metadata to show.
- **A local file has no SigMF metadata**, so `synthesizedSigmfMeta()` writes a
  minimal one from the File Source: datatype from its `type` param (a `short`
  or `byte` source whose only sink is an interleaved-to-complex converter is
  `ci16_le`/`ci8`, the chain the recordings tab builds), sample rate from the
  flowgraph's `samp_rate` when it is numeric, and the sample count from the
  file size. Both it and the file itself are handed over as `blob:` URLs, which
  Chrome answers with `206`/`Content-Range` exactly like an HTTP recording, so a
  multi-gigabyte local file is still read in bounded pieces. The pane labels the
  metadata as inferred.
- **Real-valued recordings** (SigMF's `r*` datatypes — an `rf32_le` File Source
  of type `float`, an `ri16_le` one of type `short`, and so on) are supported by
  widening each sample to the interleaved I/Q the rest of the viewer works on,
  with Q = 0, in `convertToFloat32()`. That is deliberately the *only* place the
  difference lives: the FFT of a signal with no imaginary part is
  Hermitian-symmetric, so the spectrogram and frequency plot show the negative
  half mirroring the positive one — which is exactly what a real recording should
  look like — with no changes to either. `dataTypeToBytesPerIQSample()` is the
  other half: a real sample is one component, not two, so `ri16_le` is 2 bytes
  where `ci16_le` is 4, and every byte offset, sample count and range read
  follows from it. The Time plot drops its Q trace and labels the remaining one
  "Real", and the IQ plot says why every point is on the I axis — unless the
  frequency shift is on, which mixes a real signal down to a genuinely complex
  one and makes both meaningful again.

## Viewer styling

- **Under 768px the settings stack below the plot instead of beside it.** That
  is tailwind's `md`, and it is written in two places that have to agree: the
  `md:` flex-direction variants in `recording-view.tsx` and `sidebar.tsx`, and
  `NARROW_LAYOUT_WIDTH` in `utils/constants.ts`, which the spectrogram sizing
  reads because it is computed in JS where a media query is out of reach.
  Stacked, the plot is no longer sharing width with a 256px settings column —
  subtracting the wide layout's 430px would leave it a *negative* width on a
  390px screen — and its 650px minimum height would push every control below the
  fold, so `MIN_STACKED_SPECTROGRAM_HEIGHT` applies instead. The order is
  `flex-col-reverse`: source order stays settings-first, so the plot chooser at
  the top of the settings pane still sits directly under the plot it chooses.
  This is the only breakpoint the viewer may have, as the editor has exactly one
  of its own.
- **The viewer has exactly one text size**: the editor's own chrome font,
  system-ui at 13px. The rules are the un-layered block at the top of
  [`editor/src/recording/features/ui/styles/tailwind_index.css`](../editor/src/recording/features/ui/styles/tailwind_index.css)
  — un-layered because daisyUI hard-codes a font-size on `.input`, `.label-text`,
  `.btn`, `.tab`, `.menu` and `.table` from the components layer, which any
  `@layer base` rule loses to. Size is set on `body` in px and never on `:root`,
  so tailwind's rem-based spacing and widths (the sidebar's `w-64`, and the px
  offsets in `recording-view.tsx` hand-tuned against it) stay put. Text drawn on
  a canvas inherits none of that, so the konva labels (rulers, selectors,
  annotations) and `CanvasPlot`'s axes read `APP_FONT_FAMILY`/`APP_FONT_SIZE`
  from [`editor/src/recording/utils/constants.ts`](../editor/src/recording/utils/constants.ts)
  instead. Prefer those over a new `text-*` utility.
- **The viewer's colors are the editor's, not IQEngine's.** The daisyUI theme in
  [`editor/tailwind.config.cjs`](../editor/tailwind.config.cjs) maps every token onto
  a color taken from `editor/index.html`, plus an `extend.colors` set — `field`,
  `line`, `raised`, `selected`, `muted` — for the chrome colors daisyUI has no
  token for. Style with those tokens rather than a literal hex, and if the
  editor's chrome changes, change them here too. Two places CSS cannot reach need
  the values spelled out: `CanvasPlot`'s theme constants and colorway, and the
  konva chrome (rulers, the minimap scrollbar) which reads `APP_TEXT_COLOR` and
  friends from `utils/constants.ts`. Konva overlays drawn *on the spectrogram* —
  annotation boxes, the freq/time cursors — keep their high-contrast
  white/red/blue instead, because they sit over an arbitrary colormap.
- **The Time/Frequency/IQ tabs draw on a plain 2D canvas, not plotly.** Upstream
  uses `react-plotly.js`, which is ~4.7 MB — several times the rest of the viewer
  — for one trace type, and its size is why upstream loads those three tabs
  lazily. [`editor/src/recording/features/ui/canvas-plot/CanvasPlot.tsx`](../editor/src/recording/features/ui/canvas-plot/CanvasPlot.tsx)
  replaces it: same theme, ticks, hover readout, mode bar, legend and range
  slider, plus pan/wheel-zoom/double-click-autoscale and plotly's `uirevision`
  rule (new data re-autoranges only while the reader has not zoomed). Dense
  traces use min/max decimation, one vertical segment per pixel column, which is
  what keeps the Time tab's ~650k points per trace at a few ms a frame. It is
  repo-owned code, so it is the one file under `src/recording/` that has no
  upstream counterpart to diff against.
