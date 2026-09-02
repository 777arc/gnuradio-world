# Signal Hound BB60 Source

Read this before changing `wasm_bb60_source`, its WebUSB worker or its tuning
tables. The general hand-written block rules in `docs/blocks.md` still apply.

## What is different about this one

Every other radio here speaks a protocol somebody published. The BB60's is not
published, and the only implementation is Signal Hound's closed `libbb_api`.
Everything in `runner/src/bb60_worker.js` was derived by differential capture of
that library driving a real BB60C over libusb, cross-checked against the
library's symbol table, which is not stripped. **There is no upstream reference
to check a change against — the captures are the specification.** That is why
`runner/test/bb60_worker.test.mjs` pins the tuning arithmetic to 56 packets
actually observed on the wire; if you change the tuning code, that test is what
tells you whether the device would still tune.

## User setup

The block supports the BB60C and BB60D, which both enumerate as the Cypress FX3
pair `2817:0005`. No bb_api installation and no helper process: a Chromium
browser drives the device directly with WebUSB.

Click Add beside Device or press Run to grant the site access. The `.grc` keeps
only the USB serial number; a worker in the runner frame re-acquires the device
through the origin's persistent permission.

On Linux the browser user needs access to the USB node, and no native program —
Spike included — may have the device open. A udev rule such as

    SUBSYSTEM=="usb", ATTRS{idVendor}=="2817", MODE="0666"

in `/etc/udev/rules.d/` is enough. Firefox and Safari do not implement WebUSB.

**On Windows the device has to be rebound to WinUSB.** Signal Hound's driver is
Cypress's `cyusb3.sys`, and `cyusb3.inf` claims `VID_2817&PID_0005` explicitly.
WebUSB can only open a device bound to WinUSB, so with the stock driver in place
`USBDevice.open()` fails with "Access denied". Zadig is the usual way to rebind
it. That swap is what makes the device invisible to Spike, and it is reversed by
pointing Device Manager back at `drivers/x64` under the Spike installation.

Two things produce the identical "Access denied", so check both: a device left
bound by `usbipd bind` (it shows as `Shared` in `usbipd list`, and the stub
driver owns it even when not attached to WSL) needs `usbipd unbind --busid <id>`
before Windows — or Chrome — can touch it at all.

Note also that usbipd forwarding into WSL is not a usable way to run this block.
The device streams a constant 140 MB/s, and the vhci link drops under that load
(`vhci_hcd: connection closed`), taking the device with it.

## The one fact that shapes the whole block

**The device has no decimation to ask for.** It always streams real 16-bit
samples at a fixed 70 MS/s, 140 MB/s, and every bit of tuning below that is done
by the host. That is not a simplification of the vendor design, it *is* the
vendor design: changing the decimation produces no change whatsoever in the USB
traffic, and `libbb_api`'s own `EngineIQ` does the mixing and filtering in IPP on
the CPU.

So the Sample Rate parameter selects a decimation of a fixed 70 MS/s stream, and
a flowgraph pays the full 140 MB/s USB and ring cost no matter how narrow the
output is. On a slow machine or a busy tab the ring overruns; overruns and lost
samples are counted and printed.

## There is no low-rate device mode (measured)

The obvious optimisation — ask the device to decimate and stream 1 MS/s instead
of 70 — does not exist. Measured USB throughput with the vendor library driving
the device, three seconds per mode:

| bb_api mode | what it returns | USB throughput |
|-------------|-----------------|----------------|
| `BB_STREAMING` | IQ at any decimation | 141.8 MB/s |
| `BB_AUDIO_DEMOD` | **32 kS/s of audio** | 141.8 MB/s |
| `BB_REAL_TIME` | frames + traces | 141.7 MB/s |
| `BB_SWEEPING` | 514-point traces | 60.2 MB/s |

The device turns out to have only two acquisition types, selected by byte 4 of
the configure command: **fixed-tune (2)** and **swept (1)**. `BB_STREAMING`,
`BB_AUDIO_DEMOD` and `BB_REAL_TIME` all send the *identical* fixed-tune pair —
configure then arm — and differ only in what `libbb_api` then does with the
samples on the host. That is why all three measure the same 141.8 MB/s. Sweep
mode instead sends a stream of retune commands (338 of them across a 20 MHz
span in the run above).

This block uses the fixed-tune type, which is the only one that yields IQ. Its
two packets are byte-identical to the vendor's `BB_STREAMING` pair outside the
band, LO and gain fields.

Audio demodulation is the decisive one. It returns 32 kS/s — a 2000:1 reduction
— and the device still sends every one of its 70 M samples per second, with
`libbb_api` doing the FM demodulation on the host. If the hardware could
decimate at all, that is where the vendor would use it.

Sweep mode is lower only because the device spends much of its time retuning
across the span; it is still shipping raw samples for the host to transform, and
it is not an IQ path.

So a BB60 flowgraph costs 140 MB/s of USB and the ring that goes with it no
matter what Sample Rate says. Sample Rate buys CPU, never bandwidth.

Two smaller findings from the same experiment: `bbConfigureIQ` silently ignores
a decimation that is not a power of two (asking for 70 yielded 40 MS/s, i.e. 1),
and this block is not bound by that, because it does its own DDC and accepts any
integer decimation of 70 MS/s.

## USB protocol

| ep | dir | use |
|----|-----|-----|
| 0x01 | OUT | commands, fixed 1024-byte packets |
| 0x81 | IN | sample blocks |
| 0x82 | IN | sample blocks, interleaved with 0x81 |

No control transfers are used at all. Three opcodes appear in byte 0: `0x00`
configure, `0x11` stream poll, `0x15` abort.

**Device open** is a 14-command sequence that is byte-identical across every
centre frequency, sample rate and gain tested, and across repeat runs. It is
replayed verbatim from a captured blob at the top of the worker rather than
synthesised, because nothing in it needs to vary. It takes about 2 seconds,
most of which is a band-zero calibration sweep the device runs on its own.

**Configuration** is one packet with only thirteen non-zero bytes, sent twice —
byte 16 is `0` to configure and `1` to arm, and that byte is the only difference
between the two:

    off 4    for opcode 0x00: acquisition type, 1 = swept, 2 = fixed-tune
    off 16   STOP flag: 0 = stream with this tuning, 1 = halt
    off 17   band group (64, 65, 66, 67)
    off 19   (band index << 5) | attenuation code
    off 20   u16 band constant
    off 22   u16 LO word
    off 529  preamp / bias byte

## Tuning

The band plan, the LO grid and the attenuation codes were measured over 1046
captured tuning commands (10 MHz across the whole range, plus 5 kHz steps over a
2 MHz window).

| band | range (MHz) | b17 | u20 | first IF (Hz) |
|-----:|-------------|----:|----:|--------------:|
| 0 | 0.009 – 10 | 64 | 32 | 160 400 000 |
| 2 | 20 – 1880 | 64 | 512 | 2 420 400 000 |
| 3 | 1890 – 2500 | 64 | 272 | 1 220 400 000 |
| 3 | 2510 – 3140 | 64 | 216 | 1 220 400 000 |
| 4 | 3150 – 4200 | 65 | 456 | 2 420 400 000 |
| 5 | 4210 – 5100 | 66 | 512 | 2 420 400 000 |
| 6 | 5110 – 5500 | 66 | 216 | 1 220 400 000 |
| 7 | 5510 – 6400 | 67 | 216 | 1 220 400 000 |

    LO word = 2 * floor((centre_Hz + band IF_Hz) / 800000), capped at 19026

**Compute this in integer hertz.** The LO grid is 0.8 MHz — the word counts in
0.4 MHz units but is always even — and floating point gets it wrong in a way
that is easy to miss: `(1690 + 2420.4) / 0.8` is `5137.999999999999` in doubles,
so flooring it puts the LO a whole step low. The integer form misses none of the
1046 captured commands; the float form misses 190 of them. The word saturates at
19026, a little above 6.39 GHz.

Band 1 (byte 19 high bits `0x39`, roughly 10–20 MHz) was never observed; the
sweep stepped straight from 10 to 20 MHz. The block currently treats everything
below 10 MHz as band 0.

## Sample stream

Each 256 KB transfer is 8 blocks of 32768 bytes, and **each block carries its own
32-byte header** — magic `01 02 0a 0c`, then a sequence counter repeated eight
times at word 8. Samples are real `int16` from word 16 to the end of the block.

Blocks alternate strictly between the two endpoints in global sequence order:

    seq:      974  975  976  977 ...
    endpoint: 0x81 0x82 0x81 0x82 ...

so the worker reassembles by sequence number rather than by arrival, and a gap
that survives more than one transfer is counted as loss. Forgetting the
per-block headers is the easiest way to corrupt this stream: the header word
`0x7e00` then appears once every 16384 words looking like a sample spike.

## Byte 16 stops the device, it does not arm it

This is the single easiest thing to get backwards, and getting it backwards
costs days. **Byte 16 clear (0) starts streaming with the tuning in the packet.
Byte 16 set (1) stops it.**

A capture makes it look like a configure/arm pair, because a short test program
initiates and aborts within a few tens of milliseconds:

    2.1533   op=0x00 b4=2 b16=0
    2.1890   op=0x00 b4=2 b16=1     <- 36 ms later: looks like "arm"

Capture a program that actually streams for three seconds and the same two
commands are three seconds apart:

    2.3552   op=0x00 b4=2 b16=0     <- start
    5.3921   op=0x00 b4=2 b16=1     <- stop, at shutdown

Sending the byte-16=1 packet at startup tells the device to stop. It emits the
little that is already in flight -- half a megabyte or so -- and then goes
silent for good. That failure is indistinguishable from being unable to drain
140 MB/s: no errors, no stall status, transfers simply never complete again.
It reproduces identically under WebUSB, pyusb and native async libusb, which is
what finally ruled out throughput as the cause.

Retuning is therefore a stop followed by a fresh start, and shutdown must send
the stop packet or the device keeps pushing at a host that is no longer there.

## Reads must be in flight before the start

The device pushes its full rate the instant the start packet lands and does not
throttle, so all transfers are posted first and the start command sent last.
The same applies during open: the device runs a band-zero calibration sweep of
its own and streams while it does so, so the pumps run across the whole open
sequence, discarding, and the open commands are paced at the vendor's measured
cadence (85 ms, then 168 ms between the calibration polls, then a 25 ms settle
after the abort). Firing the open commands back to back without reading leaves
the device wedged before it is ever started.

With all of that right, a native async libusb replay of exactly the bytes this
worker sends sustains **140.2 MB/s indefinitely**, matching the vendor.

## Confirmed in a browser

Chrome on Windows, WebUSB, 8 transfers of 1 MiB in flight, decimating 70:1 to
1 MS/s: **70.0 MS/s in, 0% ring, no ring drops, no sequence gaps**, holding
steady past a gigabyte. So both halves keep up -- WebUSB sustains the
140 MB/s, and the C++ DDC consumes 70 MS/s while producing 1 MS/s.

Two numbers in the per-second line are normal rather than symptoms: `pending`
settles around 33 blocks, which is ordinary skew between the two endpoints and
far inside the reorder window, and `stale` shows a handful at startup, which is
calibration-sweep data still in flight when the stream starts. Both are flat.
`ringDrops` or `seqGaps` climbing, or a rate below 70 MS/s, are the real
warnings.

## The DDC, and why it is in C++

`blocks/src/bb60_source.cpp` does what `EngineIQ` does: mix the requested centre
down from where it lands in the 70 MS/s stream, then decimate.

**The decimator is a fourth-order CIC followed by an FIR, and it has to be.**
An integrate-and-dump -- a first-order CIC by the whole factor -- rejects only
about 6 dB at the edge of the band it keeps, and the device delivers 27 MHz of
analogue bandwidth, so every strong signal in that span folds into the output.
On a real FM band that put spurious humps 5-11 dB high at the band edges, which
look exactly like stations that are not there. Measured against an ideal filter on
captured samples, the single-stage version put up to 13.6 dB of spurious energy
at the band edges; the two-stage version tracks the ideal to within 0.1 dB.

The FIR's length is computed from the transition it actually has to make -- the
first alias folds in at (output rate minus passband edge) -- rather than being a
fixed count. A wide Filter Bandwidth leaves a narrow transition and needs a long
filter: the 80% default at 2 MS/s needs 139 taps, where at 1 MS/s it needs 55.
If a flowgraph starts reporting ring drops, narrowing Filter Bandwidth is the
cheapest thing to try, because it shortens that filter directly.

The CIC decimates to a few times the output rate and an FIR does the sharp cut
and the last small factor (the smallest divisor of the decimation between 2 and
5). Splitting 35 as 7x5 rather than doing it in one stage is worth 60 dB at the
band edge. That matters because a CIC's response nulls sit at
multiples of its own output rate, which is where folding happens: leaving a
factor of two for the FIR puts the fold points twice as far from the retained
band, worth roughly 45 dB at the band edge. The FIR is designed by integrating
the desired response rather than windowing a sinc, because it also has to undo
the CIC's passband droop (about 2.3 dB at the band edge, fourth order).

The CIC uses wrap-around unsigned accumulators. Its integrators are meant to
overflow -- the comb stages recover the correct value from the wrapped ones --
so this is not something to "fix" with saturating or floating-point
accumulators; floats lose the low bits as the integrators grow and the output
degrades over minutes.

The worker publishes `offset_hz`, the digital position of the tuned centre, and
the block's NCO simply undoes it. The worker owns that arithmetic because it
owns the protocol; the block only needs the residual. This matters because the
LO lands up to a full 0.8 MHz step off the request — the residual is not a
rounding detail, it is the reason there is an NCO at all.

    digital centre = band IF + 13.4 MHz - LO + centre

The 13.4 MHz second IF was measured against three FM stations in band 2, all
agreeing to 0.03 MHz. **It is assumed, not measured, for the other bands.** If a
signal comes out at the wrong offset above 1.88 GHz, that constant is the first
thing to check.

## Reference level

Reference level is the front-end gain, and it is taken straight from the vendor
rather than modelled: byte 19's low five bits are RF attenuation in ~5 dB steps,
byte 529 switches path above -10 dBm, and the attenuation restarts there. The
table in the worker was measured by sweeping `bbConfigureRefLevel` from -90 to
+20 dBm and reading the resulting command.

Getting byte 529 wrong is expensive and silent: set to 128 at a low reference
level it costs roughly 20 dB of sensitivity, and the spectrum simply looks like
a flat noise plateau with no stations in it.

## Matching what Spike shows

Checked against Spike at 95.6 MHz, 2 MHz span, reference level -70 dBm: station
frequencies come out at 95.5004, 95.7006, 95.8969 and 96.2953 MHz, all within
5 kHz of the FM channel grid, and the dynamic range matches to about a dB.

One thing surprises people: Filter Bandwidth defaults to 80% of the sample rate,
so a 2 MS/s flowgraph shows a clean 1.6 MHz and rolls off either side. Spike's
2 MHz span is a swept measurement and shows the whole width. To see the same
span here, raise Filter Bandwidth towards the sample rate -- but the filter is
capped at 191 taps, and above roughly 85% of the sample rate there is no longer
enough transition band for it, so edge aliasing returns. 80% is alias-free;
95% is a picture, not a measurement.

## Not calibrated

The device's per-unit calibration tables live in its flash and have not been
decoded, so amplitudes are in uncalibrated units, not dBm. Frequency, sample
rate and every relative measurement are unaffected. Decoding the flash is the
work that would make this a calibrated instrument rather than a receiver.

## Files and rebuilds

- metadata: `blocks/grc/wasm_bb60_source.block.yml`
- C++ block and DDC: `blocks/src/bb60_source.{hpp,cpp}`
- worker: `runner/src/bb60_worker.js`
- tuning regression test: `runner/test/bb60_worker.test.mjs` (plain Node)
- launcher/stats: `runner/src/runner.html`
- picker: `editor/src/bb60.ts`, registered in `editor/src/main.ts`
- factory: `runner/src/registry.cpp`

After metadata or factory changes regenerate the registry and palette, rebuild
the runner, then run the editor check as described in `docs/blocks.md`.
