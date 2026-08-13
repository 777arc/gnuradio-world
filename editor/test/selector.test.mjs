import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editorSource as source } from './editor-contract-source.mjs';
import { bundleModule } from './bundle-module.mjs';

const { evaluate } = await bundleModule('../src/expr.ts');

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const selector = (library.blocks || []).find(block => block.id === 'blocks_selector');

assert.ok(selector?.runnable, 'Selector must remain runnable');
const streamInput = selector.inputs.find(port => port.domain === 'stream');
const messageInputs = selector.inputs.filter(port => port.domain === 'message');
assert.equal(streamInput?.multiplicity, '${ num_inputs }',
  'Selector stream inputs must retain native dynamic multiplicity');
assert.equal(streamInput?.vlen, '${ vlen }',
  'Selector inputs must retain the native vector length');
assert.deepEqual(messageInputs.map(port => port.id), ['en', 'iindex', 'oindex'],
  'Selector must expose its native enable/input-index/output-index message ports');
assert.ok(messageInputs.every(port => port.hide === '${ showports }'),
  'Selector message-port visibility must follow showports');

const params = new Map(selector.params.map(param => [param.id, param]));
assert.deepEqual(params.get('enabled')?.option_labels, ['Enabled', 'Disabled']);
assert.deepEqual(params.get('showports')?.options, ['False', 'True']);
assert.deepEqual(params.get('showports')?.option_labels, ['Yes', 'No'],
  'Show Msg Ports must preserve native Yes/No labels and their inverted hide values');
assert.equal(params.get('vlen')?.hide, "${ 'part' if vlen == 1 else 'none' }",
  'Vector Length must use native conditional face visibility');

assert.match(source, /inputTemplates: portTemplates\(block\.inputs\)/,
  'generated inputs must be retained as dynamic templates');
assert.match(source, /const count = templateMultiplicity\(port\.multiplicity, inst\.params\)/,
  'dynamic port multiplicity must be evaluated from current block parameters');
assert.match(source, /filter\(i => !portMeta\(inst, kind, i\)\.hidden\)/,
  'hidden message ports must be omitted from the canvas');
assert.match(source, /port\.domain === 'stream' \? `stream:\$\{port\.streamIndex\}` : `message:\$\{port\.id\}`/,
  'connections must remain attached when dynamic stream counts move message ports');
assert.match(source, /Input Index must select an available input port/,
  'Selector input index must be checked against its configured topology');
assert.match(source, /Output Index must select an available output port/,
  'Selector output index must be checked against its configured topology');
assert.match(source, /configured multiplicity part of its topology rather than a drawing hint/,
  'all configured Selector stream ports must be required like native GRC');
assert.match(source, /Connection vector-length mismatch/,
  'Selector vector lengths must participate in stream compatibility checks');

// The Bercurve Sink counts a *list* parameter to size its ports
// (`len(esno)*2*num_curves`, one input pair per Es/No point per curve). That only
// works if the template scope holds `esno` as the list it evaluates to rather
// than as its own source text — with the text, len() returns the number of
// characters in "numpy.arange(0.0, 4.0, .5)" and the block draws 52 ports.
const bercurve = (library.blocks || []).find(block => block.id === 'qtgui_bercurve_sink');
assert.equal(bercurve?.inputs?.[0]?.multiplicity, '${ len(esno)*2*num_curves }',
  'Bercurve Sink inputs must retain their native per-Es/No multiplicity');
const esno = evaluate(bercurve.params.find(p => p.id === 'esno').default, {});
assert.ok(esno.ok && Array.isArray(esno.value) && esno.value.length === 8,
  'the Bercurve Sink default Es/No range must evaluate to a list of 8 points');
assert.match(source, /else scope\[id\] = listParam\(text\)/,
  'template scopes must carry list-valued parameters as lists');
assert.match(source, /result\.ok && Array\.isArray\(result\.value\) \? result\.value : text/,
  'only a parameter that evaluates to a list may be substituted into the scope');

console.log('checked native-compatible Selector ports, controls and topology');
