import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editorSource as editor } from './editor-contract-source.mjs';

const runner = await readFile(
  new URL('../../runner/src/registry.cpp', import.meta.url), 'utf8');

for (const field of ['label', 'width', 'color', 'style', 'marker', 'alpha']) {
  assert.match(editor, new RegExp(`id: '${field}2'.*Line 2`, 's'),
    `Time Sink must expose the second trace's ${field} setting`);
}
assert.match(editor, /showWhen: p => p\.type === 'complex'/,
  'second-trace settings must only be shown for complex input');
assert.match(editor, /refreshVisibility\(\); refreshValidation\(\);/,
  'changing the data type must refresh conditional properties');

assert.match(runner, /configure_line\(sink, p, line,/,
  'runner must apply settings to every Time Sink trace');
assert.match(runner, /configure_time_sink\(b, p, nc\)/,
  'float Time Sinks must configure one trace per input');
assert.match(runner, /configure_time_sink\(b, p, 2 \* nc\)/,
  'complex Time Sinks must configure real and imaginary traces');

console.log('checked complex Time Sink second-trace configuration');
