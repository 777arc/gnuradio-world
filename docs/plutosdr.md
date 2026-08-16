# PlutoSDR Source and Sink

Read this before changing `wasm_plutosdr_source`, `wasm_plutosdr_sink`, their
WebUSB transport, or their hardware tests. The general hand-written-block rules
in `docs/blocks.md` still apply.

## User setup

The blocks work with an ADALM-PLUTO running Analog Devices' out-of-the-box
firmware. They do not require custom firmware, libiio on the user's computer,
or an IP connection.

On Windows, first install the [PlutoSDR/M2k USB
driver](https://github.com/analogdevicesinc/plutosdr-m2k-drivers-win/releases/download/v0.9/PlutoSDR-M2k-USB-Drivers.exe),
then plug in the Pluto. The browser must be Chromium-based (Chrome, Edge or
Opera) because Firefox and Safari do not implement WebUSB. The user grants the
site access from the Device field or the Run button.

The Pluto's default network address is `192.168.2.1`. It is useful for native
libiio diagnostics, but these browser blocks use the USB IIO interface and do
not use that address. A developer can configure another address for testing;
do not put such a local address into user documentation.

## Why this design

Marc Newlin's 2020 MIT-licensed `websdr` demonstrated the important fact: the
stock Pluto firmware's IIOD service can be driven directly from WebUSB. It used
the Pluto VID/PID (`0456:b673`), interface 5, fixed endpoint pairs, fixed
`iio:deviceN` ids and a fixed one-megabyte receive buffer. It sent IIOD v0
commands including `PRINT`, `READ`, `WRITE`, `OPEN`, `TIMEOUT` and `READBUF`.

That is the provenance and protocol proof, not code this implementation needs
to embed. Current GNU Radio World follows the modern libiio USB backend's shape
while retaining the existing browser-radio architecture:

1. The editor calls `navigator.usb.requestDevice()` during a user gesture and
   stores only the USB serial number in the `.grc`.
2. A dedicated Worker re-acquires the permitted `USBDevice`. A device object is
   never transferred between the editor and runner frames.
3. The worker finds the USB alternate named `IIO`, enumerates its bulk endpoint
   pairs, resets/opens IIOD pipes with the firmware vendor requests, and asks
   IIOD for its live XML with `PRINT`.
4. It finds `ad9361-phy`, `cf-ad9361-lpc` (RX) and
   `cf-ad9361-dds-core-lpc` (TX) by name, then derives channel masks and sample
   layout from their scan elements. Never depend on `iio:device1` or interface
   and endpoint numbers staying fixed.
5. The worker streams interleaved signed 16-bit IQ through a shared-memory ring.
   The C++ GNU Radio block converts between those raw slots and `gr_complex`.

Compiling libiio/libusb into a Wasm side module is deliberately avoided. The
browser's USB API is asynchronous, while GNU Radio's scheduler and this
`MAIN_MODULE`/`SIDE_MODULE` build are synchronous and threaded. The Worker plus
`SharedArrayBuffer`/futex pattern already solves that boundary for RTL-SDR and
does not impose Asyncify or JSPI on the whole runtime.

## Source and Sink behavior

The receive-only Source and transmit-only Sink are independent blocks. A single
physical Pluto may be owned by only one of them in a running flowgraph. Separate
Plutos may be used together when every block explicitly selects a distinct
serial. A coordinated RX/TX block is intentionally deferred; do not weaken the
ownership check to simulate full duplex with two independent workers.

RX cannot backpressure live RF. When its ring is full, the worker drops the
newest complete IIO buffer and records an overrun and lost-sample count. TX does
backpressure its upstream GNU Radio block and never intentionally discards a
sample. If the ring cannot supply a full IIO buffer in time, the worker records
an underflow.

TX attenuation is represented as a positive magnitude (`0` through `89.75`
dB), then written to IIO as its negative `hardwaregain` value. The default is
`89.75` dB. Before opening TX, the worker zeros the DDS raw controls. On every
normal or error close it tries to restore `-89.75` dB before releasing USB.

Center frequency, RF bandwidth, RX manual gain and TX attenuation have live
numeric setters. Sample rate, number of channels, gain-control modes,
correction switches and IIO buffer size are construction-time settings.

## Single and dual channel

One RF channel consists of two scan elements: I and Q. The block exposes one
complex GNU Radio port per RF channel. It validates the live context before
streaming, so selecting Dual on an ordinary 1R1T Pluto gives a capability error
rather than corrupting the interleave.

Dual mode needs hardware that genuinely exposes two RX or TX RF paths. In
practice this normally means a suitable Rev C Pluto configured for 2R2T using
official firmware settings and physically modified to make the second RF ports
available. The firmware setting alone does not add connectors or RF matching.
The 2R2T sample-rate ceiling is 30.72 MS/s; single-channel mode can request up
to 61.44 MS/s.

## Files and rebuilds

- GRC metadata: `blocks/grc/wasm_plutosdr_{source,sink}.block.yml`
- C++ blocks and shared ABI: `blocks/src/plutosdr_*`
- USB/IIOD worker: `runner/src/plutosdr_worker.js`
- worker launcher and diagnostics: `runner/src/runner.html`
- WebUSB picker and ownership validation: `editor/src/plutosdr.ts`
- factories: `runner/src/registry.cpp`

After metadata or factory changes, regenerate both registries and rebuild the
runner and editor as described in `docs/blocks.md`.

## Testing

The Worker accepts Device `fake` or `fake:<tone-hz>` for automated browser
tests. Fake RX produces a half-scale complex tone per channel; fake TX consumes
and paces buffers without opening USB. This validates the shared ABI, ring
direction, port counts, scheduler behavior and stop path, but not IIOD.

For real hardware, test all of these separately:

- `PRINT` parses the current context and resolves devices by name;
- Source Single moves samples for several IIO buffers without overruns;
- Source Dual is rejected clearly on a 1R1T Pluto;
- Sink Single sends a low-amplitude test signal into a shielded load or suitable
  test setup, starting at 89.75 dB attenuation;
- live frequency/bandwidth/gain or attenuation changes are acknowledged;
- stopping TX restores maximum attenuation and releases the USB interface;
- unplugging reports the USB failure to the flowgraph console.

Full Chrome is required for real WebUSB tests; headless Chrome shells do not
expose the chooser. Follow the persistent-profile permission pattern described
in `docs/rtlsdr.md` and `test/hw/grant.mjs`.

Do not treat USB/IP attachment to WSL as proof that the IIOD bulk transport is
usable. With the test Pluto, WSL could enumerate and claim interface 5, send the
vendor reset/open requests, and send `PRINT`, but the response on the bulk IN
endpoint timed out in both Chrome WebUSB and a direct libusb diagnostic. Test
the real WebUSB path in Chrome on the native host instead. This is a host USB/IP
limitation, not a requirement for users to install or expose a libusb API: the
browser only needs to see the stock firmware's USB IIO interface.
