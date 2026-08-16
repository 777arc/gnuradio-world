# RTL-SDR Source: a radio on this computer, over WebUSB

Read this before touching `blocks/src/rtlsdr_source.{hpp,cpp}`,
`runner/src/rtlsdr_reader.js`, `editor/src/rtlsdr.ts`, or the `wasm_rtlsdr_source`
factory in [`runner/src/registry.cpp`](../runner/src/registry.cpp).

The block receives from an RTL2832U dongle plugged into the machine running the
browser. There is no server and no native helper: Chromium's WebUSB API gives a
web page the same vendor control transfers and bulk reads librtlsdr issues, and
everything above that is this repository's.

## What this is, and what it is a copy of

**Structurally it is gr-osmosdr's `rtl_source_c` with the producer moved into
JavaScript.** That is the most useful thing to know about it, because every
design decision follows from the comparison:

| gr-osmosdr / librtlsdr | here |
|---|---|
| libusb event thread | a dedicated Web Worker (`rtlsdr_reader.js`) |
| `rtlsdr_read_async`, 15 transfers in flight | a queue of `TRANSFER_DEPTH` (4) `transferIn()` promises |
| `DEFAULT_BUF_LENGTH` = `16*32*512` = 262144 | the `bufflen` parameter, same default |
| `_buf` circular buffer on the heap | a ring in WASM linear memory, seen through `SharedArrayBuffer` |
| `_buf_mutex` + `_buf_cond` | `Atomics.notify` / `emscripten_futex_wait` |
| overflow counter, prints `O` to stderr | `overruns` in the control block → console pane and `__grUsbStats` |
| `work()` waits on the condvar, converts u8 → `gr_complex` | the same, with a futex |

The condition variable had to become a futex on shared memory for one reason:
the producer runs in a different JavaScript realm and cannot take a C++ mutex.

Within the repository the direct template is **`BrowserFileSource`**
([`blocks/src/browser_file_source.cpp`](../blocks/src/browser_file_source.cpp) +
[`runner/src/browser_file_reader.js`](../runner/src/browser_file_reader.js)),
which already solved async browser I/O feeding a synchronous `work()`. This block
is that pattern with three changes, each of which is the interesting part:

- the ring item is a raw 2-byte IQ pair, not the output item;
- a full ring **drops** rather than waits, because a radio cannot be told to slow
  down;
- commands travel the other way, through a mailbox in the same control block.

### Where the driver code came from

The RTL2832U register protocol and the R820T/R828D tuner drivers in
`rtlsdr_reader.js` are ported from:

- **[jtarrio/webrtlsdr](https://github.com/jtarrio/webrtlsdr)** — Apache-2.0. The
  structure (an `R8xx` base with `R820T` and `R828D` deltas), direct sampling,
  the bias tee, and the RTL-SDR Blog V4 upconverter handling all come from here.
  It is the best-maintained browser RTL-SDR driver and the only one that covers
  the V4.
- **[sandeepmistry/rtlsdrjs](https://github.com/sandeepmistry/rtlsdrjs)** —
  Apache-2.0. The demodulator init sequence and the control-message shape.
- Both descend from **Google's 2013 Radio Receiver Chrome App**, whose copyright
  headers the ported files still carry, and the magic numbers ultimately come
  from **the rtl-sdr project** itself.

Apache-2.0 is one-way compatible into this repository's GPL-3.0. Keep the
attribution headers in place.

### Other projects in this space, for orientation

Every other browser SDR is *JavaScript-driven*: JS owns the sample loop and calls
into a DSP routine. [BrowSDR](https://github.com/jLynx/BrowSDR) (HackRF, Rust/WASM
DSP in workers), [hackrf-sweep-webusb](https://github.com/cho45/hackrf-sweep-webusb),
[Radio Receiver](https://github.com/jtarrio/radioreceiver) and
[aicodix's example](https://www.aicodix.de/example8/) are all shaped that way.
This project is the other way round — a compiled scheduler owns the loop and has
to be *fed* — which is why none of them is a good model for anything but the
driver layer, and why the closest analogue is native gr-osmosdr rather than
anything that runs in a tab.

The remaining alternative is compiling librtlsdr itself with
[libusb's Emscripten/WebUSB backend](https://web.dev/porting-libusb-to-webusb/).
That is a real option and it needs **JSPI** (or the older Asyncify) so
synchronous C can await a promise. It was rejected here: stack-switching
instrumentation is a whole-program property and this runner is a `MAIN_MODULE`
with `dlopen`'d side modules. Nothing in the current build uses JSPI or Asyncify,
and this block does not change that — the async boundary is crossed by shared
memory, not by suspending a stack.

## The four layers

```
editor (parent frame)   requestDevice() on a user gesture; the .grc keeps a serial
      │
      │  .grc via runner.html#<json>
runner.html (iframe)    __grStartRtlSdrSource → new Worker(rtlsdr_reader.js)
      │
      │  postMessage { memory, ringPointer, controlPointer, … }
rtlsdr_reader.js        getDevices() → RTL2832U init → transfer loop → ring
      │
      │  SharedArrayBuffer + Atomics
RtlSdrSource::work()    futex wait → u8 → fc32/sc16/sc8
```

### The control block

`struct Control` in `rtlsdr_source.hpp` and the `CTRL` indices in
`rtlsdr_reader.js` are **one layout in two files**. Adding a field means editing
both, in the same order. Every field is written by exactly one side except the
command slots, which only the block writes and only the worker reads.

### Why `start()` proxies and `work()` does not

`start()` runs on GNU Radio's scheduler-launch pthread and uses
`MAIN_THREAD_EM_ASM_INT` to reach `window.__grStartRtlSdrSource`, because
`new Worker()` is a main-thread operation. `work()` never proxies: it blocks on
`emscripten_futex_wait` on the source's own scheduler pthread, where blocking
stalls nothing else. Do not try to open the device in the constructor — that runs
on the browser main thread, which cannot block in a non-Asyncify build.

## Permissions, and why the Run button is where the prompt lives

`navigator.usb.requestDevice()` requires **transient user activation**. A GNU
Radio constructor has none, and neither does a worker. So:

1. **Edit time** — the Properties dialog's Select button calls `requestDevice()`
   under the click and writes the chosen dongle's `serialNumber` into the block's
   `device` parameter.
2. **Run time** — `prepareRtlDevices()` in [`editor/src/rtlsdr.ts`](../editor/src/rtlsdr.ts)
   runs *first thing* inside the Run handler, before any other `await`, and
   prompts if the permission is missing. This is the only reason it is placed
   where it is; moving it after another `await` would consume the activation.
3. **Run time, in the worker** — `navigator.usb.getDevices()` re-acquires the
   device. **No `USBDevice` object crosses a frame or a worker boundary.** The
   permission is granted per *origin* and outlives the tab, so the worker simply
   asks for it again and matches on serial number.

That last point is what makes this simpler than the local-file path: a File has
to be bound for the session under a token, a USB permission does not.

Two consequences worth remembering:

- **`allow="usb"` is on the `runFrame` iframe** in `editor/index.html`. The `usb`
  permission policy defaults to `self`, so a same-origin frame would inherit it
  anyway; being explicit is what makes the *embedded* case (`?embed=1`,
  cross-origin host) fail legibly instead of as a bare `NotFoundError`. A
  cross-origin embedder must grant `usb` on its own iframe or the block cannot
  work there at all.
- **A dongle with no serial number** leaves `device` empty, which means "first
  available". Two unlabelled dongles cannot be told apart; that is a property of
  the hardware, not of this code.

## The transfer loop

```js
while (pending.length < TRANSFER_DEPTH) pending.push(rtl.readSamples(bufflen));
const chunk = await pending.shift();   // head of line → strictly ordered
```

Awaiting the *head* of a queue rather than running N independent loops is what
guarantees ordering. (`webrtlsdr` runs two independent loops, which is ordered in
practice because URBs complete in submission order, but not by construction.)

Three things this must keep doing:

- **`resetBuffer()` before the first read**, and after any sample-rate change:
  two writes of `0x0210` then `0x0000` to `USB_EPA_CTL`. Skip it and the stream
  opens on stale FIFO contents.
- **Re-derive every view after every `await`.** `ALLOW_MEMORY_GROWTH` can detach
  `memory.buffer` while a transfer is in flight. The same trap is commented in
  `browser_file_reader.js`.
- **Carry an odd trailing byte.** A truncated bulk read would otherwise swap I
  and Q for the rest of the session. It should never happen — the endpoint
  delivers whole 512-byte packets — but the failure mode is silent and total.

### Overruns

A ring that fills loses samples, and that is the honest outcome: blocking the
worker would just move the overflow into the dongle's own FIFO where nothing
reports it. The reader drops the transfer, counts it, and the block prints on a
doubling schedule (1st, 2nd, 4th, 8th…) so the first loss is visible and a storm
does not flood the console pane. `window.__grUsbStats` carries the running
totals; see [diagnostics.md](diagnostics.md).

The ring is sized from the sample rate for about half a second of buffering. A
deeper one only delays the moment losses start; a shallower one loses on any
scheduler hiccup.

## Live retuning

`BuiltBlock::numeric_setters` binds `center_freq`, `gain`, `gain_mode`,
`freq_correction` and `bias_tee` by GRC parameter name, so a QT GUI Range
referencing one of them retunes the dongle while the graph runs.

A setter cannot issue USB traffic itself, so it stages values in the command
mailbox and bumps `cmd_seq` (release). The worker reads the slots between
transfers under a seqlock — read `cmd_seq`, read the slots, re-read `cmd_seq`,
retry if it moved — and applies only the fields that changed. Retuning walks the
tuner PLL behind an I²C repeater, which is far too expensive to redo on every
poll.

**The endpoint queue is drained before any command is applied.** A control
transfer issued while several large bulk reads are queued on the same device
fails on Windows/WinUSB, and it fails on the *first* write a retune makes — the
I²C repeater — so it surfaces as `control write failed for register 0x120 in
block 0x1` from a dongle that was streaming perfectly a moment earlier. The
stream loop therefore checks `commandWaiting()` before refilling the queue,
delivers what is already in flight, applies the command against an idle
endpoint, and refills. The cost is a few milliseconds of samples, which
retuning loses on real hardware anyway.

**And it calls `resetBuffer()` afterwards.** A retune walks the tuner's PLL
behind the I²C repeater, which takes long enough that nothing drains the
dongle's FIFO and it overflows — the same condition `resetBuffer()` clears
before the first read. Leaving it uncleared has a memorable signature: the
retune that caused the overflow *succeeds*, and the next one fails on the
repeater write, so the error points at a retune that was fine and away from the
one that wedged the device. The carry byte is dropped with it, since the FIFO no
longer holds its partner.

**`samp_rate` is deliberately not a live setter.** Changing it needs a demod
reset and a buffer reset while GNU Radio's rate assumptions are already baked
into the running graph. This has a consequence for flowgraphs: the QT GUI sinks
*do* track `samp_rate` live, so wiring a runtime control to it rescales both
plots while the dongle keeps sampling at the old rate — a wrong axis rather
than no effect. Drive the rate from a plain `variable`, as
`example_flowgraphs/rtlsdr/rtlsdr_simple.grc` does.

The opening configuration goes through the same mailbox: the constructor stages
it with `cmd_seq = 1`, so the worker has one code path rather than two.

## Sample formats

The dongle produces unsigned 8-bit IQ pairs, offset around 127.4 rather than 128
— gr-osmosdr uses the same centre. `work()` converts with a 256-entry LUT:

| Output Type | items per IQ pair | conversion |
|---|---|---|
| `complex` | 1 `gr_complex` | `(v - 127.4) / 128` |
| `short` | 2 interleaved `int16` | `(v - 128) << 8` |
| `byte` | 2 interleaved `int8` | `v - 128` |

The interleaved forms follow the convention GNU Radio uses for ci16/ci8 files —
feed them to IShort To Complex — and are the same convention
`wasm_gr_world_recording` follows. They call `set_output_multiple(2)`, without
which a `work()` producing an odd count would put Q where the next I belongs.

## Testing without hardware

CI has no dongle, so `Device` accepts **`fake`** or **`fake:<tone Hz>`**, which
selects `FakeRtl` in the worker: a paced complex tone, no USB at all. It drives
the ring, the futex handoff, the command mailbox and the conversions — the whole
block except the register protocol.

`test/fixtures/rtlsdr_fake.grc` is the smoke case. Its `expectLogs` asserts the
*reported* rate, which is the one thing a "blocks moved items" pass cannot see:
the RTL2832U divides a 28.8 MHz clock, so a graph running at the wrong rate still
moves plenty of items.

`FakeRtl` claims its deadline **before** its first `await`. `TRANSFER_DEPTH` calls
run concurrently, and advancing the deadline afterwards lets all of them wake
together — the long-run rate survives, but delivery comes in bursts that do not
resemble a radio and would hide a ring that is too shallow.

`editor/test/rtlsdr.test.mjs` covers the editor half. Its one irreplaceable case
is the **device table**: `RTLSDR_USB_FILTERS` in `editor/src/rtlsdr.ts` and
`RTL_DEVICE_FILTERS` in `runner/src/rtlsdr_reader.js` are the same list in two
realms that cannot share a module, and drift shows up only at run time as a
dongle the picker offers and the worker then refuses.

### With hardware

There is no automated coverage of the register protocol. Check by hand:

- an RTL-SDR **V3** (R820T2) and a **V4** (R828D) — the V4 takes a different I²C
  address, different MUX configs, and an upconverter for HF;
- WFM at 88–108 MHz, sounding correct through Rational Resampler → WBFM Receive;
- a QT GUI Range on `center_freq`, retuning while running;
- **unplug the dongle mid-run** — it must surface a readable error through the
  `BrowserLogSink`, not hang;
- 2.4 MS/s clean, 3.2 MS/s reporting overruns rather than lying.

## Platform notes

These generate every support question, and the block's own `documentation:` in
`blocks/grc/wasm_rtlsdr_source.block.yml` repeats them where users will look.

- **Chromium only.** Chrome, Edge, Opera; desktop and Android. Firefox and Safari
  have both declined to implement WebUSB and there is no polyfill.
- **Linux:** the kernel's `dvb_usb_rtl28xxu` DVB-T driver claims the dongle at
  plug-in and `claimInterface()` then fails — `blacklist dvb_usb_rtl28xxu` plus a
  udev rule granting the user access. **Chromium installed as a Snap cannot reach
  USB devices at all.**
- **Windows:** needs the WinUSB driver, which Zadig installs. Anyone already
  running rtl-sdr natively is set.
- **macOS, Android, ChromeOS:** no setup.
- **WSL:** WebUSB enumerates from the *browser process's* USB stack. A dongle
  `usbipd attach`ed into WSL is detached from Windows, so Chrome on Windows will
  not see it. Either run Chrome inside WSL under WSLg (and apply the Linux notes
  to the distro), or `usbipd detach` and use Chrome on Windows with WinUSB bound.

## Deliberate omissions

- **No recording tab.** The tab-per-source rule in `main.ts` is derived from
  blocks that read a *recording*; a live radio has nothing to show a spectrogram
  of.
- **No `cmd` message port**, unlike Soapy RTLSDR Source. Better no port than one
  that silently drops messages.
- **No E4000/FC0012/FC0013 tuners.** Rare, and the block names the chip it found
  rather than mis-tuning.
- **No transmit.** The RTL2832U cannot.
- **No validation that a device is attached.** That needs an `await` and a user
  gesture; the Run path prompts instead. `validation.ts` checks only what is
  synchronously knowable — the sample-rate windows and `bufflen % 512`. Note that
  every issue raised on an active block *blocks the run*, which is why there is
  no warning about tuning below the tuner's floor: an RTL-SDR V4 upconverts HF
  itself, and the check would refuse a flowgraph that works.
