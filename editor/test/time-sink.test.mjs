import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
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

// Line style and marker are enums of Qt::PenStyle / QwtSymbol::Style ids, and
// the label a reader picks has to name the id that gets stored. GRC's sinks
// order these lists differently from one another, so merging one sink's labels
// onto another's values by position silently shifts every choice: picking
// "None" on the Time Sink used to store 0, a circle drawn on every sample.
{
  const { installGeneratedBlocks, RUNNABLE } = await bundleModule('./_library-entry.ts');
  const library = JSON.parse(await readFile(
    new URL('../public/blocks.json', import.meta.url), 'utf8'));
  installGeneratedBlocks(library.blocks || []);
  const param = (block, id) => RUNNABLE[block].params.find(p => p.id === id);
  const labelled = (block, id) => Object.fromEntries(
    param(block, id).options.map((v, i) => [param(block, id).optionLabels[i], v]));

  for (const [block, style, marker] of [
    // GRC's own per-sink defaults: a line with no markers on the Time and
    // Frequency Sinks, unconnected circles on the Constellation Sink.
    ['qtgui_time_sink_x', '1', '-1'],
    ['qtgui_freq_sink_x', '1', '-1'],
    ['qtgui_const_sink_x', '0', '0'],
  ]) {
    for (const id of block === 'qtgui_time_sink_x' ? ['1', '2'] : ['1']) {
      assert.equal(labelled(block, `marker${id}`).None, '-1',
        `${block} marker${id} "None" must store QwtSymbol::NoSymbol`);
      assert.equal(labelled(block, `marker${id}`).Circle, '0');
      assert.equal(labelled(block, `style${id}`).None, '0',
        `${block} style${id} "None" must store Qt::NoPen`);
      assert.equal(labelled(block, `style${id}`).Solid, '1');
      assert.equal(param(block, `style${id}`).def, style);
      assert.equal(param(block, `marker${id}`).def, marker);
    }
  }
}

// A .grc that omits them gets the same defaults, since the runner has no yaml.
assert.match(runner, /number_from\(p, "marker" \+ suffix, -1\)/,
  'an unspecified Time/Frequency Sink marker must default to no marker');

console.log('checked complex Time Sink second-trace configuration and line markers');
