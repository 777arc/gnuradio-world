import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

assert.match(source, /function validateGraph\(/, 'missing shared graph validator');
assert.match(source, /must be a number, a variable ID, or an expression of them/,
  'numeric fields must validate numbers, variable references and expressions');
assert.match(source, /!evaluates\(value, staticScope\)/,
  'numeric fields must accept expressions that evaluate against the plain variables');
assert.match(source, /may reference a live control only on its own/,
  'an expression wrapped around a live control must be reported specifically');
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

// Plain Variable block: registered as a schema and a reference target. It is
// saved to .grc like any block; the runner inlines its value during lowering.
assert.match(source, /\n\s*variable:\s*{[\s\S]*?label: 'Variable'/, 'plain Variable block must be registered');
assert.match(source, /VARIABLE_IDS = new Set\(\[\.\.\.VARIABLE_CONTROL_IDS, 'variable'\]\)/,
  'plain Variable must be a valid numeric reference target');
assert.match(source, /insts\.filter\(i => i\.id !== OPTIONS_ID\)/,
  'every block except Options must be written to the .grc');

// Options block: the GRC-style per-flowgraph metadata singleton
// (title/author/copyright/description), auto-inserted and never emitted.
assert.match(source, /\n\s*options:\s*{[\s\S]*?label: 'Options'/, 'Options block must be registered');
assert.match(source, /id: 'title'[\s\S]*?id: 'author'[\s\S]*?id: 'copyright'[\s\S]*?id: 'description'/,
  'Options block must carry title/author/copyright/description metadata');
assert.match(source, /function ensureOptionsBlock\(\)/, 'a flowgraph must guarantee one Options block');
assert.match(source, /i\.id !== OPTIONS_ID/, 'the Options block must not be emitted to the runner');
assert.match(source, /!uids\.has\(i\.uid\) \|\| i\.id === OPTIONS_ID/,
  'the Options block must be protected from deletion');
assert.match(source, /only one Options block is allowed per flowgraph/,
  'adding a second Options block must be refused');

console.log('checked editor-side flowgraph validation and error presentation');
