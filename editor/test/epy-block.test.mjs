// The Embedded Python Block, editor side.
//
// A Python Block is the one block whose parameters and ports are not a property
// of its block id: they come from its own source. editor/src/epy.ts turns the
// interface cached in its `_io_cache` parameter into an ordinary RunnableDef, and
// everything downstream -- ports, the dialog, validation, the .grc writer -- then
// treats it like any other block. This covers that translation and the .grc round
// trip, neither of which needs a browser or the Python runtime.
//
// The browser half (loading Python, re-reading edited code, the ports following
// it) is test/test_python_block_editor.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as source, cssSource as css } from './editor-contract-source.mjs';

const { epyDef, epyDefForCache, parseIoCache, isForeignIoCache, EPY_BLOCK_ID,
        EPY_SOURCE_PARAM, EPY_IO_CACHE_PARAM, EPY_CODE_DTYPE } =
  await bundleModule('../src/epy.ts');
const { dumpGrc, parseGrc } = await bundleModule('../src/grc.ts');

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const generated = (library.blocks || []).find(block => block.id === EPY_BLOCK_ID);

// ---- the palette entry -----------------------------------------------------

assert.ok(generated, 'epy_block must be in the generated block library');
assert.equal(generated.runnable, true, 'the Python Block must not be greyed out');
assert.deepEqual(generated.category, ['GNU Radio World'],
  'the browser-backed Python Block belongs with the other GNU Radio World blocks');
assert.deepEqual((generated.inputs || []), [],
  'epy_block declares no ports in yaml: they come from the block source');
const yamlParams = new Map(generated.params.map(p => [p.id, p]));
assert.equal(yamlParams.get(EPY_SOURCE_PARAM)?.dtype, EPY_CODE_DTYPE,
  "the Code parameter keeps native GRC's dtype, which selects the code field");
assert.equal(yamlParams.get(EPY_IO_CACHE_PARAM)?.hide, 'all',
  'the derived-interface cache is never shown');

// The shipped default interface has to describe the shipped default source, or a
// freshly placed block draws the wrong ports. runner/test/test_grworld.py checks
// they agree by actually introspecting; here, just that both are present and the
// cache is readable.
const defaultCache = parseIoCache(yamlParams.get(EPY_IO_CACHE_PARAM).default);
assert.ok(defaultCache, 'the default interface cache must parse');
assert.match(yamlParams.get(EPY_SOURCE_PARAM).default, /class blk\(gr\.sync_block\)/,
  "the default code must be upstream's template");
assert.deepEqual(defaultCache.sinks, [['0', 'complex', 1]],
  'the default block has one complex input');
assert.deepEqual(defaultCache.params, [['example_param', '1']],
  'the default block has one parameter');

// ---- interface -> definition ----------------------------------------------

const base = {
  label: 'Python Block', inputs: 0, outputs: 0, documentation: 'generic docs',
  params: [
    { id: EPY_SOURCE_PARAM, label: 'Code', type: 'string', def: 'code', hide: 'part',
      dtype: EPY_CODE_DTYPE },
    { id: EPY_IO_CACHE_PARAM, label: 'IO Cache', type: 'string', def: '', hide: 'all' },
  ],
};
const io = {
  cls: 'blk', label: 'Weighted Sum', doc: 'Weighted sum of two streams',
  params: [['left', '1.0'], ['right', '0.5']],
  callbacks: ['left', 'right'],
  sinks: [['0', 'float', 1], ['1', 'float', 1]],
  sources: [['0', 'complex', 2]],
  msg_ports_in: ['cmd'], msg_ports_out: [],
  block_type: 'sync',
};
const def = epyDef(base, io);

assert.equal(def.label, 'Weighted Sum',
  "the block face shows the Python block's name(), as native GRC does");
assert.equal(def.documentation, 'Weighted sum of two streams',
  'the class docstring becomes the block documentation');
assert.deepEqual(def.params.map(p => p.id),
  [EPY_SOURCE_PARAM, EPY_IO_CACHE_PARAM, 'left', 'right'],
  'the static parameters keep their place and the derived ones follow');
assert.deepEqual(def.params.slice(2).map(p => [p.label, p.def, p.type]),
  [['Left', '1.0', 'string'], ['Right', '0.5', 'string']],
  "derived parameters are titled like upstream's _update_params and keep repr() defaults");
// Not `raw`: main.ts's resolveParamsForRun evaluates raw params and rewrites a
// list into the runner's own `(1,2,3)` vector spelling, which Python cannot eval.
// A Python Block's parameters are evaluated by Python itself.
assert.ok(def.params.slice(2).every(p => !p.raw && p.dtype === undefined),
  'derived parameters must not be marked raw or given an evaluated dtype');

assert.equal(def.inputs, 3, 'two stream inputs plus one message input');
assert.equal(def.outputs, 1);
assert.deepEqual(def.inputTemplates.map(t => [t.domain, t.dtype, t.vlen, t.label, t.optional]), [
  ['stream', 'float', '1', 'in0', false],
  ['stream', 'float', '1', 'in1', false],
  // A message port is optional, exactly as upstream's _update_ports marks it, so
  // leaving it unconnected does not make the flowgraph invalid.
  ['message', 'message', '1', 'cmd', true],
], 'stream ports are numbered when there is more than one, message ports named');
assert.deepEqual(def.outputTemplates.map(t => [t.dtype, t.vlen, t.label]),
  [['complex', '2', '']],
  'a lone port is unnumbered, and a sub-array dtype carries its vlen');

// No interface yet (a .grc written by desktop GRC, whose cache this editor cannot
// read): the block still loads, with its code, and simply shows no ports.
const bare = epyDef(base, null);
assert.deepEqual(bare.params.map(p => p.id), [EPY_SOURCE_PARAM, EPY_IO_CACHE_PARAM]);
assert.deepEqual([bare.inputs, bare.outputs, bare.inputTemplates], [0, 0, []]);
assert.equal(parseIoCache('not json'), null, 'an unreadable cache is not an error');
assert.equal(parseIoCache(''), null);
assert.ok(isForeignIoCache("('Bit -> Symbol Map', 'ConstMap', [], [], [], '', [])"),
  "desktop GRC's Python-tuple cache must be recognised as foreign");
assert.ok(!isForeignIoCache(JSON.stringify(io)));

// The definition is memoized per cache string, which is what keeps dragging a
// block from rebuilding its schema every frame.
const cacheText = JSON.stringify(io);
assert.equal(epyDefForCache(base, cacheText), epyDefForCache(base, cacheText),
  'the same interface must yield the same definition object');
assert.notEqual(epyDefForCache(base, cacheText), epyDefForCache(base, ''),
  'a different interface must yield a different definition');

// ---- .grc round trip -------------------------------------------------------

// Both of a Python Block's own parameters hold multi-line text. The writer emits
// a double-quoted scalar with \n escapes on one unbroken line (never PyYAML's
// folded continuations, which the runner's YAML subset cannot rejoin), and
// js-yaml reads it back byte for byte.
const pythonSource = '"""doc"""\n\nimport numpy as np\n\n\nclass blk:\n    pass\n';
const doc = {
  options: { parameters: { id: 'x' }, states: { coordinate: [10, 10], rotation: 0, state: 'enabled' } },
  blocks: [{
    name: 'weighted_sum', id: EPY_BLOCK_ID,
    parameters: {
      [EPY_IO_CACHE_PARAM]: cacheText,
      [EPY_SOURCE_PARAM]: pythonSource,
      left: '1.0',
    },
    states: { coordinate: [200, 100], rotation: 0, state: 'enabled' },
  }],
  connections: [],
  metadata: { file_format: 1, grc_version: '3.10.12.0' },
};
const text = dumpGrc(doc);
const sourceLines = text.split('\n').filter(line => line.includes('_source_code:'));
assert.equal(sourceLines.length, 1, 'the source must be written as one scalar');
assert.ok(!text.includes('\\\n'), 'no folded continuations: the runner cannot rejoin them');
const reparsed = parseGrc(text);
assert.equal(reparsed.blocks[0].parameters[EPY_SOURCE_PARAM], pythonSource,
  'a multi-line Python source must round-trip through .grc exactly');
assert.deepEqual(parseIoCache(reparsed.blocks[0].parameters[EPY_IO_CACHE_PARAM]), io,
  'the derived interface must round-trip through .grc');
assert.equal(dumpGrc(reparsed), text, 'dump -> parse -> dump must be a fixed point');

// ---- editor wiring ---------------------------------------------------------

// Every consumer that reads a definition *for an instance* must go through
// defFor(), or a Python Block gets the generic schema and loses its own
// parameters and ports.
//
// defFor() is one branch for every block whose interface is derived rather than
// declared -- the Python Block and the JavaScript Block both register into the
// DERIVED map -- so this is written against the map rather than against a branch
// per block. editor/test/js-block.test.mjs asserts the JS half of the same thing.
assert.match(source,
  /const DERIVED = new Map<[\s\S]{0,120}?\[EPY_BLOCK_ID, \(base, inst\) => epyDefForCache\(base, inst\.params\[EPY_IO_CACHE_PARAM\]\)\]/,
  'the Python Block must register its per-instance definition in DERIVED');
assert.match(source,
  /function defFor\(inst: Inst\): RunnableDef \{[\s\S]{0,200}?DERIVED\.get\(inst\.id\)/,
  'defFor must synthesize a definition from that map, not from a branch per block');
for (const fn of ['resolvedPorts', 'legacyPortCount', 'portType', 'portLabel', 'geom',
                  'resolveParamsForRun']) {
  const body = new RegExp(`function ${fn}\\([^)]*\\)[^{]*\\{[\\s\\S]{0,200}?defFor\\(inst\\)`);
  assert.match(source, body, `${fn} must read the per-instance definition`);
}
assert.doesNotMatch(source, /RUNNABLE\[inst\.id\]\.params/,
  'no parameter list may be read by block id: a Python Block\'s comes from its source');

// The code field, and the guard that stops edited code being committed before it
// has been read -- without which a block's ports would describe its previous
// source and only the runner would notice.
assert.match(source, /p\.dtype === EPY_CODE_DTYPE/,
  'the Code parameter must get the code field, not a plain text input');
assert.match(source, /applyButton\.disabled = okButton\.disabled = code\.pending \|\| code\.busy/,
  'edited code must not be applicable until Python has re-read it');
assert.match(source, /if \(p\.id === EPY_IO_CACHE_PARAM \|\| p\.id === JS_IO_PARAM/,
  'the derived-interface cache must have no dialog field');
assert.match(css, /textarea\.code-editor \{[^}]*monospace/,
  'the code field must be monospace');

// CodeMirror is mounted over that textarea, and only ever from a chunk of its
// own: a static import would put a few hundred kB of code editor in front of
// every session, including the many that never open a Python Block. The textarea
// remains the field's value, so a chunk that never arrives still leaves a usable
// editor behind.
assert.match(source, /import\('\.\/code-editor'\)[\s\S]{0,120}?mountCodeEditor\(area\)/,
  'the code editor must be imported on demand, not into the main bundle');
assert.doesNotMatch(source, /^import .*['"](codemirror|@codemirror\/|\.\/code-editor)/m,
  'main.ts must not import CodeMirror or its wrapper statically');
assert.match(css, /\.dlgrow textarea\[hidden\] \{[^}]*display:none/,
  "the mirrored textarea must be hidden: .dlgrow textarea's display:block beats [hidden]");

const codeEditor = await readFile(new URL('../src/code-editor.ts', import.meta.url), 'utf8');
for (const [pattern, what] of [
  [/import\('codemirror'\)/, 'CodeMirror itself'],
  [/import\('@codemirror\/lang-python'\)/, 'the Python language mode'],
]) assert.match(codeEditor, pattern, `code-editor.ts must dynamically import ${what}`);
assert.doesNotMatch(codeEditor, /^import [^t]/m,
  'code-editor.ts must have no eager imports: it exists to be a lazy chunk');

console.log('checked the Python Block schema synthesis, its .grc round trip and editor wiring');
