# GRWire: a radio on another machine, over one WebSocket

Read this before touching `grwire/`, `blocks/src/grwire_source.{hpp,cpp}`,
`runner/src/grwire_worker.js`, `editor/src/grwire.ts`, or the
`wasm_grwire_source` factory in [`runner/src/registry.cpp`](../runner/src/registry.cpp).

GNU Radio World can already reach a radio plugged into the machine running the
browser — RTL-SDR, HackRF, PlutoSDR and the BB60 all arrive over WebUSB. GRWire
is for the other case: a radio on a Raspberry Pi in the attic, or a shack PC
across the house.

Radios are shared today with **SoapyRemote**, which works for GQRX and SDR++ and
is permanently unreachable from a tab: it speaks a custom TCP+UDP protocol, and
browsers have no raw socket API and never will. GRWire is a small fixed-function
daemon that speaks SoapySDR downward and one WebSocket upward.

## What this is, and what it is a copy of

**The browser half is `RtlSdrSource` with the transport swapped.** That is the
most useful thing to know about it, because every design decision follows:

| RTL-SDR Source | GRWire Source |
|---|---|
| a Web Worker owning a `USBDevice` | a Web Worker owning a `WebSocket` |
| `transferIn()` on a bulk endpoint | binary frames arriving on the socket |
| a ring in WASM linear memory, seen through `SharedArrayBuffer` | the same |
| `Atomics.notify` / `emscripten_futex_wait` | the same |
| a full ring **drops** and counts | the same |
| a command mailbox under a seqlock | the same, forwarded as JSON |
| `requestDevice()` needs a user gesture | nothing does, but *reachability* must be probed under the Run click |

So the new ideas here are the daemon, the wire format, and the fact that a
network can fall behind in two more ways than a USB cable can.

## The constraint that shapes everything

GNU Radio World is served over **https**, and an https page **may not open a
plain `ws://` socket** to a LAN address — Chrome blocks it as mixed content, with
an exception only for `127.0.0.1` and `localhost`.

There is no certificate authority that will issue for `raspberrypi.local` or
`192.168.1.42`. So the daemon signs its own certificate, and the user accepts it
once:

1. `grwire serve` prints `https://<host>:8073/` and a paste-ready `wss://` URL.
2. The user opens that https page once. It is a real page that says what GRWire
   is, confirms the certificate is now accepted, and lists the radios it can
   see — rather than a bare browser interstitial reached from a flowgraph editor.
3. From then on `wss://` works for that host in that browser profile.

`--insecure` serves plain `ws://` instead. It is only useful when the browser is
on the *same machine* (`ws://127.0.0.1:8073`), which is the one address an https
page may reach insecurely, and when developing against `http://localhost:8090`.

**Chrome also applies Local/Private Network Access checks** to a request from a
public origin to a private address, including the WebSocket handshake. The
daemon answers the preflight with `Access-Control-Allow-Private-Network: true`
(`local_network_headers` in `grwire/src/net/http.rs`). If Chrome ships its
permission prompt for this, the user grants it once.

## The four layers

```
editor (parent frame)   probes the daemon on the Run click; the .grc keeps a URL
      │
      │  .grc via runner.html#<json>
runner.html (iframe)    __grStartGrWireSource → new Worker(grwire_worker.js)
      │
      │  postMessage { memory, ringPointer, controlPointer, … }
grwire_worker.js        WebSocket → hello/open/configure/start → frames → ring
      │
      │  SharedArrayBuffer + Atomics
GrWireSource::work()    futex wait → ci8/ci16/cf32 → fc32/sc16/sc8
```

### The control block

`struct Control` in `grwire_source.hpp` and the `CTRL` indices in
`grwire_worker.js` are **one layout in two files**, and
[`grwire/proto/wire.json`](../grwire/proto/wire.json) is the third place that
states it. Adding a field means editing both in the same order and bumping
`words` in the spec; `editor/test/grwire.test.mjs` asserts all of them against
each other, including the C++ struct's *field order*, which is what actually
decides the layout.

### Why `start()` proxies and `work()` does not

Exactly as in [docs/rtlsdr.md](rtlsdr.md): `start()` runs on GNU Radio's
scheduler-launch pthread and uses `MAIN_THREAD_EM_ASM_INT` because `new Worker()`
is a main-thread operation. `work()` never proxies — it blocks on
`emscripten_futex_wait` on the source's own scheduler pthread, where blocking
stalls nothing else. The block id is therefore listed in `blocks_in_work()` in
`runner/src/schedulers.hpp`.

## The protocol (`grwire.v1`)

One WebSocket at `/ws`, subprotocol `grwire.v1`, carrying both planes: **control
as JSON text frames, IQ as binary frames**. One socket keeps ordering trivial and
makes "one client" enforceable by construction.

Client → server: `hello`, `list`, `open`, `configure`, `start`, `stop`, `flow`,
`ping`. Server → client: `hello`, `devices`, `opened`, `config`, `stats`,
`error`, `pong`.

The binary frame header is 32 bytes, little-endian, fixed for the life of v1 —
see `grwire/proto/wire.json` for the field table.

**Centre frequency and sample rate are deliberately not in the header.** They
arrive once per change in the JSON `config` event, keyed by `epoch`, and the
client caches that mapping. A retune then costs one small JSON message instead of
16 bytes on every frame, and the header stays a fixed size forever.

`configure` takes a requested **output** rate. **Omit `decim` and the daemon
plans it**: it walks integer factors from 2 upward and takes the first whose
hardware rate the radio actually offers, so the lowest rate that works is the one
chosen. Sending `decim` pins it, and `decim: 1` therefore means "do not
decimate" -- which is why the block's parameter defaults to **0, meaning
automatic**. Getting that wrong is not theoretical: while the block defaulted to
1, a HackRF asked for 250 kS/s silently returned 1 MS/s, because the planner was
never reached.

`config.applied` is authoritative for what was chosen.

**Frame size is time-bounded, not byte-bounded** (~15 ms, clamped to
4 KB–256 KB). A fixed 64 KB frame is 13 ms at 2.4 MS/s but 131 ms at 250 kS/s,
and the second one is felt as lag.

## Decimation is the point

A HackRF at 20 MS/s is 320 Mbit/s as `ci8` and will not cross WiFi. Decimated by
8 it is 40 Mbit/s and ordinary.

A HackRF is the case this exists for: it cannot sample below 1 MS/s, so 250 kS/s
is reachable only by decimating by 4, and only the daemon knows that. Leave the
block's Decimation at 0.

The daemon mixes first (an NCO, so `offset` fine-tunes **within** the captured
band with no hardware retune and so no glitch), then decimates with a **halfband
cascade** for the power-of-two part of the factor and one general FIR for the
remainder. Halfband taps are zero at every even offset by construction, so each
stage costs about half what a general FIR would and each runs at half the rate of
the one before.

### Gains, and why the stages are numbered

A radio names its own gain stages: a HackRF has `LNA`, `AMP` and `VGA`, an
RTL-SDR has `TUNER` alone, an Airspy has three of its own. So the block cannot
have per-radio parameters -- `lna_gain` would be wrong for every radio except
the one it was named after. There are three ways in, in increasing order of how
much the block has to know:

- **RF Gain** is one number the radio distributes across its own stages. Live.
- **Stage 1/2/3 Gain** address the stages individually, each drivable by a QT
  GUI Range. They are **positional**: slot *n* addresses the *n*-th element in
  the radio's own `gain_elements`, resolved in the worker, so the same flowgraph
  works against different radios. The dialog relabels them `LNA`, `AMP`, `VGA`
  once connected, and hides the ones the radio does not have.

There was briefly a third: a `gains` string of `NAME=VALUE` pairs, applied at
build time. It was removed because the stage parameters already do that job -- a
literal in one is applied at construction *and* drivable by a Range -- and
rendering both put **seven** gain boxes in front of someone with a HackRF, for
three amplifiers. Two mechanisms for one job is worse than the narrower one.

Their default is **-1000, not 0**, and the wire slot's sentinel is `INT32_MIN`.
Zero cannot mean "not driven", because 0 dB is a real gain -- treating them as
the same would deafen the radio the moment a flowgraph was opened. The smoke
fixture deliberately leaves the middle stage unset for exactly this reason.

Three slots because three covers a HackRF (LNA/AMP/VGA), an Airspy
(LNA/MIX/VGA) and an RTL-SDR (TUNER alone). A radio with more stages can only
have its first three driven individually; the rest follow **RF Gain**.

**Stage order is the radio's, and it is not stable across backends.** The same
HackRF One reports `["LNA","AMP","VGA"]` through SoapySDR and `["AMP","LNA",
"VGA"]` through the built-in driver, so `stage1` drives a different amplifier
depending on which entry was picked from the list. That is why the Properties
dialog relabels the fields from `gain_elements` the moment a radio is probed:
the numbers are an addressing scheme, and the names are what a person should be
reading.

`rate`, `decim` and `format` are **not** live-settable, for the reason
[docs/rtlsdr.md](rtlsdr.md) documents about `samp_rate`: the QT GUI sinks track
the rate live while GNU Radio's own rate assumptions are already baked into the
running graph, so a live change gives a wrong axis rather than no effect. Live:
`freq`, `offset`, gains, `agc`, `bandwidth`.

## Backpressure

The rule: **never block the reader, drop whole frames at exactly one place, and
tell the client precisely what was lost and where.** A radio cannot be told to
wait; the only dishonest option is to hide it.

```
radio.read() ─▶ [pool, bounded] ─▶ DSP ─▶ [FrameQueue, drop-oldest] ─▶ pump ─▶ socket
 dev_overruns       host_drops    ddc+decim      net_drops        client_drops
```

- **`dev_overruns`** — the radio's own buffer overflowed. Its samples were gone
  before we saw them; a different diagnosis from ours.
- **`host_drops`** — the reader queue was full: this host's CPU cannot keep up.
- **`net_drops`** — the writer queue was full: the socket cannot keep up.
- **`client_drops`** — the browser stopped acknowledging.

Two details are load-bearing:

**The frame queue drops the *oldest*.** For a live radio the freshest samples are
the valuable ones, and dropping the oldest keeps latency bounded instead of
letting a backlog accumulate. The next frame sent carries `FLAG_DISCONTINUITY`,
and the `sample_index` jump says exactly how much went.

**The outbound channel is tiny (8 frames).** Its whole job is to make a slow
socket visible *in the daemon*, at a frame boundary, where the loss can be
counted. Letting frames pile into the kernel's write buffer instead is
bufferbloat, and it turns a 30 ms link into seconds of lag that look exactly like
a broken flowgraph.

**TCP cannot reveal a slow consumer.** The browser's receive buffer will happily
absorb frames that JavaScript never drains. So the worker sends
`flow{ack_seq, ring_used}` every 8 frames, and the daemon sends at most a
quarter-second of frames past the last ack. A client that never sends `flow` at
all is never throttled — the window arms on the first one — so a hand-written
probe still works.

**There is no automatic rate reduction.** Silently increasing decimation would
change the graph's sample rate underneath a running flowgraph. Every layer's loss
is reported instead, so the console can name the bottleneck.

### The daemon checks its own arithmetic

`stats` carries `measured_rate` beside `out_rate`, and `rate_suspect` when they
disagree by more than 2% after the stream has settled. This exists because a
driver that misreports its sample rate is the worst failure mode here: the plots
stay convincing and only their frequency axis is wrong.

It is not hypothetical, but be careful what you conclude from it: **the estimate
needs about ten seconds to settle.** Measured against a real RTL-SDR, it is still
~2% out at 5 s and has converged to under 0.5% by 10 s, which is why
`SETTLE_SECONDS` is 10 and why a short measurement is reported but never used to
raise the flag. An earlier version flagged at 5 s and accused a perfectly good
dongle at random.

What it does catch is a host that cannot keep up: a debug build decimating by 8
at 2.4 MS/s runs about 8% short, and says so.

Both RTL-SDR backends here -- native `seify-rtlsdr` and SoapySDR's module --
deliver the rate they report to within 0.3% over a settled window.

## Security

The daemon exposes a radio to a network. Two things guard it, and only one of
them is the real gate.

**The token is the gate.** 32 characters from a 36-symbol alphabet, minted on
first run, stored in the config directory, compared in constant time. It travels
in the URL query because a browser cannot set headers on a WebSocket handshake.

**The token never reaches the `.grc`.** The editor splits a pasted URL: the bare
`wss://host:port/ws` goes into the flowgraph, the token goes into `localStorage`
keyed by `host:port`, and the Run path splices it back through the same
`RUN_BOUND_PARAMS` mechanism that rewrites a local file's path. A flowgraph is
the one artifact this project actively encourages people to share, and one
carrying a token hands out the sender's radio to everyone who opens it. Opening
a block's Properties on an older flowgraph migrates it in place: the field shows
the bare URL, and saving from there writes a clean document.

**An Origin allowlist, as defence in depth.** It matters because the browser sits
*inside* the network the daemon is on: a page on any public site can reach a
private address through the tab it runs in, and Chrome 152 was observed not to
block that. `default_origins()` carries the deployed site and a local dev server,
a page the daemon served itself is always allowed, `--allow-origin` extends the
list and `*` disables the check.

Two things to know about that check, both learned the hard way:

- **No command-line test exercises it.** `curl` sends no `Origin`, so every
  request from a terminal takes the "not a browser, trust the token" path. The
  allowlist named the wrong domain for the life of the first implementation and
  only a real browser ever found out.
- **A refusal is nearly invisible from the browser.** The console shows a bare
  "WebSocket connection failed" with no reason. The daemon logs
  `refused a connection from origin ...`, and that log line is the only place the
  cause appears -- check it first when a connection fails for no visible reason.

**One client at a time.** A radio is not shareable and interleaving two clients'
tuning requests would give a stream matching neither, so a second connection is
refused by name unless `--takeover`.

What is *not* protected: `/info` answers without a token, so anyone who can reach
the port learns the hostname, the compiled backends and whether a client is
connected.

## The radio backend

`grwire/src/radio/mod.rs` is a real seam. Above it everything works in
`Complex32` and knows nothing about seify, SoapySDR or USB.

**seify is not an alternative to the `soapysdr` crate — its default feature *is*
`soapysdr`.** It is that binding plus a `DeviceTrait` over extra pure-Rust
backends. GRWire builds it with the `soapy` feature on, so the driver code doing
the actual work is the battle-tested SoapySDR modules, while the API gives typed
errors (`Overrun` vs `Timeout` vs `DeviceDisconnected`, which the per-layer
accounting needs) and a `Direction` in every signature that transmit will reuse.

The seam is not optional: seify had five breaking releases between April and
August 2026, the fake backend must not depend on it at all, and if the
`Complex32`-only read path ever costs too much on a Pi, dropping to raw
`soapysdr` for a CS8 fast path is then a one-file change.

One observed quirk, since it will bite whoever trusts a gain readback:
**`seify-rtlsdr` 0.0.4 accepts dB in `set_gain` but returns tenths of a dB from
`gain()`** -- `set_gain(30.0)` then reads back as `300.0`. Nothing here relies on
reading a gain back, which is why it does not matter today.

**Whatever `enumerate` puts in `args` must parse back through `open`.** It is
what a `.grc` stores and what the daemon is handed later. seify's own
`Args::to_string()` is *not* suitable: it dumps every key it knows, including
values containing spaces (`device=HackRF One`), and its parser cannot read those
back -- so picking a radio from the list failed while leaving the field empty
worked. `identity()` builds the smallest space-free string that names the
device, and `every_enumerated_device_opens_by_its_own_args` holds the round trip
shut.

**A missing capability is absent, not an error.** An RTL-SDR returns
`Unsupported` for bandwidth. `tolerate_unsupported` turns that into a warning in
`config.applied` rather than a refusal to stream.

**Anything `configure` accepts before `start` must be recorded in
`AppliedConfig` and replayed by `start`.** `dispatch` reaches the radio only
through the reader thread, which does not exist until the stream does, so a
setting that is merely dispatched is silently dropped. Per-stage gains were
exactly that bug: validated, reported as accepted, never applied, and invisible
until the received signal level was measured across the gain range and did not
move. If you add a setting here, replay it there.

## Testing

| suite | covers | needs |
|---|---|---|
| `cd grwire && cargo test` | the protocol, the decimator's response and sample conservation, the drop accounting, the token and certificate handling | nothing |
| `node grwire/tools/probe.mjs <url>` | the daemon end to end with no browser: rate, per-layer loss, sequence continuity, and the tone that arrives | a running daemon |
| `test/fixtures/grwire_mock.grc` in `test_smoke.mjs` | the whole browser half against `test/support/grwire_mock.mjs` | nothing (CI-safe) |
| `editor/test/grwire.test.mjs` | the URL checks, and the **wire-format drift check** across four realms | nothing |

`--gains LNA=24,VGA=20` plus the `signal rms` line is how a gain setting is
confirmed to have reached the *radio*: a daemon that accepts one without
complaint proves nothing. On a HackRF the level should swing tens of dB across
the range.

The probe is the tool that matters when something is wrong, because it cuts the
problem in half: it speaks the same protocol and checks the same invariants with
none of WASM, the shared ring or the scheduler involved.

```bash
cd grwire && cargo run --release -- serve --insecure --listen 127.0.0.1:8073
node grwire/tools/probe.mjs "ws://127.0.0.1:8073/ws?token=..." --device fake:250000 --seconds 8
```

**The fake radio models a FIFO, and does not forgive lateness.** An earlier
version advanced its deadline with `deadline.max(now)`, which silently absorbed a
consumer that was a little late on every read — and a persistent 8% shortfall
then appeared as a sample rate a few percent low with every drop counter reading
zero. It now accumulates debt and reports `Overrun` when the notional buffer
overflows, exactly as hardware does. A fake that hides the host's slowness makes
the whole accounting design untestable.

## Testing the TLS path without a second machine

WSL hosting the daemon and Windows running the browser is a faithful two-machine
test, with one trap: **use the WSL IP, not `localhost`.** WSL forwards localhost
to Windows, and a browser treats `localhost` as potentially trustworthy -- so
`ws://localhost` from an https page is *allowed*, no certificate is needed, and
none of the rules this design exists to satisfy are exercised. The WSL address
(`ip -4 addr show eth0`) is an ordinary private address and behaves like a
machine across the room.

```bash
grwire serve --listen 0.0.0.0:8073          # in WSL; note this is LAN-visible
/mnt/c/Windows/System32/curl.exe -sk https://<wsl-ip>:8073/info   # Windows can reach it
```

Windows binaries are callable from WSL, so the whole path can be checked without
touching the GUI: `curl.exe` with `-k` proves reachability, without `-k` it must
fail with exit 60 (an untrusted self-signed certificate, which is the
interstitial the user clicks through), and an OPTIONS with
`Access-Control-Request-Private-Network: true` must come back 204.

Two bugs lived in this path until it was actually exercised, both invisible to
every test that used `ws://` to loopback:

- **rustls 0.23 panicked at the first TLS handshake**, because more than one
  crypto backend ends up compiled in and it refuses to guess. `serve_tls`
  installs the provider explicitly. Without it the entire `wss://` path was dead
  and nothing said so until a connection arrived.
- **The Local Network Access preflight came back 405.** `axum`'s
  `WebSocketUpgrade` extractor rejects anything that is not a GET *before* the
  handler body runs, so a preflight answered inside the upgrade handler never
  executes. OPTIONS is now its own route.

## Deliberate omissions

- **No transmit yet.** The seams are cut: `direction` is in `open`, the frame
  header has a direction-agnostic `type`, and the flow-control scheme reverses
  into TX pacing. Nothing is implemented, and a binary frame from the client is
  refused loudly rather than discarded.
- **No cloud relay.** LAN and localhost only. The protocol does not care what
  carries it, so a relay can be added without touching the block.
- **No multiple clients.** A radio is not shareable, and interleaving two
  clients' tuning requests would give a stream matching neither. A second
  connection is refused by name unless `--takeover`.
- **No recording tab.** As with the USB radios: a live radio has nothing to show
  a spectrogram of.
- **No mDNS discovery from the browser.** Browsers cannot do it. The daemon
  advertises `_grwire._tcp.local` for other tools, and prints the `.local` URL
  for a human to paste.

## Platform notes

- **The daemon** runs on any Linux with SoapySDR: `apt install libsoapysdr-dev
  soapysdr-module-rtlsdr soapysdr-module-hackrf` (add the modules you need).
  Tested on x86-64; aarch64 (Raspberry Pi 5) is a cross-build target.
- **The browser** needs no plugin and no permission, unlike WebUSB — so unlike
  RTL-SDR Source, this block is not Chromium-only. What it does need is the
  certificate accepted once.
- **A dongle can appear twice** in the radio list, once per backend (`driver=rtlsdr`
  natively and `driver=soapy,soapy_driver=rtlsdr` through SoapySDR). That is
  honest rather than a bug; prefer the Soapy one.
