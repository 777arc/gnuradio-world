# HackRF Source and Sink

Read this before changing `wasm_hackrf_source`, `wasm_hackrf_sink`, their
WebUSB worker or their hardware tests. The general hand-written block rules in
`docs/blocks.md` still apply.

## User setup

The blocks currently support HackRF One (`1d50:6089`) running the stock Great
Scott Gadgets firmware. They need no native libhackrf installation or helper
process: a Chromium browser drives the device directly with WebUSB.

Click Add beside Device or press Run to grant the site access. The `.grc` keeps
only the USB serial number. A worker in the runner frame re-acquires the device
through the origin's persistent permission; a `USBDevice` is never transferred
between frames or into Wasm.

On Linux the browser user needs access to the USB node and no native program may
have the HackRF open. Snap-packaged Chromium may not reach USB. On Windows the
device needs a WinUSB binding, commonly installed with Zadig. Firefox and Safari
do not implement WebUSB.

## Architecture

This is the same async-browser/synchronous-scheduler boundary as RTL-SDR and
PlutoSDR:

1. The editor obtains permission during the Run click.
2. `runner.html` starts `hackrf_worker.js` with the shared Wasm memory and ring
   pointers.
3. The worker claims the HackRF, sends its vendor control requests and keeps
   four bulk transfers in flight.
4. `HackRfSource::work()` drains signed 8-bit IQ from the RX ring, or
   `HackRfSink::work()` fills the TX ring.

Compiling libhackrf/libusb into Wasm is deliberately avoided. WebUSB is
asynchronous while the GNU Radio scheduler is synchronous and threaded; the
ring/futex pattern crosses that boundary without Asyncify or JSPI.

The protocol constants and configuration behavior are checked against Great
Scott Gadgets' official `host/libhackrf/src/hackrf.c` reference implementation.
Keep that provenance in the worker when moving or expanding the protocol code.

## USB protocol subset

HackRF One exposes one vendor interface with bulk endpoint 1 IN and endpoint 2
OUT. Streaming samples are signed interleaved 8-bit I/Q. The worker implements
only these stock vendor requests:

- 1: transceiver mode OFF/RX/TX
- 6: fractional sample rate (the blocks currently send integer rate / 1)
- 7: baseband filter bandwidth
- 15: firmware version string
- 16: center frequency, split into MHz and remaining Hz
- 17: RF amplifier
- 19/20: RX IF and baseband gain
- 21: TX VGA gain
- 23: antenna/bias-tee power

The queue depth and default 262144-byte transfer size match libhackrf. Every
view into shared Wasm memory is stable because the memory is shared; USB result
buffers are copied before reuse.

## Parameters and live changes

Both blocks are one-channel complex blocks. HackRF is half-duplex, and one
physical device may be owned by only one active Source or Sink. Separate units
may be used when every block selects a distinct serial explicitly.

Sample rate is 2-20 MS/s. The Source may change it live; the Sink keeps it
construction-time so a GUI control cannot unexpectedly alter an active
transmission. Rates below 8 MS/s are accepted but not recommended by Great
Scott Gadgets because the ADC/DAC and the minimum 1.75 MHz analog filter perform
poorly there. Bandwidth zero applies libhackrf's automatic choice: the widest
MAX2837 filter strictly below 75% of the rate, clamped to the 1.75 MHz minimum.
A nonzero value must be one of the MAX2837 widths in `BANDWIDTHS` in the worker.

Center frequency and gains are live numeric setters. RX IF gain is 0-40 dB in
8 dB steps, RX baseband gain is 0-62 dB in 2 dB steps, and TX VGA gain is 0-47
dB in 1 dB steps. RF amplifier and bias tee are also live and default off.

## Rings and loss behavior

The ring stores raw IQ pairs rather than `gr_complex` so USB data crosses from
JavaScript into C++ only once. Its capacity is about a quarter second, bounded
between four complete USB transfers plus one slot and four million IQ pairs.

RX cannot backpressure a radio. If one complete transfer does not fit, the
worker drops it, increments the overrun and lost-pair counters, and reports on a
doubling schedule.

The Sink backpressures its GNU Radio input and TX does not begin until four
complete transfers are ready. Once streaming, failure to replace a completed
transfer is an underflow: the worker requests transceiver OFF and fails the
block instead of knowingly allowing stale or zero data to continue on air.

## TX safety

TX gain, RF amplifier and bias tee default to zero/off. Configuration starts by
forcing mode OFF, amplifier off and bias tee off; requested values are applied
only after every other setting succeeds. Normal stop, error, page shutdown and
the explicit runner stop message all request mode OFF before releasing USB.

Real TX tests are never automatic. Run them only with an appropriate shielded
load or attenuated RF test path and after checking the applicable radio rules.
The receive example is user-facing; there is intentionally no auto-starting TX
example.

## Files and rebuilds

- metadata: `blocks/grc/wasm_hackrf_{source,sink}.block.yml`
- C++ blocks: `blocks/src/hackrf_{common,source,sink}.{hpp,cpp}`
- worker: `runner/src/hackrf_worker.js`
- launcher/stats: `runner/src/runner.html`
- picker/ownership: `editor/src/hackrf.ts`, registered in `editor/src/main.ts`
- factories: `runner/src/registry.cpp`

After metadata or factory changes regenerate the registry and palette, rebuild
the runner, then run the editor check as described in `docs/blocks.md`.

## Testing

Device `fake` or `fake:<tone-hz>` opens no USB. Fake RX produces a paced
half-scale complex tone and fake TX consumes paced transfers. The smoke fixture
therefore covers both rings, the shared control ABI, scheduler behavior,
conversion and stop paths without emitting RF.

The direct hardware harness requires full Chrome and the persistent permission
profile under `test/hw/.profile`; headless Chrome shells do not expose WebUSB.
Use `node test/hw/grant.mjs --hackrf` once, then run the harness. Validate RX at
2, 8, 10 and 20 MS/s, live retuning against a known carrier, stop/restart and an
unplug. A TX harness mode must remain explicit and guarded by a confirmation
flag; use minimum gain into a load first.

For an interactive end-to-end throughput reading, use Help ▸ SDR Receive Speed
Test. It runs a private HackRF Source → Null Sink graph and shows the Source
block's sustained item rate on a speedometer, with receive overruns and dropped
samples alongside it. This is receive-only and leaves the RF amplifier and bias
tee off.
