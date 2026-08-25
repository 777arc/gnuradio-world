// The JavaScript Block, editor side.
//
// A JS Block is, like a Python Block, a block whose parameters and ports are not
// a property of its block id: they come from its own source. editor/src/
// js-block.ts turns the interface cached in its `_js_io` parameter into an
// ordinary RunnableDef, and everything downstream -- ports, the dialog,
// validation, the .grc writer -- then treats it like any other block.
//
// This covers that translation, the `_js_io` byte stability, the local-library
// round trip and the editor wiring, none of which needs a browser. What it cannot
// cover is the sandboxed introspection itself (which needs an iframe) or the
// crossing into C++: test/test_js_block.mjs does the second, in the real runner.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as source, cssSource as css } from './editor-contract-source.mjs';

const js = await bundleModule('../src/js-block.ts');
const { analyzeJsSource } = await bundleModule('../src/js-block-analysis.ts');
const {
  jsDef, jsDefForCache, parseJsIo, serializeJsIo, jsSourceOf, jsSourceParamOf,
  sanitizeBlockId, generateBlockYml, sourceHash,
  JS_BLOCK_ID, JS_SOURCE_PARAM, JS_IO_PARAM, JS_LOCAL_SOURCE_PARAM, JS_CODE_DTYPE,
} = js;
const { dumpGrc, parseGrc } = await bundleModule('../src/grc.ts');

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const generated = (library.blocks || []).find(block => block.id === JS_BLOCK_ID);

// ---- the palette entry -----------------------------------------------------

assert.ok(generated, 'wasm_js_block must be in the generated block library');
assert.equal(generated.runnable, true, 'the JS Block must not be greyed out');
assert.deepEqual(generated.category, ['Core', 'Misc'],
  'the JS Block sits beside the Python Block');
assert.deepEqual((generated.inputs || []), [],
  'wasm_js_block declares no ports in yaml: they come from the block source');
const yamlParams = new Map(generated.params.map(p => [p.id, p]));
assert.equal(yamlParams.get(JS_SOURCE_PARAM)?.dtype, JS_CODE_DTYPE,
  'the Code parameter carries the dtype that selects the code field');
assert.equal(yamlParams.get(JS_IO_PARAM)?.hide, 'all',
  'the derived-interface cache is never shown');
assert.equal(yamlParams.get(JS_LOCAL_SOURCE_PARAM)?.hide, 'all',
  "a local block's inlined source is never shown either");

// The shipped default interface has to describe the shipped default source, or a
// freshly placed block draws the wrong ports. The runtime is the authority on
// what a descriptor means, so this checks against the runtime rather than
// restating it -- runner/src/js_runtime.js is written to evaluate in a plain
// realm for exactly this.
const runtimeSource = await readFile(
  new URL('../../runner/src/js_runtime.js', import.meta.url), 'utf8');
new Function(runtimeSource)();
const derived = globalThis.__grJs.describeSource(yamlParams.get(JS_SOURCE_PARAM).default);
assert.ok(derived.ok, `the default source must read cleanly: ${derived.error}`);
assert.equal(serializeJsIo(derived.info), yamlParams.get(JS_IO_PARAM).default,
  'the _js_io default in wasm_js_block.block.yml must be this exact interface');
assert.match(yamlParams.get(JS_SOURCE_PARAM).default, /gr\.export\(\{/,
  'the default code must register itself with gr.export()');

// ---- interface -> definition ----------------------------------------------

const base = {
  label: 'JS Block', inputs: 0, outputs: 0, documentation: 'generic docs',
  params: [
    { id: JS_SOURCE_PARAM, label: 'Code', type: 'string', def: 'code', hide: 'part',
      dtype: JS_CODE_DTYPE },
    { id: JS_IO_PARAM, label: 'JS Interface', type: 'string', def: '', hide: 'all' },
    { id: JS_LOCAL_SOURCE_PARAM, label: 'JS Source', type: 'string', def: '', hide: 'all' },
  ],
};
const io = {
  label: 'Weighted Sum', doc: 'Weighted sum of two streams',
  inputs: [{ dtype: 'float', vlen: 1 }, { dtype: 'float', vlen: 1 }],
  outputs: [{ dtype: 'complex', vlen: 2 }],
  params: [['left', 1], ['right', 0.5], ['tag', 'burst']],
  numericParams: ['left', 'right'],
  decim: 1, interp: 1, history: 1, outputMultiple: 0, relativeRate: 1,
  general: false, overridesForecast: false, hasStart: true, hasStop: false,
};
const def = jsDef(base, io);

assert.equal(def.label, 'Weighted Sum',
  "the block face shows the descriptor's label");
assert.equal(def.documentation, 'Weighted sum of two streams',
  "the descriptor's doc becomes the block documentation");
assert.deepEqual(def.params.map(p => p.id),
  [JS_SOURCE_PARAM, JS_IO_PARAM, JS_LOCAL_SOURCE_PARAM, 'left', 'right', 'tag'],
  'the static parameters keep their place and the derived ones follow');
assert.deepEqual(def.params.slice(3).map(p => [p.label, p.def, p.type]),
  [['Left', 1, 'number'], ['Right', 0.5, 'number'], ['Tag', 'burst', 'string']],
  'derived parameters are titled like GRC and keep their declared defaults');
// A numeric parameter has to be `type: 'number'`: that is what lets a QT GUI
// Range's ID be typed into it and resolved on the Run path, which is the whole
// point of the numeric_setters entry make_js_block() gives it.
assert.ok(def.params.slice(3, 5).every(p => p.type === 'number' && !p.raw),
  'numeric parameters must be numbers, and must not be marked raw');

assert.equal(def.inputs, 2);
assert.equal(def.outputs, 1);
assert.deepEqual(def.inputTemplates.map(t => [t.domain, t.dtype, t.vlen, t.label]), [
  ['stream', 'float', '1', 'in0'],
  ['stream', 'float', '1', 'in1'],
], 'stream ports are numbered when there is more than one');
assert.deepEqual(def.outputTemplates.map(t => [t.dtype, t.vlen, t.label]),
  [['complex', '2', '']],
  'a lone port is unnumbered, and a vlen port carries it');

// No interface yet: the block still loads, with its code, and shows no ports.
const bare = jsDef(base, null);
assert.deepEqual(bare.params.map(p => p.id),
  [JS_SOURCE_PARAM, JS_IO_PARAM, JS_LOCAL_SOURCE_PARAM]);
assert.deepEqual([bare.inputs, bare.outputs, bare.inputTemplates], [0, 0, []]);
assert.equal(parseJsIo('not json'), null, 'an unreadable cache is not an error');
assert.equal(parseJsIo(''), null);

// Memoized per cache string, which keeps dragging a block from rebuilding its
// schema every frame.
const cacheText = serializeJsIo(io);
assert.equal(jsDefForCache(base, cacheText), jsDefForCache(base, cacheText),
  'the same interface must yield the same definition object');
assert.notEqual(jsDefForCache(base, cacheText), jsDefForCache(base, ''),
  'a different interface must yield a different definition');

// ---- _js_io byte stability -------------------------------------------------
// Sorted keys, so re-deriving identical source leaves the .grc byte for byte
// unchanged -- a file that rewrote itself on every open would make every diff
// unreadable.
const shuffled = Object.fromEntries(Object.keys(io).reverse().map(k => [k, io[k]]));
assert.equal(serializeJsIo(shuffled), cacheText,
  'the cache must not depend on the key order it was built in');
assert.deepEqual(parseJsIo(cacheText), io, 'and it must round-trip');

// ---- which parameter holds the source --------------------------------------
// One rule, the same one the runner's factory applies: use the inline source when
// the instance carries one, otherwise the library's.
assert.equal(jsSourceParamOf({ [JS_SOURCE_PARAM]: 'a' }), JS_SOURCE_PARAM);
assert.equal(jsSourceParamOf({ [JS_SOURCE_PARAM]: 'a', [JS_LOCAL_SOURCE_PARAM]: 'b' }),
  JS_LOCAL_SOURCE_PARAM,
  'an instance placed from the local library runs its own inlined source');
assert.equal(jsSourceOf({ [JS_SOURCE_PARAM]: 'a', [JS_LOCAL_SOURCE_PARAM]: 'b' }), 'b');
assert.equal(jsSourceOf({}), '');

// ---- .grc round trip -------------------------------------------------------
// A JS Block's source is multi-line text. The writer emits a double-quoted scalar
// with \n escapes on one unbroken line -- never PyYAML's folded continuations,
// which the runner's YAML subset cannot rejoin -- and js-yaml reads it back byte
// for byte.
const jsSource = "gr.export({\n  // a comment with a '#' in it\n  inputs: ['complex'],\n" +
  "  outputs: ['complex'],\n  work(n, i, o) { return n; },\n});\n";
const doc = {
  options: { parameters: { id: 'x' }, states: { coordinate: [10, 10], rotation: 0, state: 'enabled' } },
  blocks: [{
    name: 'js_gain', id: JS_BLOCK_ID,
    parameters: { [JS_IO_PARAM]: cacheText, [JS_SOURCE_PARAM]: jsSource, left: '1.0' },
    states: { coordinate: [200, 100], rotation: 0, state: 'enabled' },
  }],
  connections: [],
  metadata: { file_format: 1, grc_version: '3.10.12.0' },
};
const text = dumpGrc(doc);
assert.equal(text.split('\n').filter(l => l.includes('_source_code:')).length, 1,
  'the source must be written as one scalar');
assert.ok(!text.includes('\\\n'), 'no folded continuations: the runner cannot rejoin them');
const reparsed = parseGrc(text);
assert.equal(reparsed.blocks[0].parameters[JS_SOURCE_PARAM], jsSource,
  'a multi-line JavaScript source must round-trip through .grc exactly');
assert.deepEqual(parseJsIo(reparsed.blocks[0].parameters[JS_IO_PARAM]), io);
assert.equal(dumpGrc(reparsed), text, 'dump -> parse -> dump must be a fixed point');

// ---- Save as Block: the repo pair ------------------------------------------
// The yml is authoritative for a repo block, and no human writes it by hand.
assert.equal(sanitizeBlockId('JS Gain!'), 'js_gain');
assert.equal(sanitizeBlockId('  --weird--  '), 'weird');
assert.equal(sanitizeBlockId('9lives'), 'js_9lives', 'a block id cannot start with a digit');
assert.equal(sanitizeBlockId(''), 'js_block');

const yml = generateBlockYml({
  id: 'js_weighted_sum', label: 'Weighted Sum', category: '[Custom]/Math',
  source: jsSource, io, saved: 0,
});
assert.match(yml, /^id: js_weighted_sum$/m);
assert.match(yml, /^flags: \[js\]$/m,
  'flags: [js] is what binds the id to the generic factory and skips the C++ path');
assert.match(yml, /^category: '\[Custom\]\/Math'$/m);
assert.match(yml, /^-   id: left\n    label: Left\n    dtype: real\n    default: '1'$/m,
  'a numeric parameter becomes a real');
assert.match(yml, /^-   id: tag\n    label: Tag\n    dtype: string\n    default: burst$/m);
assert.match(yml, /inputs:\n-   domain: stream\n    dtype: float\n-   domain: stream\n    dtype: float\n/,
  'both input ports are declared, in order');
assert.match(yml, /outputs:\n-   domain: stream\n    dtype: complex\n    vlen: '2'\n/,
  'a vlen other than 1 is carried');
assert.match(yml, /^file_format: 1$/m);
// gen_registry.py holds the descriptor and this yml to each other, so it has to
// be readable by the same yaml parser that reads every other block's.
const { load } = await import('js-yaml');
const parsedYml = load(yml);
assert.equal(parsedYml.id, 'js_weighted_sum');
assert.deepEqual(parsedYml.flags, ['js']);
assert.deepEqual(parsedYml.inputs.map(p => p.dtype), ['float', 'float']);

// ---- Run consent ------------------------------------------------------------
// Not a security boundary -- a stable key for "this exact source", so a .grc that
// arrived from a link asks once and never again.
assert.equal(sourceHash('a'), sourceHash('a'));
assert.notEqual(sourceHash('a'), sourceHash('b'));
assert.notEqual(sourceHash('ab'), sourceHash('ba'));

// ---- editor wiring ---------------------------------------------------------

// Every consumer that reads a definition *for an instance* goes through defFor(),
// which is one map rather than a branch per derived block. Without the JS entry a
// JS Block gets the generic schema and loses its own parameters and ports -- and
// because they are derived rather than declared, "the editor silently drops
// parameters its schema does not declare" would apply to every one of them.
assert.match(source,
  /\[JS_BLOCK_ID, \(base, inst\) => jsDefForCache\(base, inst\.params\[JS_IO_PARAM\]\)\]/,
  'the JS Block must register its per-instance definition in DERIVED');
assert.match(source, /function defFor\(inst: Inst\): RunnableDef \{[\s\S]{0,200}?DERIVED\.get\(inst\.id\)/,
  'defFor must read that map');
// The .grc loader has the same problem before defFor exists for the instance:
// importParams keeps only what the definition declares.
assert.match(source, /const derive = DERIVED\.get\(b\.id\);/,
  'the .grc loader must build a derived definition before importing its values');

// The code field, and the popup editor behind it.
assert.match(source, /p\.dtype === JS_CODE_DTYPE/,
  'the Code parameter must get the code field, not a plain text input');
assert.match(source, /import\('\.\/code-modal'\)/,
  'the popup code editor must be imported on demand, not into the main bundle');
assert.doesNotMatch(source, /^import .*['"]\.\/code-modal/m,
  'main.ts must not import the code modal statically');
// A JS Block double-clicks to Properties like every other block; the popup is
// reached from "Expand Editor" beside the dialog's Code field.
assert.doesNotMatch(source, /openJsBlockCode/,
  'double-clicking a JS Block must open Properties, not the popup editor');
assert.match(source, /popout\.textContent = 'Expand Editor/,
  'the Properties Code field must offer the popup editor');
// Unlike the Python Block there is no re-read button and no Apply gate: deriving
// is milliseconds in a disposable sandbox, so ports follow the code as it is
// typed. This is the assertion that would catch that being quietly undone.
assert.match(source, /deriveTimer = setTimeout\(describe, 220\)/,
  'the JS code field must re-derive on a keystroke debounce');
assert.match(source, /applyJsIo\(tmp\.params, io\)/,
  'a successful derivation must be recorded on the working copy');

// A parameter the descriptor has just grown needs a value, or the editor drops it
// and the block silently runs on the descriptor default.
assert.match(source, /if \(params\[id\] === undefined\)\n\s*params\[id\] = def/,
  'applyJsIo must give every newly derived parameter its default');

// The introspection sandbox: an opaque origin, so a source from a link cannot
// reach the editor's localStorage (which holds the Graham API keys) or make a
// credentialed same-origin fetch.
const jsBlockSource = await readFile(new URL('../src/js-block.ts', import.meta.url), 'utf8');
assert.match(jsBlockSource, /setAttribute\('sandbox', 'allow-scripts'\)/,
  'introspection must run in a sandboxed iframe');
assert.doesNotMatch(jsBlockSource, /allow-same-origin/,
  'allow-same-origin would hand the block source the editor’s own origin');
assert.match(jsBlockSource, /INTROSPECT_TIMEOUT_MS = \d+/,
  'an infinite loop in a source must not wedge the editor while you are typing');
assert.match(jsBlockSource, /RUNTIME_URL = '\/runner\/build\/js_runtime\.js'/,
  'the editor must validate descriptors with the runner’s own runtime, not a copy');

const warnings = analyzeJsSource(`
let shared = [];
gr.export({
  inputs: ['float'], outputs: ['float'],
  generalWork(nout, nin, input, output) {
    this.cached = input[0];
    console.log(nout);
    for (let i = 0; i < nout; i++) { const temporary = []; }
    return nout;
  },
});`);
const warningCodes = new Set(warnings.map(warning => warning.code));
for (const code of ['top-level-state', 'cached-buffer-view', 'console-log',
  'hot-allocation', 'missing-consume'])
  assert.ok(warningCodes.has(code), `the JS analyzer should report ${code}`);
assert.ok(warnings.every(warning => warning.line >= 1 && warning.column >= 1),
  'warnings carry source locations Graham can act on');

assert.match(source, /inspectJsBlock:/,
  'Graham must have a dedicated complete-source inspection path');
assert.match(source, /setJsBlockSource:/,
  'Graham source edits must use the introspecting JS path');
assert.match(source, /review_required_before_run/,
  'a Graham source edit must preserve the human review boundary');

// Run consent, on the Run click and before anything is fetched or bound.
assert.match(source, /const pendingJs = unacceptedJsSources\(\);[\s\S]{0,200}?askToRunJavaScript\(pendingJs\)/,
  'Run must ask before running JavaScript that did not come from this session');
assert.match(source, /acceptJsSource\(source\);\s*\/\/ typed here/,
  'source typed in this session is trusted from the moment it was typed');

// The palette badges a block whose work() is JavaScript. It is generated content
// (a ::after) rather than an element, so the row's textContent stays exactly the
// block's label -- the palette search and every browser test match on that. The
// tooltip is where the same fact is said in words.
assert.match(source,
  /isJavaScript: block => !!block\.localJs \|\| block\.id === JS_BLOCK_ID \|\|\s*blockFlags\(block\.flags\)\.includes\('js'\)/,
  'all three kinds of JavaScript block are badged: repo, inline and locally saved');
assert.match(source, /\(b\.js \? ' pal-js' : ''\)/,
  'the badge is a class on the row, not text appended to it');
assert.match(source, /item\.textContent = b\.label;/,
  "the row's text must stay the block label alone");
assert.match(source, /b\.js \? `\$\{b\.id\} — implemented in JavaScript`/,
  'and the tooltip must say so in words, for anyone who cannot see the badge');
assert.match(css, /\.pal-item\.pal-js::after \{[^}]*content:'JS'/,
  'the badge is drawn by CSS');
assert.match(css, /\.pal-item\.pal-js::after \{[^}]*margin-left/,
  'the badge sits inline just after the block name, not in a column of its own');
assert.doesNotMatch(css, /\.pal-item\.pal-js::after \{[^}]*position:absolute/,
  'it is inline content, so it flows with the name it tags');

// The local library, and what an instance of one carries.
assert.match(source, /placeLocalJsBlock\(b\.localJs\)/,
  'a saved block is placed from the palette like any other');
assert.match(source, /\{ \[JS_LOCAL_SOURCE_PARAM\]: block\.source \}/,
  'a local block’s instances inline their source, so a shared link works for ' +
  'someone who does not have that library');

// CodeMirror stays out of the eager import chain -- the same rule the Python
// Block's field lives by, now covering the JavaScript mode too.
const codeEditor = await readFile(new URL('../src/code-editor.ts', import.meta.url), 'utf8');
assert.match(codeEditor, /import\('@codemirror\/lang-javascript'\)/,
  'code-editor.ts must dynamically import the JavaScript language mode');
assert.doesNotMatch(codeEditor, /^import [^t]/m,
  'code-editor.ts must have no eager imports: it exists to be a lazy chunk');
assert.match(css, /\.code-modal-body \{[^}]*grid-template-columns/,
  'the popup editor puts the code and what it means side by side');

console.log('checked the JS Block schema synthesis, its .grc round trip, the ' +
            'generated repo pair and the editor wiring');
