# Audio Sink and Audio Source: the sound card, through Web Audio

Read this before touching `blocks/src/browser_audio.{hpp,cpp}`,
`runner/src/audio_worklet.js`, the `audio_sink` / `audio_source` factories in
[`runner/src/registry.cpp`](../runner/src/registry.cpp), or
[`editor/src/audio.ts`](../editor/src/audio.ts).

The two blocks keep upstream's ids, parameters and ports — a `.grc` written for
native GNU Radio runs here unchanged, and one written here opens natively. What
is different is everything under them.

## What this is, and what it is a copy of

**gr-audio is not built at all.** There is no ALSA, OSS, JACK or PortAudio in a
browser tab, so the GNU Radio configure line sets `-DENABLE_GR_AUDIO=OFF` (see
[building.md](building.md)) and there is no `audio::sink` class to call. The two
block ids are therefore *hand-written factories* over Web Audio, in the same
place every other browser-backed block lives:

| gr-audio (ALSA sink, say) | here |
|---|---|
| `snd_pcm_writei` on the device | an `AudioWorkletProcessor` on the browser's audio thread |
| the device's period buffer | a ring in shared WASM memory |
| blocking write = the flowgraph's clock | blocking on ring space = the same |
| `ok_to_block` false → drop and count | the same, plus wall-clock pacing |
| an ALSA device name (`plughw:0,0`) | a browser media-device label or id |
| device rate ≠ requested rate → error | the worklet resamples, and says so |

The shared ring is sized for 50 ms at the flowgraph rate, with a floor of four
128-frame render quanta. Audio Sink normally keeps it full, so its depth is also
the steady-state device-queue latency. Inter-block `minoutbuf`/`maxoutbuf`
settings are separate GNU Radio buffers upstream of this ring.

Within the repository the direct template is the pair
[`BrowserFileSource`](../blocks/src/browser_file_source.cpp) and
[`RtlSdrSource`](../blocks/src/rtlsdr_source.cpp): a producer or consumer living
in another JavaScript realm, a fixed-size single-producer/single-consumer ring in
shared WASM memory, and `emscripten_futex_wait` where a native block would take a
condition variable. The differences that matter here are that the other realm is
the **audio rendering thread** rather than a Web Worker — it is real-time, it is
called once per 128-frame quantum, and it must never block — and that the sink,
uniquely, is *supposed* to block the flowgraph, because that is what makes it the
clock.

## The four layers

```
editor (parent frame)   getUserMedia() on the Run click; relays later gestures
      │
      │  .grc via runner.html#<grc>
runner.html (iframe)    __grStartAudio → AudioContext + addModule + AudioWorkletNode
      │
      │  processorOptions { memory, ringPointer, controlPointer, … }
audio_worklet.js        process() every 128 frames, on the audio thread
      │
      │  shared WASM memory + Atomics
BrowserAudio{Sink,Source}::work()   futex wait → interleave / deinterleave
```

### The control block

`struct Control` in `browser_audio.hpp` and the `CTRL` indices in
`audio_worklet.js` are **one layout in two files**. Adding a field means editing
both, in the same order. Every field has exactly one writer: the block owns the
ring position it advances, the worklet owns the other one and all four counters.

### Why `start()` proxies and `work()` does not

`start()` runs on GNU Radio's scheduler-launch pthread and uses
`MAIN_THREAD_EM_ASM_INT` to reach `window.__grStartAudio`, because an
`AudioContext`, `audioWorklet.addModule()` and `getUserMedia()` are all
main-thread operations. `work()` never proxies: it blocks on
`emscripten_futex_wait` on the block's own scheduler pthread, where blocking
stalls nothing else.

The launch call returns an id **immediately** and finishes opening the device
afterwards — the module fetch and the microphone prompt are both promises, and a
GNU Radio constructor cannot await one. Until the device is there the ring simply
stays where it is; a failure is written into the error buffer and the state word,
and `work()` raises it as a `std::runtime_error` the `BrowserLogSink` shows.

## The autoplay policy is the whole UX problem

A browser will not let an `AudioContext` start until the page has been
interacted with, and the interaction that starts a flowgraph is a click on
**Run**, in the *editor's* document, several frames and several awaits before any
block is constructed. So the context can perfectly well come up `suspended`.

Two things about that are worth knowing before touching any of it:

- **`ctx.resume()` does not reject when it is refused. It never settles.** So
  nothing in `runner.html` awaits it: it calls `resume()`, gives it 500 ms, and
  then judges by `ctx.state`. An `await ctx.resume()` anywhere in this path is a
  hang, not an error, and it is a hang inside the flowgraph's start-up.
- **The flowgraph must not stop for it.** Audio Sink blocks on ring space, and a
  context that never started never drains the ring — which would freeze the whole
  graph, plots included, over nothing but sound. Instead the sink falls back to
  **pacing by the wall clock and discarding**, so the graph runs at its real rate
  and the sound simply joins in when the context opens. That fallback is also
  what `ok_to_block: False` selects permanently.

What the reader sees: the runner posts `gr-audio-blocked` to the editor, which
logs one line asking for a click and, from then on, relays every click and
keypress down as `gr-audio-resume` until the runner answers `gr-audio-running`
([`installAudioResumeRelay`](../editor/src/audio.ts)). The runner listens for
gestures in its own frame too. Nothing about this is testable headlessly, which
is why the test harness sets `--autoplay-policy=no-user-gesture-required`
instead — see "Testing" below.

## Permissions

Microphone permission is granted **in the editor, on the Run click**
(`prepareAudioCapture`), exactly like a WebUSB grant and for the same reason: a
prompt that is not attached to something the reader just did is a prompt they
have no idea what to do with. The stream it opens is stopped immediately — all
that call wants is the permission, which is stored per origin and outlives the
tab, so the runner frame's own `getUserMedia()` is answered from it without a
second prompt. No `MediaStream` ever crosses a frame boundary.

`allow="microphone"` is on the `runFrame` iframe in `editor/index.html`. The
`microphone` permission policy defaults to `self`, so a same-origin frame would
inherit it anyway; being explicit is what makes the *embedded* case (`?embed=1`,
cross-origin host) fail legibly. A cross-origin embedder must grant `microphone`
on its own iframe or Audio Source cannot work there at all.

## The sample rate

`runner.html` constructs the `AudioContext` with the flowgraph's own sample rate
(`new AudioContext({ sampleRate })`), which every current browser honours across
3 kHz–384 kHz and resamples to the hardware rate far better than anything here
would. The worklet's linear-interpolation path exists only for the case where a
browser refuses and hands back a different `sampleRate`: without it the audio
would play fast or slow, which is a silent, plausible-sounding failure. The block
prints the rate it actually got, and says when it is resampling.

`samp_rate` is not a live setter on either block. A running graph's rates are
already baked into every block around it, and an `AudioContext`'s rate cannot
change at all once it exists.

**One `AudioContext` per (rate, output device), shared by every block that
matches** — not one per block. A flowgraph that both captures and plays is then
running on a single audio clock, so its source and sink cannot drift apart over a
long run; it also stays well clear of the browser's limit on hardware contexts.

## Channels

`num_inputs` / `num_outputs` are upstream's, and each is one GNU Radio stream
port of floats. The ring is interleaved, because that is the layout a render
quantum wants to deinterleave into its output channels.

A capture device rarely gives exactly what was asked for: Chrome's fake device
gives two channels whatever the constraint says, and most microphones are mono.
The worklet copies the last channel the device does have into any the block still
wants, which is what every other audio tool does with a mono source, and the
block prints the device's own count when it differs.

## Underruns, overruns and what they mean

- **Audio Sink underrun** — the worklet found fewer frames in the ring than a
  quantum needs. It plays a whole silent quantum rather than a partial one, so
  the stream resumes in phase, counts the event, and the block prints on a
  doubling schedule (1st, 2nd, 4th, 8th…). It means the flowgraph is not keeping
  up with real time, which is a DSP problem rather than an audio one.
- **Audio Source overrun** — the ring was full when the microphone delivered.
  A live capture cannot be told to slow down, so the frames are dropped and
  counted, exactly as the USB radios do.
- **Audio Sink dropping** — only ever in the paced fallback above (`ok_to_block`
  off, or nothing draining the ring), counted in `lost_frames`.

`window.__grAudioStats` carries the running totals and `ringFrames`, one entry per block; see
[diagnostics.md](diagnostics.md).

## Testing

`test/fixtures/audio_devices.grc` is the smoke case, and it runs both directions
at once: a tone into the output device and Chrome's fake microphone into a probe.
Nothing about it is mocked — it is the real `AudioContext`, the real worklet, the
real ring and the real futex handoff — because headless Chrome renders Web Audio
in real time against a null output device.

Three flags in `scripts/browser-test-support.mjs` make that possible, and all
three are needed:

```
--autoplay-policy=no-user-gesture-required   # a headless run has no gesture to give
--use-fake-device-for-media-stream           # a microphone that plays a tone
--use-fake-ui-for-media-stream               # granted without a prompt
```

`expectLogs` asserts the rate each block reports, which is the one thing a
"blocks moved items" pass cannot see: a flowgraph whose audio never started still
moves items, paced by the sink's wall-clock fallback.

`runner/test/audio_worklet.test.mjs` covers the worklet's own arithmetic on plain
Node in a second — the ring handoff, the underrun and overrun counters, a mono
device feeding a stereo block, and **both resampling paths**, which are otherwise
unreachable: they need a browser that refuses the flowgraph's sample rate. It
drives the processors directly against a plain `ArrayBuffer` standing in for the
shared heap, so it needs neither a browser nor cross-origin isolation.

`example_flowgraphs/audio/` holds four examples — a tone with live frequency and
volume controls, a microphone spectrum analyser, a SamSonic keyboard synth, and
a broadcast FM receiver demodulating a hosted recording to the speakers — and
all four are run through the real editor
(`node scripts/run_example.mjs audio/audio_tone.grc`), which is the only path
that covers `prepareAudioCapture` and the iframe's `allow`.

The FM receiver reports a burst of Audio Sink underruns at start-up and none
after: the ring is empty until the recording source's first HTTP range request
lands, which is longer than a render quantum. A count that keeps *growing* is
the real "not keeping up" this message is for.

### Still by hand

Everything the autoplay flag turns off, which is to say the entire gesture
story: that a flowgraph started without a prior click stays silent but keeps
running, that the editor says so, and that a click anywhere then starts the
sound. Also that the sound is *right* — a headless run proves frames moved, not
that a 440 Hz tone came out at 440 Hz.

## Deliberate omissions

- **No `setSinkId` picker in the Properties dialog.** Device Name is a text
  field, as it is natively. A picker would need an `enumerateDevices()` whose
  labels are only readable after a microphone grant, which is a lot of machinery
  for a parameter almost every flowgraph leaves blank.
- **No volume control.** Neither has one natively; a Multiply Const is the
  flowgraph's answer, and is live through a QT GUI Range.
- **No recording tab.** The tab-per-source rule in `main.ts` comes from blocks
  that read a *recording*; a live capture has nothing to show a spectrogram of
  before it runs.
