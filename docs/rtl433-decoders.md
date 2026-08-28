# Plan for porting rtl_433 decoders

A repeatable path from one rtl_433 device decoder and its upstream regression
capture to a browser flowgraph. Read [blocks.md](blocks.md),
[js-blocks.md](js-blocks.md), and [flowgraph-files.md](flowgraph-files.md) first.
Read [recording-viewer.md](recording-viewer.md) too when the example reads a
capture.

A decoder consumes IQ or a demodulated stream and publishes one
PMT dictionary for every accepted transmission. JSON is test-fixture and
presentation syntax, not the decoder's runtime interface.

IQ captures are never committed to this repository. Publish the selected
upstream sample as a GNU Radio World SigMF recording and use its stable
recording key in both the example and the end-to-end test. This keeps binary
fixtures out of Git while putting the recording behind the Range/CORS behavior
the runner controls and making its datatype, sample rate, frequency, provenance,
and viewer available to users.

## 1. Pin both upstream revisions and select the regression case

Record exact commit hashes for `merbanan/rtl_433` and
`merbanan/rtl_433_tests`; do not build against moving branch heads. Locate:

- the device implementation under `rtl_433/src/devices/`;
- the matching directory under `rtl_433_tests/tests/`;
- one small capture that exercises meaningful decoded fields;
- the companion `.json` containing the expected result. Not all captures have
  one; if none does, ask whether to continue before inventing an oracle.

Copy only the small companion JSON, without modification, into
`test/fixtures/rtl433/<device>/`. Do not copy the IQ capture into the repository.
Document the upstream paths and revisions, immutable upstream URLs, original
recording format, byte length, sample rate, center frequency, SHA-256 checksums,
and the GNU Radio World recording key in that directory's README. The JSON
remains the source of truth for expected values; do not infer them from the
decoder.

Download the capture only into a temporary directory or an explicitly
git-ignored cache while preparing and testing the port. Before continuing, check
that neither the capture nor the resulting `.sigmf-data` is tracked or staged.

## 2. Publish it as a GNU Radio World SigMF recording

Create a SigMF pair for the selected upstream sample and upload both objects to
the `gnuradio-wasm-recordings` R2 bucket under a stable key such as
`rtl433/<device>/<capture>`; follow [recording-viewer.md](recording-viewer.md).
For an rtl_433 `.cu8` capture, the `.sigmf-data` payload should be byte-for-byte
identical to the upstream file: this is metadata packaging, not sample-value
conversion. Set at least:

- `core:datatype` to the actual source representation (`cu8` for `.cu8`);
- `core:sample_rate` and the capture's `core:frequency` from the upstream
  filename or documentation;
- a description and catalog fields that identify the device and rtl_433;
- the pinned `rtl_433_tests` revision, upstream path/URL, original filename,
  byte length, and SHA-256 in the metadata provenance.

After upload, verify that the pair appears in the recording index, that the data
object's SHA-256 is the documented value, and that a one-byte request returns
`206` with a matching `Content-Range`. Do not add either SigMF object to this
repository. Treat replacement of an object at that key as a fixture change:
update its checksum and expected JSON in the same reviewed change.

## 3. Trace the complete rtl_433 pipeline

The device file's `decode_fn` is only the payload tail. Its `r_device` also
selects a modulation/slicer and declares widths, tolerances, gap/reset limits,
and sometimes sync behavior. Before writing code, trace:

1. input formatting and envelope/FM processing in `baseband.c`;
2. burst and pulse extraction in `pulse_detect.c` or the FSK detector;
3. the selected function in `pulse_slicer.c`;
4. bitbuffer transforms and repeat-row selection;
5. every length, sanity, checksum, MIC, and false-positive rejection in the
   device decoder;
6. every output field and its `DATA_STRING`, `DATA_INT`, or `DATA_DOUBLE` type.

Write these facts into the block documentation with the pinned rtl_433 revision.
Preserve boundary inequalities, integer truncation when microseconds become
samples, and state across scheduler `work()` calls. A port that recognizes one
known payload but omits the upstream rejection path is not complete.

## 4. Choose reusable block boundaries

Keep recording-format conversion separate from protocol decoding:

```text
GR World SigMF recording -> format adapter -> protocol decoder -> PMT dictionary
live SDR complex IQ      -----------------> protocol decoder -> PMT dictionary
```

For example, a shared CU8 adapter restores each byte's unsigned value, removes
the 128 bias, forms normalized complex samples, and decimates the interleaved
byte stream by two. Protocol decoders then accept ordinary complex samples, so
the same block works with a live SDR and a regression capture.

Prefer a repository JavaScript block when the decoder is synchronous stream DSP
with modest state. Use C++ under `blocks/src/` when it needs a native library or
a shared native framework would materially simplify several ports. Needing PMT
message output alone is not a reason to leave JavaScript.

Extract a common pulse/demodulation block only after multiple ports prove that
their state machines and boundaries are genuinely identical. Similar timing
parameters do not by themselves make slicers interchangeable.

## 5. Define the PMT output contract

Give each decoder a message output named `out` unless the upstream protocol has
a meaningful reason for more than one. Publish a PMT dictionary that mirrors
rtl_433's decoded data object:

- keys are interned symbols using the exact rtl_433 field names;
- values follow the upstream `data_make()` declarations: `DATA_STRING` uses the
  JavaScript message bridge's documented PMT string representation, `DATA_INT`
  becomes a PMT integer, and `DATA_DOUBLE` becomes a PMT real;
- values remain machine-readable and retain upstream units and scale;
- presentation formatting and JSON serialization belong downstream;
- capture/test-harness metadata such as a fixture's `time` field is not
  synthesized by the decoder.

Keep an expected-field schema beside the test, derived from the upstream
`data_make()` call. JSON does not distinguish an integer from a real whose
current value happens to be `0`, so the test must not infer PMT types from parsed
values alone.

## 6. Add block metadata and regenerate

Add the implementation and its authoritative `.block.yml`:

- JavaScript: `blocks/js/rtl433_<device>.js` and
  `blocks/grc/rtl433_<device>.block.yml` with `flags: [js]`;
- C++: the appropriate `blocks/src/` implementation and GRC metadata, following
  the normal block/factory placement rule.

The metadata owns the palette label, documentation, parameters, and stream and
message ports. The implementation's descriptor must agree with it. Then run:

```bash
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
cmake -S runner -B runner/build
cmake --build runner/build
(cd editor && npm run build)
```

Adding a repository JavaScript block relinks because its ID is compiled into the
generated map. Editing an existing block needs the build's source-copy step;
metadata or descriptor changes also need regeneration.

## 7. Test the hosted recording against the companion JSON

Extend the existing runtime suite rather than creating a new suite per decoder.
The value test must:

1. read the hosted GNU Radio World recording identified by the documented key;
2. pass it through the real shipped format adapter and decoder in multiple work
   calls, so state across scheduler boundaries is exercised;
3. capture the PMT dictionary emitted on `out`;
4. parse the companion JSON and remove only documented harness fields such as
   `time`;
5. convert the remaining expected fields through the decoder's expected-field
   schema;
6. compare the complete PMT dictionary, including keys, PMT types, and values;
7. assert the expected message count so duplicates and false positives fail.

Do not stringify the PMT for comparison. Text equality can hide a wrong PMT
type, and log output is not a substitute for testing the message interface.

After the focused value test passes, rebuild and run the JavaScript end-to-end
suite and the full smoke suite.

Fetch the recording by the documented key, not from a repository fixture. Verify its byte
length and SHA-256 before decoding, and use a temporary file or test-local HTTP
binding if the focused harness needs a local path. A missing recording, checksum
mismatch, or server without working byte ranges is a hard test failure. The
test is therefore network-dependent; do not silently skip it or fall back to an
unverified moving URL.

## 8. Add and run the example flowgraph

Add `example_flowgraphs/rtl_433/<device>.grc` using the same hosted recording.
Use GR World Recording rather than Public HTTP Recording so the example uses
the stable catalog key, derives its type from SigMF, and gets the recording
viewer. The normal path is:

```text
GR World Recording (byte) -> format adapter -> Throttle -> decoder
decoder (out message) -> Message Debug
```

Set the recording type and sample rate from its filename/metadata, pace file
playback with `blocks_throttle2`, connect every required port, and state the
expected decoded fields in the flowgraph description. Message Debug makes the
typed PMT result visible without changing the decoder interface.

Auto-arrange and run every new example through the editor:

```bash
node scripts/arrange_example.mjs rtl_433/<device>.grc
node scripts/run_example.mjs rtl_433/<device>.grc 8090 25 \
  --expect='<distinctive expected field or value>'
```

The editor path is mandatory: it catches parameter-schema, expression, and port
validation failures that a runner-only test skips.

## Definition of done

- Upstream source and test revisions are pinned and documented.
- No IQ capture or `.sigmf-data` is tracked by this repository.
- The byte-identical recording is hosted as a GNU Radio World SigMF pair with
  provenance, a stable key, and a verified checksum; only the companion JSON is
  committed as the expected-value fixture.
- The full demodulator, slicer, validation, and payload path is represented.
- The decoder publishes a typed PMT dictionary, never console-only JSON.
- The real-IQ test compares every decoder-owned field and rejects duplicates.
- Block metadata, generated registration, and the palette agree.
- The example is auto-arranged and passes through the actual editor.
- Focused runtime tests, editor checks, end-to-end tests, and smoke tests pass.
