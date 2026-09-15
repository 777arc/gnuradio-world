# SDRplay RSP1A

Read this before changing `wasm_sdrplay_rsp1a_source`, its WebUSB worker, its
frequency plan or its hardware tests. The general hand-written block rules in
`docs/blocks.md` still apply, and the editor half is the same `UsbRadio` shape
as every other WebUSB radio — see `editor/src/usb-radio.ts`.

## What this is a port of

SDRplay's own API is closed and its Windows driver is not WinUSB, so nothing of
SDRplay's is used. An RSP1A is a Mirics **MSi2500** (USB bridge + ADC) driving an
**MSi001** tuner, and that chipset's protocol is open in two GPL-2 places:

- **[libmirisdr-5](https://github.com/ericek111/libmirisdr-5)** (Miroslav Slugen,
  Leif Asbrink, Edouard Griffiths, Vladisslav P and others) — the whole of
  `runner/src/sdrplay_worker.js` above `const encoder` is a line-for-line port of
  its `hard.c` (sample rate), `soft.c` (tuner + GPIO), `gain.c` and
  `convert/*.c` (frame unpacking). Its "SDRplay" hardware flavour is the
  frequency plan used here.
- the Linux kernel's `drivers/media/usb/msi2500` and `drivers/media/tuners/msi001`,
  which agree on the register writes and settle the control-transfer recipient
  (`USB_TYPE_VENDOR | USB_DIR_OUT`, i.e. recipient *device* — libmirisdr's `0x42`
  recipient bits are ignored by the chip, and matter here because Chrome refuses
  a `recipient: 'endpoint'` transfer whose index does not name a claimed endpoint).

`runner/test/sdrplay_worker.test.mjs` pins the register words to what libmirisdr's
C code emits: its rows were produced by compiling `hard.c`/`soft.c`/`gain.c`
natively with a printing stub for the USB write and comparing all 2340
combinations of rate, frequency, gain, bandwidth and bias tee — zero
mismatches. **If you change the arithmetic, that test is what tells you the
device would still tune the way the driver people run on these radios does.**

## Models

| PID | model | status |
|-----|-------|--------|
| `1df7:3000` | RSP1A | tested, on the unit in this repository's development |
| `1df7:3050` | RSP1B | accepted; RSP1A internals in a metal case, untested |
| `1df7:2500` | RSP1 | accepted; same chips without the notch filters, untested |

RSP2 (`3010`, antenna switching over GPIOs nobody has mapped), RSPduo (`3020`,
two tuners) and RSPdx (`3030`/`3060`, a different front end) are deliberately
not in the table. Adding one is a device-table entry *and* a frequency plan.

**None of these radios carries a USB serial string, and `iProduct` is 0 too.**
So `Device` is `''` (first RSP shared with the site) or a fake; the picker
labels units by PID; two RSPs cannot be told apart; and a flowgraph gets one
RSP block. The editor refuses a second at Run time rather than letting two
workers fight over one device.

## USB protocol

One vendor interface, alternate setting 3 = bulk IN endpoint `0x81` (512-byte
packets). Alternates 1 and 2 are isochronous and unused: bulk is what libmirisdr
uses on Windows and what the HackRF worker already proved under WebUSB.

Control transfers, `requestType: 'vendor', recipient: 'device'`:

| request | meaning | wValue / wIndex |
|---|---|---|
| `0x41` | write register | `((val & 0xff) << 8) \| reg` / `val >> 8` |
| `0x43` | start streaming | 0 / 0 |
| `0x45` | stop streaming | 0 / 0 |

Registers 0–8 are the MSi2500; register 9 is a pass-through to the MSi001,
whose own register number rides in the low nibble of the value.

**Open**: claim interface 0 → `device.reset()` (libmirisdr: "otherwise it
sometimes refuses to communicate"; wrapped in a try, since a usbip-forwarded
device may refuse it) → `0x45` → reg 3 = `0x010000` (ADC asleep) → the fixed
ADC init (reg 8 `0x006080`, reg 5 `0x00000c`, reg 0 `0x000200`, reg 2
`0x004801`, reg 8 `0x00f380`).

**Sample rate** (`rateRegisters`): reg 7 selects the packing format, reg 4 the
PLL fraction, reg 3 the divider/AGC word. The rate is fixed while running: a
change is a stop, three writes and a restart, and the QT sinks would rescale
their axis while the radio kept its old rate — the RTL-SDR precedent.

**Tuning** (`tuningRegisters`): reg 8 = the band's GPIO word (plus the bias-tee
and notch bits), then six reg 9 writes: `0x0e`, AFC, mode/IF/bandwidth/xtal,
synthesiser threshold, synthesiser int/frac, `0x0d`. The 96 MHz reference,
the per-band LO divider and the 12-bit fractional reduction (GCD, then a
divide-down to fit 4095) are libmirisdr's; the arithmetic is BigInt because
`96e6 * n * thresh * 4096` exceeds a double's mantissa. A retune is written
**while streaming** — no stop, no glitch beyond the LO settling.

**Gain** (`gainRegisters`): reg 9 gain word (baseband attenuation, mixer and
LNA reductions, DC-calibration mode) and reg 9 DC-calibration word. Gain is
re-sent after every tune, as libmirisdr does, because the AM path has different
attenuators from the others.

**Stop**: `0x45`, reg 3 = `0x010000`, release. The worker's `stop` message does
the `0x45` immediately so a runner teardown never leaves the device pushing.

## Frequency plan and GPIOs

| from (MHz) | MSi001 path | LO ÷ | reg 8 |
|-----------:|-------------|-----:|------:|
| 0 | AM, 120 MHz up-converting mixer, port 2 | 16 | `f580` |
| 50 | VHF | 32 | `f180` |
| 112 | band III | 16 | `f580` |
| 250 | band III | 16 | `f480` |
| 261 | mode 6 (undocumented) | 8 | `f480` |
| 404 | band IV/V | 4 | `f580` |
| 1000 | L band | 2 | `f580` |

The high byte of reg 8 is the MSi2500's GPIO port, which on an RSP drives the
front-end switches. libmirisdr's comments name GPIO0 as the DAB notch, GPIO2 as
the broadcast-FM notch and GPIO3 as the bias tee; the block exposes those as
`dab_notch`, `fm_notch` and `bias_tee`, OR'd into the band word as bits 8, 10
and 11 of the register value. What the plan's own per-band bits do — bit 2 clear
only in VHF, bit 0 clear only in 250–404 — is consistent with the FM notch
being switched out of the band that contains the FM broadcast band, but has
not been verified against SDRplay's driver. See "Verified on hardware".

## Sample stream

Every USB frame is 1024 bytes: a `u32` little-endian sample counter, 12 junk
bytes, 1008 bytes of payload. The counter advances by the pairs per frame, so a
gap is loss and is counted in `lost_samples`. The payload's packing follows the
sample rate, because the MSi2500 trades bits for rate to stay inside USB 2.0:

| up to | format | bits | bytes/pair | pairs/frame |
|------:|--------|-----:|-----------:|------------:|
| 6.048 MS/s | `252_S16` | 14 | 4 | 252 |
| 8.064 MS/s | `336_S16` | 12 | 3 | 336 |
| 9.216 MS/s | `384_S16` | 10 | 2.5 | 384 |
| 12.096 MS/s | `504_S16` | 8 | 2 | 504 |

The `384` format is the odd one: six blocks of sixteen 10-byte groups, each
block followed by a 32-bit word holding a 2-bit right-shift per group. The
worker unpacks every format to **int16 pairs, left-aligned to full scale**, and
the block scales by `1/32768`, so a flowgraph sees the same amplitude at every
rate. `packPair()` is the exact inverse and is what the `fake` device and the
unit test use.

Bulk data arrives in whole 512-byte packets, so a transfer can only be
misaligned by exactly one packet. The worker detects that as a counter jump
that is not a whole number of frames, drains the queue, reads one 512-byte
packet, and re-primes — libmirisdr's `DEFAULT_BULK_BUFFER - 512` trick.

## Bandwidth and IF

The block is **zero-IF only**. The MSi001 also has 450 kHz / 1.62 MHz / 2.048
MHz low-IF modes, and libmirisdr switches to them for its narrow filters, but it
never subtracts the IF from the LO, so signals come out 450 kHz off-centre.
Not ported. `bandwidth` 0 picks the widest of 200 k / 300 k / 600 k / 1.536 M /
5 M / 6 M / 7 M / 8 MHz that fits the sample rate.

## Gain

One `gain` figure, 0–102 dB, mapped exactly as `mirisdr_set_tuner_gain`:

| gain | LNA | mixer | baseband attenuation |
|-----:|-----|-------|---------------------:|
| 43–102 | full | full | 59 − (gain − 43) |
| 19–42 | reduced (−24 dB) | full | 59 − (gain − 19) |
| 0–18 | reduced | reduced (−19 dB) | 59 − gain |

No AGC: SDRplay's AGC is host software in their API, and the chip has none.

## Files and rebuilds

- metadata: `blocks/grc/wasm_sdrplay_rsp1a_source.block.yml`
- C++ block: `blocks/src/sdrplay_source.{hpp,cpp}` — `Control` and `CTRL` in
  the worker are one layout in two files
- worker: `runner/src/sdrplay_worker.js`
- register/unpack regression test: `runner/test/sdrplay_worker.test.mjs` (plain Node)
- launcher/stats: `runner/src/runner.html` (`__grStartSdrplay`)
- picker: `editor/src/sdrplay.ts`, registered in `editor/src/main.ts`;
  `editor/test/sdrplay.test.mjs` pins the device table to the worker's
- validation: `editor/src/validation.ts`
- factory: `runner/src/registry.cpp`; `runner/src/grc_lower.hpp` keeps `device` a string
- speed test entry: `editor/src/sdr-speed-test.ts`
- smoke fixture: `test/fixtures/sdrplay_fake.grc`
- example: `example_flowgraphs/sdrplay/rsp1a_receive.grc`

After metadata or factory changes regenerate the registry and palette, rebuild
the runner, then run the editor check as described in `docs/blocks.md`.

## Testing without hardware

`Device` = `fake` or `fake:<tone Hz>` opens no USB. The fake packs a half-scale
tone into MSi2500 frames with `packPair()`, counter and all, so the smoke case
exercises the unpacker, the counter bookkeeping, the ring and the mailbox.

## With hardware

```bash
node test/hw/grant.mjs --sdrplay            # once: a real Chrome window, click through the chooser
node test/hw/sdrplay_hw.mjs --freq 100.1e6  # RUNNING, rate, retune moves a carrier, reopen
node test/hw/sdrplay_hw.mjs --all-rates     # every packing format
node test/hw/sdrplay_hw.mjs --band-sweep    # one tune per front-end path
node test/hw/sdrplay_hw.mjs --gain-sweep    # noise floor monotonic in gain
node test/hw/sdrplay_hw.mjs --notch         # FM/DAB notch and bias-tee bits
```

The harness needs the full Chrome for Testing and the persistent profile under
`test/hw/.profile`, exactly as `docs/rtlsdr.md` describes. On WSL the device is
`usbipd attach`ed into the distro and Chrome runs under WSLg; SDRplay's
service, if installed, must not be running.

## Platform notes

- **Chromium only**, like every WebUSB block.
- **Linux**: the kernel has `msi2500`/`msi001` V4L2 drivers for the original
  Mirics dongles; they do not bind to the RSP PIDs, but if they ever do,
  blacklist them. A udev rule for vendor `1df7` gives the browser access.
- **Windows**: SDRplay's driver is not WinUSB; Zadig to WinUSB, which makes
  SDRuno unable to see the device until reverted.
- **WSL**: as `docs/rtlsdr.md` — Chrome on Windows cannot see a device attached
  to WSL and vice versa.

## Verified on hardware

Filled in from `test/hw/sdrplay_hw.mjs` runs against the RSP1A; see the run
log in the pull request that added the block. Anything not listed here is
*ported, not verified*.
