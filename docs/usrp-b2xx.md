# USRP B2xx Source

Receiving from an Ettus/NI USRP B2xx in a browser tab: B200, B210, B200mini,
B205mini, B206mini, and the NI-branded USRP-2900/2901. No native UHD, no helper
process, no server round trip.

Unlike the other radios here, this one does not reimplement a device protocol.
It cross-compiles **UHD itself** — a B200-only subset — to WebAssembly and lets
libusb's Emscripten backend do the USB work. That choice is why this block has a
side module of its own and two patches under `deps/patches/`, both covered below.

**Receive only, one channel.** No sink, no full duplex, and no dual-channel B210.
See [Deliberate omissions](#deliberate-omissions).

## Using it

Set **Device** to a USRP's serial number, or leave it empty for the first one
shared with the site. `fake` and `fake:<tone-hz>` open no hardware at all.

Requires a Chromium-based browser (Chrome, Edge, Opera). Firefox and Safari have
both declined to implement WebUSB.

### A cold board needs granting twice

This is the single most confusing thing about the radio, and it is not a bug.

A B2xx powers up without its FX3 firmware. UHD pushes the firmware over USB, and
the device then **re-enumerates with a different USB identity** — different
manufacturer string, different serial number. Chrome grants WebUSB permission per
device identity, so the permission you just gave belongs to a device that no
longer exists, and UHD's rescan window (`REENUMERATION_TIMEOUT_MS`, 3 s) is far
too short for a browser to get a fresh one.

So the first run after a power cycle goes:

1. Grant the device. UHD loads the firmware (~40 s on USB 3). The run stops.
2. Grant it again — it is a new device to the browser now. This run succeeds.

The block narrates both, because a user who has not read this page has no way to
guess any of it. The console pane gets, on the first run:

```
USRP B2xx Source: loading firmware image -- about 40 s over USB 3.0.
USRP B2xx Source: the board restarts with a new USB identity when this finishes,
                 so this run will stop and ask you to pick it again.
...
USRP B2xx Source: firmware loaded. The board has restarted with its real serial
                 number, which this browser has not been given access to yet.
USRP B2xx Source: press Run again and pick the USRP when the browser asks.
```

and on the second:

```
USRP B2xx Source: loading FPGA image -- about 15 s.
```

That narration is driven by **UHD's own log lines**, through a handler registered
with `uhd::log::add_logger()`. It has to be: only UHD knows which path a given
board is on, because it decides by reading the USB manufacturer string, which the
block cannot see from where it sits. `install_uhd_narration()` in the block is
registered once and captures nothing — UHD's logger list is global, has no remove,
and outlives any flowgraph, so a captured `this` would dangle into the next run.

The failure at the end of step 1 is the *expected* end of a cold run, not a fault,
and is reported as such rather than as whatever `multi_usrp::make()` threw when its
three-second rescan found nothing.

Both grants persist, so later runs need neither. Note the **USB vendor/product id
does not change** across this; UHD decides whether firmware is present by reading
the manufacturer string (`libusb1_base.cpp`, `firmware_loaded()`). Only the
strings and the serial change, which is why the device picker needs no extra
filter for it.

### Then the FPGA image, once per power cycle

`multi_usrp::make()` loads a 2.5–4.2 MB bitstream over USB. On a browser that
takes **minutes** the first time. UHD stores a hash and skips it on later runs
until the device is power-cycled, after which a warm start takes **2.6–3.5 s**.

The runner holds its startup verdict while this happens rather than reporting
success on a timer, and gives up after five minutes. See
[`gr_hardware_init_begin`](../runner/src/runner.cpp).

While it waits it prints a heartbeat every ten seconds, so a 40 s firmware load
does not look like a hang. A block says what is being waited on with
`gr_hardware_init_note()` — the USRP sets it to `loading firmware image`, and to
the empty string for the FPGA load, which silences the heartbeat because 15 s does
not need progress lines.

The images are served from this origin, beside `runner.html` — see
[building.md](building.md) for why they are not in the recordings bucket.

### Windows: WinUSB is mandatory

A B2xx with no driver appears in Device Manager under Cypress's controller name,
**"WestBridge"**, with a warning icon, and Chromium's chooser then lists nothing
at all. Rebind it with [Zadig](https://zadig.akeo.ie/):

1. Options ▸ **List All Devices**.
2. Select by **USB ID** — `2500 0020` (B200/B210), `2500 0021` (B200mini),
   `2500 0022` (B205mini), `2500 0023` (B206mini), or `3923 7813` / `3923 7814`
   for the NI USRP-2900/2901. Go by the ID, never the name: more than one device
   answers to "WestBridge".
3. Set the target driver to **WinUSB** and click Replace Driver.

Reversible through Device Manager, but a native UHD installation wanting its own
driver may stop seeing the device until it is.

### Linux and WSL

On Linux, add a udev rule granting your user access to the device node. Chromium
installed as a **Snap cannot reach USB devices at all**.

Under WSL, WebUSB enumerates from the *browser process's* USB stack. A device
`usbipd attach`ed into the distro is detached from Windows and invisible to Chrome
there — run `usbipd detach --busid <BUSID>` (and `usbipd unbind` if it still lists
as `Shared`) before granting it to a Windows browser, or run Chromium inside WSL
and apply the Linux notes to the distro.

Also: **two browser tabs on the same page silently take the device from each
other.** libusb then reports zero devices, because its enumeration opens each one
and drops any it cannot.

## Throughput: far below the spec sheet

Measured on a B210 over USB 3, single channel, master clock rate pinned to the
requested rate, counting samples and doing no DSP:

| Requested | Achieved | % | Overruns |
|---|---|---|---|
| 1 MS/s | 1.000 | **100%** | 0 |
| 10 MS/s | 9.998 | **100%** | 0 |
| 15.36 MS/s | 15.010 | 98% | 8 |
| 20 MS/s | 19.247 | 96% | 8 |
| 30.72 MS/s | 9.939 | **32%** | 287 |
| 40 MS/s | 7.513 | 19% | 308 |
| 56 MS/s | 5.841 | **10%** | 308 |

**Clean to 10 MS/s. A cliff between 20 and 30.72.** Past it, achieved throughput
*falls* as the request rises — that is overrun thrashing, where each overrun costs
a resync, not a flat ceiling being reached. Peak sustained is about 19 MS/s.

These are an upper bound: a flowgraph that actually processes its samples will
manage less. Each figure is a single three-second sample, and the run-to-run
spread at 15–20 MS/s is wide enough (86–96%) that small differences mean nothing.

### The browser main thread is the real ceiling

The table above was measured by a bare receive loop on an otherwise idle page. The
same B210 at **1 MS/s under a flowgraph with two Qt plots delivers 0.15–0.17 MS/s**
— about 700 KB/s — and the shortfall is not where it looks.

What the block's own instrumentation says, at 1 MS/s into a frequency sink and a
waterfall: 85–95% of wall time inside `recv()`, so the graph downstream is idle and
waiting. Not a downstream problem. And the cost is **proportional to bytes, not to
transfers**: 16360-byte frames cost 23.5 ms each, 8176-byte frames cost 11.4 ms,
both ~700 KB/s. So it is not per-transfer overhead either — not the two blocking
main-thread round trips per transfer that libusb's Emscripten backend does
(`runOnMain` is `queue.proxySync`, in `em_submit_transfer` and
`em_handle_transfer_completion`), tempting as that explanation is.

It is a **bandwidth division**. Chrome does a fixed amount of main-thread work per
byte received — the Mojo IPC into the renderer, then `HEAPU8.set` into the wasm
heap — and Qt repaints the plots on that same thread. The probe reached 19.25 MS/s
(77 MB/s) over this identical path with the main thread idle, so the transport is
capable of roughly a hundred times what a plotting flowgraph gets. USB throughput
is whatever share of the main thread Qt leaves over.

`test/fixtures/usrp_b2xx_throughput.grc` is the control: the same source into a
Null Sink with no GUI block at all. On the B210 that delivers **1.002 of 1.000
MS/s with zero overruns over a minute**, against 0.15 for the same radio and rate
feeding a frequency sink and a waterfall. Run it beside an example with plots to
measure the split on a given machine.

`deps/patches/libusb-emscripten-usb-thread.patch` is the fix: the backend's two
proxying primitives, `runOnMain` and `awaitOnMain` — every WebUSB call in the file
goes through one of them — target a thread of libusb's own instead of
`emscripten_main_runtime_thread_id()`. It still has to be *a* single thread,
because a `USBDevice` belongs to the JS realm that created it; it just no longer
has to be the one Qt draws on. `requestDevice()` keeps needing a user gesture and
so still happens in the page; `getDevices()` re-acquires by origin permission on
the USB thread, exactly as this project's hand-written WebUSB workers already do.

The thread is created on first use and kept alive with
`emscripten_exit_with_live_runtime()`, which is what lets a pthread go on
servicing both its proxying queue and the promise callbacks WebUSB delivers. It is
**proved before it is adopted**: one trivial task is proxied across, and the main
thread is used instead if it does not come back. Without that check, a pthread
that stopped servicing its queue would present as a tab that hangs on the first
transfer with nothing in the log.

It costs one worker, so `usrp_aux_threads()` in `runner.cpp` and
`flowgraphUsrpAuxThreads()` in `runner.html` both reserve two shared threads per
flowgraph rather than one.

### What is left is Qt, not USB

Measured on a B210 at 1 MS/s, after the move off the main thread:

| flowgraph | delivered | overruns in a minute |
|---|---|---|
| source → Null Sink, no GUI | **1.002 MS/s** | 0 |
| source → frequency sink + waterfall | **0.95 MS/s** | ~8 |
| the same, before the USB thread | 0.15 MS/s | hundreds |

A 16360-byte frame costs 2.74 ms. The transport is done: the no-GUI control runs
clean for minutes, and in the plotting case the source spends **35% of its time
outside `recv()`** — waiting for output-buffer space, because the two Qt sinks
cannot quite consume 1 MS/s in a browser. More work on the USB path cannot move
that number.

One thing was tried and reverted: making `em_submit_transfer` asynchronous and
batched, on the theory that the ~3.2 ms *per frame* still visible with 128
transfers in flight had to be the one remaining synchronous round trip per
transfer. It made no difference to the per-frame cost, and it was a real
regression: 0.63 MS/s with dozens of overruns against 0.95 and about eight once it
was taken back out. The theory was also resting on a contaminated
measurement — see the note on that figure in the block — and the change had real
costs: submission ordering moved onto a hand-rolled deque (the proxying queue
keeps a *separate queue per source thread* and so does not order calls from
different ones), and cancellation had to cope with a transfer that had not been
issued yet. Not worth carrying for nothing. The remaining round trip is
`em_handle_transfer_completion`, which proxies to pull bytes out of the settled
promise with `val`; there is no evidence it is costing anything.

**A new thread is a new embind realm**, and that is the trap. embind's type
registry is per JavaScript realm, and the side module's registration of
`emscripten::val` (see the cancel-transfer patch, and "the two patches" below)
runs in whichever realm `dlopen`'d it — not in a thread libusb starts afterwards.
Without repeating it, the first `val` to cross from the USB thread fails with
`BindingError: parameter 0 has unknown type N10emscripten3valE` during device
discovery, which is exactly how this broke the first time. `usbThreadMain()` calls
`registerEmbindTypes()` before it exits to the event loop for that reason.

### The transport buffering is not UHD's default, and cannot be

Separately from the main-thread ceiling above, one transport setting has to differ
from UHD's desktop defaults.

UHD's B200 defaults are **16 receive frames of 8176 bytes** — 32704 `sc16` samples,
so the device's FIFO overflows if the host stops draining for 33 ms at 1 MS/s.
That is a fine assumption on a desktop. It is the wrong one in a tab: every WebUSB
transfer completes on the **browser main thread**, which is also where Qt repaints
the flowgraph's plots, and one waterfall update passes 33 ms without trying.

So the block asks for `recv_frame_size=16360` and `num_recv_frames=128` —
2.1 MB in flight against 130 KB, which is half a second of slack at 1 MS/s and
26 ms at 20. 16360 is the largest frame the FX3 accepts and is deliberately
neither a multiple of 8 nor of the 512/1024-byte maximum transfer, so UHD does not
coerce it (`b200_impl.cpp`). The cost is heap and nothing else.

A few seconds in, the block reports once what the radio is actually delivering:

```
USRP B2xx Source: streaming 0.999 of 1.000 MS/s, 1 overrun(s) so far
```

Overruns are then reported at 8, 16, 32 … rather than one by one. The first few
are passed over in silence deliberately: a couple as the stream comes up are
normal and cost nothing, and reporting them reads as a failure during the one
moment the user is watching hardest. A graph in real trouble produces hundreds a
second and reaches the threshold immediately anyway.

Every rate in those lines is measured over the window **since the previous
report**, and the baseline is taken at the first sample actually delivered rather
than at the stream command — there is a ramp of a few hundred ms between the two
during which no rate means anything, and averaging over it understates everything
that follows. A window under half a second prints the count without a rate, rather
than presenting noise as a measurement.

**Master Clock Rate is not cosmetic.** UHD's automatic tick-rate search fails for
common rates such as 30.72 MS/s and silently coerces the rate *upward* — ask for
30.72 and get 40, which then overflows and delivers a quarter of what you asked
for. Pin it, or watch the console for the coercion warning.

## The two patches, and why they are not optional

Both are in `deps/patches/`, applied by `deps/fetch-deps.sh`. Without them a USRP
hangs partway through initialisation with no error and the tab must be reloaded.

**`libusb-emscripten-cancel-transfer.patch`.** WebUSB cannot abort a transfer once
`transferIn()` has been called; its promise settles when the device answers and
never before. libusb implements *every* synchronous-transfer timeout by calling
the backend's `cancel_transfer`, and the stock Emscripten backend's is a no-op, so
a bulk IN on an endpoint with no data never completes and never times out.

Completing the transfer is only half the fix. The bytes that read will receive are
still coming, and dropping them corrupts the endpoint's stream — it surfaces much
later as a request that is never answered, because a stale read swallowed its
reply. So a cancelled read is *orphaned*: queued against its endpoint, and adopted
by the next reader instead of a fresh `transferIn`. Adoption requires matching
lengths, since a read's size is fixed when it is issued.

**`uhd-frame-sized-endpoint-flush.patch`.** UHD drains its receive endpoint with
512-byte reads while frames are 8176 bytes. On a normal host the loop's later
iterations drain the remainder and the kernel genuinely aborts the final read;
here that read stays outstanding and truncates the first frame of the next stream
(`bad vrt header or packet fragment`). A frame-sized buffer fixes it — and removes
a latent truncation bug on every other platform.

## Diagnostics

- Requested versus actual sample rate is printed when they differ; UHD coerces
  silently otherwise.
- Overruns are counted and reported on a doubling schedule, because a graph that
  cannot keep up produces hundreds a second and the console pane is shared.
- `radio_aux_threads` in the stats snapshot counts the threads UHD owns outside
  the scheduler — one libusb event task, shared, plus one asynchronous-message
  task per device. Kept out of `dsp_threads`, which stays the scheduler's width.

## Stopping and unplugging

Pulling the cable mid-stream produces `LIBUSB_TRANSFER_ERROR` out of `recv()`
within about **1.3 s**, and teardown completes in about **2.9 s**; the browser
stays responsive and the tab survives.

Two consequences the block handles, and any future TX block must too:
`issue_stream_cmd(STOP_CONTINUOUS)` **throws** when the device is gone — bounded,
but it throws — and after an unplug the `multi_usrp` is dead, so the block enters
an error state rather than trying to continue.

## The fake device

`device: fake` produces a paced half-scale tone; `fake:<hz>` sets its frequency.
It opens no WebUSB, fetches no images, and loads no UHD state, but runs the same
block lifecycle and pending-setter machinery. It is what
`test/fixtures/usrp_b2xx_fake.grc` and the example flowgraph use, so both run in
CI with no hardware.

## Hardware testing

`node test/hw/usrp-spike/grant_usrp.mjs` grants the device once into the
persistent profile under `test/hw/.profile`; the harness pages need full Chrome,
not a headless shell, because headless does not expose WebUSB.

**What has actually been exercised on hardware, and what has not.** Every
measurement above comes from a **B210 over USB 3**, driven by the standalone spike
harness rather than through the block. The block itself has been run only against
`fake`. B200, B200mini, B205mini and B206mini share UHD's code and USB ids, which
establishes *intended* support, not proof — do not describe them as validated
until someone has run one.

## Deliberate omissions

- **Transmit.** No sink, and no full duplex.
- **Dual-channel B210.** One channel, chosen by the hardware. The transport is
  proven to work — UHD rejects `stream_now` on a multi-channel streamer, and with
  a timed start instead it streams — but throughput was poor and the measurement
  untrustworthy, so it needs real work before it is offered.
- **External reference, PPS, GPSDO, multi-device synchronisation, timed commands,
  GPIO, UART, `sc8`/`sc12` wire formats, RFNoC, arbitrary UHD device args**, and
  compatibility with the full upstream `uhd_usrp_source` parameter surface.
- **EEPROM writing and recovery flashing.** The block reads the EEPROM to identify
  the product and never writes it; a board with blank FX3 EEPROM is a
  `b2xx_fx3_utils` job on a native host, which is why the Cypress recovery USB ids
  are deliberately absent from the device picker.

## Where the code is

| what | where |
|---|---|
| block metadata | `blocks/grc/wasm_usrp_b2xx_source.block.yml` |
| implementation (and the `wordexp` shim UHD needs) | `blocks/src/usrp_b2xx_source.cpp` |
| editor picker | `editor/src/usrp-b2xx.ts` |
| side module build | `runner/CMakeLists.txt` (`b2xx.wasm`) |
| dependency pins and patches | `deps/fetch-deps.sh`, `deps/patches/` |
| firmware and FPGA images | `deps/fetch-usrp-images.sh` |

The `runtime_module` mechanism that keeps UHD out of the main module, and the
three-way symbol boundary it runs into, are in [blocks.md](blocks.md).
