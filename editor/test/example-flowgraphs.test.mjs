// Every .grc in example_flowgraphs/ has to survive the editor's Run path.
//
// These files are loaded through the editor, not handed straight to the runner,
// so they may use GRC parameter expressions (`2*math.pi*1000/samp_rate`,
// `[1/samp_per_sym] * samp_per_sym`) — resolveParamsForRun() evaluates them via
// src/expr.ts before the runner ever sees them. What that path cannot survive is
// an expression expr.ts does not implement: the parameter is then passed through
// as raw text and the C++ factory rejects it at construction time, so the example
// is dead on Run with no earlier warning.
//
// This checks the two failure modes that produce exactly that, without needing a
// browser or a built runner:
//   1. the file parses as GRC at all (a stray apostrophe inside a single-quoted
//      scalar is silently tolerated by the runner's lenient YAML subset but not
//      by the editor, nor by native GRC);
//   2. every numeric/raw parameter is either a literal or evaluates against the
//      flowgraph's own variable scope.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// expr.ts/grc.ts are TypeScript; bundle them to importable mjs (as expr.test.mjs does).
const out = join(tmpdir(), `examples-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('./_example-entry.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const { evaluate, buildScope, parseGrc } = await import(pathToFileURL(out).href);

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const byId = new Map((library.blocks || []).map(b => [b.id, b]));

// This MUST mirror main.ts exactly. An earlier version of this test was more
// permissive than the editor (it treated every `${ ... }` dtype as evaluated),
// so it green-lit an example the Run path then failed to resolve. If the set
// below drifts from EVALUATED_DTYPES in main.ts, this test stops being evidence.
const EVALUATED_DTYPES = new Set([
  'int', 'real', 'float', 'hex', 'raw',
  'int_vector', 'real_vector', 'float_vector', 'complex_vector',
]);

// GRC dtypes can be templated on another parameter (`${ type.taps }`); resolve
// through that parameter's option_attributes, as main.ts's effectiveDtype does.
function effectiveDtype(block, def, param) {
  const dtype = String(param.dtype ?? '');
  const match = dtype.match(/^\$\{\s*([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\}$/);
  if (!match) return dtype;
  const value = String(block.parameters?.[match[1]] ?? '');
  if (!match[2]) return value;
  const source = (def.params || []).find(q => q.id === match[1]);
  const index = source?.options?.indexOf(value) ?? -1;
  return index >= 0 ? String(source?.option_attributes?.[match[2]]?.[index] ?? '') : '';
}

// Fail loudly if main.ts's set and this one stop agreeing.
{
  const src = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const block = src.match(/const EVALUATED_DTYPES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'main.ts no longer defines EVALUATED_DTYPES');
  const theirs = new Set([...block[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  assert.deepEqual([...theirs].sort(), [...EVALUATED_DTYPES].sort(),
    'EVALUATED_DTYPES in main.ts and this test have drifted apart');
}

const dir = new URL('../../example_flowgraphs/', import.meta.url);
const files = (await readdir(dir)).filter(f => f.endsWith('.grc')).sort();
assert.ok(files.length > 0, 'no example flowgraphs found');

let checked = 0;
for (const file of files) {
  const text = await readFile(new URL(file, dir), 'utf8');

  let doc;
  try {
    doc = parseGrc(text);
  } catch (err) {
    assert.fail(`${file}: does not parse as GRC (${err.message})`);
  }
  assert.ok(Array.isArray(doc.blocks) && doc.blocks.length > 0,
    `${file}: parsed to no blocks — check quoting in the options block`);

  const scope = buildScope(doc.blocks
    .filter(b => b.id === 'variable')
    .map(b => ({ id: b.id, name: b.name, params: b.parameters })));

  for (const block of doc.blocks) {
    const def = byId.get(block.id);
    if (!def) continue;                       // variables and unknown ids
    for (const param of def.params || []) {
      if (!EVALUATED_DTYPES.has(effectiveDtype(block, def, param))) continue;
      // A `raw` param that declares options is an enum in disguise
      // (analog_sig_source_x.waveform); the Run path deliberately leaves those
      // symbolic and wasm_registry::choice() matches them on the C++ side.
      if (param.options) continue;
      const raw = block.parameters?.[param.id];
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (!value || Number.isFinite(Number(value))) continue;   // already literal
      // A bare name is a variable or live-control reference, which the runner
      // resolves itself.
      if (/^[A-Za-z_]\w*$/.test(value)) continue;
      // Symbolic constants and runtime-object constructors (window.WIN_HAMMING,
      // digital.constellation_bpsk().base()) are passed through by design. Only
      // arithmetic has to survive expr.ts.
      if (!/[-+*/%]|\*\*/.test(value)) continue;
      const result = evaluate(value, scope);
      assert.ok(result.ok && typeof result.value !== 'string',
        `${file}: ${block.name}.${param.id} = ${value}\n` +
        `  contains arithmetic that expr.ts cannot evaluate, so the Run path hands ` +
        `it to the runner as raw text and construction fails.`);
      checked++;
    }
  }
}

console.log(`checked ${files.length} example flowgraphs (${checked} parameter expressions)`);
