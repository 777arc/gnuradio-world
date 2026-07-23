import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

assert.match(source, /function validateGraph\(/, 'missing shared graph validator');
assert.match(source, /finite number or a variable control ID/, 'numeric fields must validate numbers and variable-control references');
assert.match(source, /Block ID is required/, 'block IDs must be validated');
assert.match(source, /is used more than once/, 'duplicate active block IDs must be validated');
assert.match(source, /has unsupported value/, 'enum values must be validated');
assert.match(source, /Connection type mismatch/, 'stream connection types must be validated');
assert.match(source, /validateGraph\(\)\.filter\(issue => issue\.blocking\)/,
  'Run must refuse active validation errors');
assert.match(source, /class: 'validation-error'/, 'canvas error messages must be rendered below blocks');
assert.match(source, /setFieldError\(/, 'property fields must receive live error states');

assert.match(html, /\.blk\.invalid rect\.body/, 'invalid blocks must have a red canvas style');
assert.match(html, /\.wire\.invalid/, 'invalid connections must have a red canvas style');
assert.match(html, /\.field-invalid/, 'invalid editor fields must have a red form style');
assert.match(html, /\.field-error/, 'field-level messages must have a compact error style');

// Plain Variable block: registered as a schema, treated as a reference target,
// and resolved away editor-side (the runner has no `variable` factory).
assert.match(source, /\n\s*variable:\s*{[\s\S]*?label: 'Variable'/, 'plain Variable block must be registered');
assert.match(source, /VARIABLE_IDS = new Set\(\[\.\.\.VARIABLE_CONTROL_IDS, 'variable'\]\)/,
  'plain Variable must be a valid numeric reference target');
assert.match(source, /i\.id !== 'variable'/, 'plain Variable blocks must not be emitted to the runner');

console.log('checked editor-side flowgraph validation and error presentation');
