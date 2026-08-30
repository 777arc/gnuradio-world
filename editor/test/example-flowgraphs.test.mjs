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
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleFiles as files, exampleFilePath } from './example-files.mjs';
import { editorSource } from './editor-contract-source.mjs';

// expr.ts/grc.ts are TypeScript; bundle them to importable mjs (as expr.test.mjs does).
const out = join(tmpdir(), `examples-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('./_example-entry.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const { evaluate, buildScope, parseGrc, installGeneratedBlocks, RUNNABLE } =
  await import(pathToFileURL(out).href);

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const byId = new Map((library.blocks || []).map(b => [b.id, b]));
// The schemas the editor actually loads a file with: a hand-written one
// supersedes the generated one rather than merging with it.
installGeneratedBlocks(library.blocks || []);

// This MUST mirror main.ts exactly. An earlier version of this test was more
// permissive than the editor (it treated every `${ ... }` dtype as evaluated),
// so it green-lit an example the Run path then failed to resolve. If the set
// below drifts from EVALUATED_DTYPES in main.ts, this test stops being evidence.
const EVALUATED_DTYPES = new Set([
  'int', 'real', 'float', 'hex', 'raw',
  'int_vector', 'real_vector', 'float_vector', 'complex_vector',
  'int_matrix', 'real_matrix', 'float_matrix',
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

// Fail loudly if the editor's set and this one stop agreeing. The declaration
// lives in validation.ts, which the Run path and the flowgraph checks share.
{
  const block = editorSource.match(/const EVALUATED_DTYPES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'the editor no longer defines EVALUATED_DTYPES');
  const theirs = new Set([...block[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  assert.deepEqual([...theirs].sort(), [...EVALUATED_DTYPES].sort(),
    'EVALUATED_DTYPES in the editor and this test have drifted apart');
}

assert.ok(files.length > 0, 'no example flowgraphs found');

// Native GRC writes every block's implicit parameters, so `parameters:` is
// never a bare key -- a bare one reads back as YAML null and makes native GRC
// fail at `parameters.items()`. withImplicitParams() in main.ts keeps what the
// editor writes in step; these files have to match it, since the native
// validator reads them straight off disk.
{
  assert.match(editorSource, /function withImplicitParams\(/,
    'the editor no longer fills in native GRC implicit parameters');
  // Which implicit parameters a block gets varies with what its definition
  // declares (affinity/alias on anything with ports, the output-buffer bounds
  // only where there is an output to size), and desktop GRC's own files differ
  // block by block. The invariant that has to hold everywhere is that the
  // mapping is never empty, since a bare key reads back as null.
  for (const file of files) {
    const doc = parseGrc(await readFile(exampleFilePath(file), 'utf8'));
    for (const block of doc.blocks || [])
      assert.ok(block.parameters && typeof block.parameters === 'object' &&
        Object.keys(block.parameters).length > 0,
        `${file}: block "${block.name}" serializes a bare \`parameters:\` key, ` +
        'which native GNU Radio reads as null and fails to load');
  }
}

let checked = 0;
for (const file of files) {
  const text = await readFile(exampleFilePath(file), 'utf8');

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

// ---- parameter ids ----
//
// The other silent failure: a parameter the block's *effective* schema does not
// declare is dropped on load without a word, and the block runs with the schema
// default. Nothing downstream notices -- the file parses, the graph builds, every
// block moves samples, it just computes something else. That is how a native
// `.grc` used to lose analog_sig_source_x's freq/amp, and how these files would
// quietly rot if a schema were renamed and a file missed.
//
// GRC writes these on every block regardless of its own parameter list
// (grc/core/blocks/block.py), and no schema here declares them. `showports`
// joins them: it toggles the visibility of the optional message ports that the
// hand-written schemas deliberately do not expose.
const UNIVERSAL_KEYS = new Set([
  'comment', 'affinity', 'alias', 'minoutbuf', 'maxoutbuf', 'gui_hint', 'showports',
]);
// Parameters one block deliberately does not model, each for its own reason.
// Anything added here should be a decision, not an oversight.
const ALLOWED = new Set([
  // GRC's port-count and bus hints for these two: the runner's factories build
  // exactly one port, so declaring them would let the editor draw ports the
  // flowgraph cannot have.
  'blocks_null_source.num_outputs',
  'blocks_null_source.bus_structure_source',
  // Its only other option is `msg_complex`, and a hand-written schema has no
  // way to turn its stream input into a message port (installGeneratedBlocks
  // gives it no inputTemplates). The written value is the default either way.
  'qtgui_const_sink_x.type',
]);
// A block whose parameters come from its own source rather than its id: the
// editor resolves those per instance through defFor(), which this test has no
// canvas to do. See docs/embedded-python.md and docs/js-blocks.md.
const SOURCE_DEFINED = new Set(['epy_block', 'wasm_js_block']);

let idsChecked = 0;
for (const file of files) {
  const doc = parseGrc(await readFile(exampleFilePath(file), 'utf8'));
  for (const block of doc.blocks) {
    const def = RUNNABLE[block.id];
    if (!def || SOURCE_DEFINED.has(block.id)) continue;
    const declared = new Set(def.params.map(p => p.id));
    for (const key of Object.keys(block.parameters || {})) {
      if (UNIVERSAL_KEYS.has(key) || declared.has(key) ||
          ALLOWED.has(`${block.id}.${key}`)) { ++idsChecked; continue; }
      assert.fail(`${file}: ${block.name} (${block.id}) sets \`${key}\`, which its ` +
        `schema does not declare\n  The editor drops it on load and uses the ` +
        `default instead, silently. Check editor/src/block-defs.ts for the id ` +
        `this block actually spells it.`);
    }
  }
}

console.log(`checked ${files.length} example flowgraphs (${checked} parameter expressions, ` +
  `${idsChecked} parameter ids)`);
