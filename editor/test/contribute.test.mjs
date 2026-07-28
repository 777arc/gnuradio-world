import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// contribute.ts is TypeScript, so bundle it to an importable mjs.
const out = join(tmpdir(), `contribute-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/contribute.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const { EXAMPLES_REPO, sanitizeExampleName, examplePath, newExampleFileUrl } =
  await import(pathToFileURL(out));

// ---- file name sanitising ----
const names = {
  'My FG': 'My_FG.grc',
  'psk_constellation': 'psk_constellation.grc',
  'already.grc': 'already.grc',
  'CASE.GRC': 'CASE.grc',              // extension normalised, stem untouched
  'ofdm  tx': 'ofdm_tx.grc',           // runs of junk collapse to one underscore
  'wide/band scan': 'band_scan.grc',   // only the last path segment survives
  '../../etc/passwd': 'passwd.grc',    // traversal cannot escape the examples dir
  'C:\\flow graphs\\fm.grc': 'fm.grc',
  'ünïcode ☃': 'n_code.grc',           // non-ASCII folded to _, edges trimmed
  '': 'flowgraph.grc',
  '   ': 'flowgraph.grc',
  '...': 'flowgraph.grc',
  '///': 'flowgraph.grc',
  '.grc': 'flowgraph.grc',
  '__lead_and_trail__': 'lead_and_trail.grc',
};
for (const [input, expected] of Object.entries(names))
  assert.equal(sanitizeExampleName(input), expected, `sanitizeExampleName(${JSON.stringify(input)})`);

assert.equal(sanitizeExampleName(null), 'flowgraph.grc');
assert.equal(sanitizeExampleName(undefined), 'flowgraph.grc');

// Long names are capped (plus the extension) and never end in a separator.
const long = sanitizeExampleName('a'.repeat(200));
assert.equal(long, 'a'.repeat(64) + '.grc');
assert.ok(!/[._-]\.grc$/.test(sanitizeExampleName('x'.repeat(63) + '_tail')));

// ---- repo path + GitHub hand-off URL ----
assert.equal(EXAMPLES_REPO.dir, 'example_flowgraphs');
assert.equal(examplePath('My FG'), 'example_flowgraphs/My_FG.grc');
assert.equal(newExampleFileUrl('My FG'),
  'https://github.com/777arc/gnuradio-world/new/main?filename=example_flowgraphs%2FMy_FG.grc');
// Unsafe input is sanitised before it reaches the URL, and the result stays a
// single query parameter (no stray & or # can be injected through the name).
const hostile = newExampleFileUrl('a&b#c=d/../../evil');
assert.equal(hostile,
  'https://github.com/777arc/gnuradio-world/new/main?filename=example_flowgraphs%2Fevil.grc');
assert.equal(hostile.split('?').length, 2);

console.log('contribute tests passed');
