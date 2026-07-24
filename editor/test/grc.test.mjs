import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

console.log('checked .grc round-trip and byte-exact formatting');
