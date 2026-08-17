import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleFiles } from './example-files.mjs';
import { bundleModule } from './bundle-module.mjs';
import { mainSource as main } from './editor-contract-source.mjs';

// grc.ts is TypeScript and pulls in js-yaml, so bundle it to an importable mjs.
const out = join(tmpdir(), `grc-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/grc.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const { dumpGrc, parseGrc, emitScalar } = await import(pathToFileURL(out));

// ---- byte-for-byte format (matches PyYAML's GRCDumper: 4-space indent,
// "-   name" sequences, flow coordinate/connections, single-quoted numerics) ----
const doc = {
  options: { parameters: { id: 'top', generate_options: 'qt_gui', max_nouts: '0', run: 'True' },
             states: { coordinate: [10, 10], rotation: 0, state: 'enabled' } },
  blocks: [{ name: 'x1', id: 'analog_sig_source_x',
    parameters: { samp_rate: '32000', waveform: 'analog.GR_COS_WAVE', type: 'complex', grid: 'False', mod_code: '"gray"', amplitude: '1' },
    states: { coordinate: [50, 70], rotation: 0, state: 'enabled' } }],
  connections: [['b1', '0', 'b2', '0']],
  metadata: { file_format: 1, grc_version: '3.11.0.0' },
};
const expected = `options:
    parameters:
        id: top
        generate_options: qt_gui
        max_nouts: '0'
        run: 'True'
    states:
        coordinate: [10, 10]
        rotation: 0
        state: enabled
blocks:
-   name: x1
    id: analog_sig_source_x
    parameters:
        samp_rate: '32000'
        waveform: analog.GR_COS_WAVE
        type: complex
        grid: 'False'
        mod_code: '"gray"'
        amplitude: '1'
    states:
        coordinate: [50, 70]
        rotation: 0
        state: enabled
connections:
- [b1, '0', b2, '0']
metadata:
    file_format: 1
    grc_version: 3.11.0.0
`;
assert.equal(dumpGrc(doc), expected, '.grc output must match GRC/PyYAML formatting byte-for-byte');

// ---- scalar quoting rules (PyYAML SafeDumper, allow_unicode=False) ----
assert.equal(emitScalar('analog.GR_COS_WAVE'), 'analog.GR_COS_WAVE', 'identifiers stay plain');
assert.equal(emitScalar('32000'), "'32000'", 'integer-like strings are quoted');
assert.equal(emitScalar('-1'), "'-1'", 'negative-int-like strings are quoted');
assert.equal(emitScalar('0.1'), "'0.1'", 'float-like strings are quoted');
assert.equal(emitScalar('True'), "'True'", 'bool-like strings are quoted');
assert.equal(emitScalar(''), "''", 'empty strings are quoted');
assert.equal(emitScalar('"gray"'), `'"gray"'`, 'strings containing quotes are single-quoted');
assert.equal(emitScalar('a → b'), '"a \\u2192 b"', 'non-ASCII is escaped in a double-quoted scalar');
assert.equal(emitScalar('frame_size*8'), 'frame_size*8', 'expressions stay plain');

// ---- round-trip: dump -> parse -> dump is stable and preserves values ----
const text = dumpGrc(doc);
const back = parseGrc(text);
assert.equal(back.blocks[0].parameters.waveform, 'analog.GR_COS_WAVE');
assert.equal(back.blocks[0].parameters.mod_code, '"gray"');
assert.equal(back.blocks[0].parameters.samp_rate, '32000', 'quoted numerics parse back as strings');
assert.deepEqual(back.blocks[0].states.coordinate, [50, 70], 'coordinate round-trips as numbers');
assert.deepEqual(back.connections[0], ['b1', '0', 'b2', '0'], 'connections round-trip');
assert.equal(dumpGrc(back), text, 'dump -> parse -> dump is a fixed point');

// ---- the flowgraph id is derived from the Options Title ----
// The Options block has no ID of its own, so nothing carries a loaded one into
// the model; `id` is regenerated from the Title on the way out. It ends up as a
// class and file name in native's generated Python, so whatever the Title is, it
// has to come out matching the rule native validates ids against.
assert.match(main, /id: OPTIONS_ID, name: OPTIONS_ID/,
  'the Options block must not hold a flowgraph id of its own');
assert.match(main, /const optionParams: Record<string, GrcScalar> = \{ generate_options: 'qt_gui', id: flowgraphId\(\) \}/,
  'the saved .grc must carry the derived flowgraph id');
const derivedId = title => {
  const id = String(title || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!id) return 'default';
  return /^[A-Za-z]/.test(id) ? id : `fg_${id}`;
};
assert.match(main,
  /const id = String\(opt\?\.params\.title \|\| ''\)\.trim\(\)\.replace\(\/\[\^A-Za-z0-9_\]\/g, '_'\);\s*if \(!id\) return DEFAULT_FLOWGRAPH_ID;\s*return \/\^\[A-Za-z\]\/\.test\(id\) \? id : `fg_\$\{id\}`;/,
  'this test re-implements flowgraphId(); keep the two in step');
assert.equal(derivedId('RDS Receiver'), 'RDS_Receiver', 'spaces become underscores');
assert.equal(derivedId('AX.25 deframer (US01)'), 'AX_25_deframer__US01_');
assert.equal(derivedId('DroneID — Mavic 3'), 'DroneID___Mavic_3', 'non-ASCII becomes underscores too');
assert.equal(derivedId(''), 'default', 'an untitled flowgraph gets the native default id');
assert.equal(derivedId('   '), 'default');
assert.equal(derivedId('8PSK Demo'), 'fg_8PSK_Demo', 'a leading digit is not a legal id');
assert.equal(derivedId('_private'), 'fg__private', 'nor is a leading underscore');
// Whatever a title throws at it, the result has to be a usable identifier.
for (const file of exampleFiles) {
  const title = parseGrc(await readFile(
    new URL(`../../example_flowgraphs/${file}`, import.meta.url), 'utf8')).options?.parameters?.title;
  assert.match(derivedId(title), /^[A-Za-z]\w*$/, `${file} title yields an unusable flowgraph id`);
}

// ---- the Benchmark Tool's hand-written .grc ----
// Those flowgraphs are text that module builds and hands straight to the
// runner, never round-tripped through the editor, so nothing else would notice
// them going malformed. Parsing them here is the guard.
const { benchmarkTables, benchmarkCases } = await bundleModule('../src/benchmark.ts');
const benchmarks = benchmarkCases();
assert.deepEqual(benchmarkTables().map(table => table.key), ['filters', 'chain'],
  'filters are measured first, then the chains');
assert.equal(benchmarks.length, 12,
  'three filters at three tap counts, plus three chain lengths');
assert.equal(new Set(benchmarks.map(benchmark => benchmark.key)).size, benchmarks.length,
  'case keys are unique');
for (const benchmark of benchmarks) {
  const parsed = parseGrc(benchmark.grc);
  const names = parsed.blocks.map(block => block.name);
  // One case per flowgraph: whatever is under test gets the machine to itself,
  // and it is always the block named 'dut' that the rate is read from.
  assert.equal(names[0], 'src', `${benchmark.key}: starts at the Null Source`);
  assert.equal(names[names.length - 1], 'snk', `${benchmark.key}: ends at the Null Sink`);
  assert.ok(names.includes('dut'), `${benchmark.key}: has a block to measure`);
  // Every block is connected in one line, source through to sink.
  assert.equal(parsed.connections.length, names.length - 1, `${benchmark.key}: a chain, not a fan`);
  for (const [index, connection] of parsed.connections.entries())
    assert.deepEqual(connection, [names[index], '0', names[index + 1], '0'],
      `${benchmark.key}: hop ${index} is in series`);

  if (benchmark.key.startsWith('mult:')) {
    const count = Number(benchmark.key.split(':')[1]);
    assert.equal(names.length, count + 2, `${benchmark.key}: ${count} blocks plus source and sink`);
    // GNU Radio runs a thread per block, so a chain's length decides the
    // runner's prewarmed pool: 256 workers is the ceiling, and a chain needing
    // more would start threads on demand from a scheduler thread, which has to
    // proxy each Worker allocation to the main thread.
    assert.ok(names.length + 1 <= 256, `${benchmark.key}: needs more workers than the runner pools`);
    for (const block of parsed.blocks.slice(1, -1)) {
      assert.equal(block.id, 'blocks_multiply_const_vxx', `${benchmark.key}: chain of Multiply Const`);
      assert.equal(block.parameters.type, 'complex', `${benchmark.key}: complex I/O`);
    }
  } else {
    assert.deepEqual(names, ['src', 'dut', 'snk'], `${benchmark.key}: source, filter, sink`);
    const dut = parsed.blocks[1];
    const taps = Number(benchmark.key.split(':')[1]);
    if (benchmark.key.startsWith('scipy:')) {
      // The Python row filters in scipy instead. Its tap count is a parameter of
      // the block's own __init__, and its source has to survive the .grc as one
      // escaped line -- a Python `#` comment in there once truncated the value,
      // so parse it back and check it is the whole program.
      assert.equal(dut.id, 'epy_block', `${benchmark.key}: an Embedded Python Block`);
      assert.equal(dut.parameters.ntaps, String(taps), `${benchmark.key}: tap count`);
      const source = String(dut.parameters._source_code);
      assert.match(source, /^import numpy as np\n/, `${benchmark.key}: source starts intact`);
      assert.match(source, /fftconvolve\(input_items\[0\]/, `${benchmark.key}: work() survived`);
      assert.ok(source.endsWith('return n\n'), `${benchmark.key}: source ends intact`);
    } else {
      // Complex in, complex out, real taps, and no decimation.
      assert.equal(dut.parameters.type, 'ccf', `${benchmark.key}: complex I/O with real taps`);
      assert.equal(dut.parameters.decim, '1', `${benchmark.key}: rate is input and output samples`);
      assert.equal(JSON.parse(String(dut.parameters.taps)).length, taps,
        `${benchmark.key}: tap count`);
    }
  }
}

// ---- Help ▸ SDR Receive Speed Test's private hardware flowgraph -----------
// Like the CPU benchmark cases above, this goes straight to runner.html. Keep
// the numeric-looking USB serial textual and prove the Source really is what
// the Null Sink counts rather than a raw worker-only throughput test.
const { sdrReceiveBenchmarkFlowgraph } =
  await bundleModule('../src/sdr-speed-test.ts');
const speedTests = [
  ['hackrf', 'wasm_hackrf_source', 20000000],
  ['plutosdr', 'wasm_plutosdr_source', 61440000],
  ['rtlsdr', 'wasm_rtlsdr_source', 3200000],
];
for (const [radio, sourceId, rate] of speedTests) {
  const speedTest = parseGrc(
    sdrReceiveBenchmarkFlowgraph(radio, '00000001', rate));
  assert.deepEqual(speedTest.blocks.map(block => block.name),
    ['sdr_source', 'sdr_sink']);
  assert.equal(speedTest.blocks[0].id, sourceId);
  assert.equal(speedTest.blocks[0].parameters.device, '00000001');
  assert.equal(speedTest.blocks[0].parameters.samp_rate, String(rate));
  assert.equal(speedTest.blocks[1].id, 'blocks_null_sink');
  assert.deepEqual(speedTest.connections, [['sdr_source', '0', 'sdr_sink', '0']]);
}
const hackrfSpeed = parseGrc(
  sdrReceiveBenchmarkFlowgraph('hackrf', '00000001', 20000000));
assert.equal(hackrfSpeed.blocks[0].parameters.bandwidth, '0');
assert.equal(hackrfSpeed.blocks[0].parameters.amp, 'False');
const plutoSpeed = parseGrc(
  sdrReceiveBenchmarkFlowgraph('plutosdr', '00000001', 61440000));
assert.equal(plutoSpeed.blocks[0].parameters.channels, '1');
assert.equal(plutoSpeed.blocks[0].parameters.bandwidth, '56000000');
const rtlSpeed = parseGrc(
  sdrReceiveBenchmarkFlowgraph('rtlsdr', '00000001', 3200000));
assert.equal(rtlSpeed.blocks[0].parameters.type, 'complex');
assert.equal(rtlSpeed.blocks[0].parameters.bufflen, '262144');

console.log(`checked .grc round-trip, byte-exact formatting, ${exampleFiles.length} derived flowgraph ids, ` +
  `${benchmarks.length} CPU benchmark cases, and the SDR speed-test flowgraph`);
