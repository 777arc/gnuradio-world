import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
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
assert.match(source, /Selector's configured stream multiplicity is part of its topology/,
  'all configured Selector stream ports must be required like native GRC');
assert.match(source, /Connection vector-length mismatch/,
  'Selector vector lengths must participate in stream compatibility checks');

console.log('checked native-compatible Selector ports, controls and topology');
