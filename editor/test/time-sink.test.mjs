import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as editor } from './editor-contract-source.mjs';

const runner = await readFile(
  new URL('../../runner/src/registry.cpp', import.meta.url), 'utf8');

const { installGeneratedBlocks, RUNNABLE } = await bundleModule('./_library-entry.ts');
const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
installGeneratedBlocks(library.blocks || []);

const param = (block, id) => RUNNABLE[block].params.find(p => p.id === id);
// A line setting is "shown" when it has no showWhen guard or the guard passes.
const shown = (block, id, params) => {
  const p = param(block, id);
  return !!p && (!p.showWhen || p.showWhen(params));
};

// Every QT GUI sink takes nconnections inputs, as native GRC does. The per-line
// settings are generated for ten lines and revealed as connections are added, so
// assert on the resolved schema rather than on how block-defs.ts spells it.
for (const field of ['label', 'width', 'color', 'style', 'marker', 'alpha']) {
  const p = param('qtgui_time_sink_x', `${field}2`);
  assert.ok(p, `Time Sink must expose the second trace's ${field} setting`);
  assert.match(p.label, /Line 2/, `${field}2 must be labelled as line 2`);
}

// A complex input is drawn as two traces (I and Q), a float input as one — which
// is exactly the line count the runner configures (see the assertions below).
assert.ok(shown('qtgui_time_sink_x', 'label2', { type: 'complex', nconnections: 1 }),
  'second-trace settings must be shown for complex input');
assert.ok(!shown('qtgui_time_sink_x', 'label2', { type: 'float', nconnections: 1 }),
  'second-trace settings must be hidden for a single float input');
// ...and a second float connection brings the second trace back.
assert.ok(shown('qtgui_time_sink_x', 'label2', { type: 'float', nconnections: 2 }),
  'a second float input must reveal the second trace');
assert.ok(shown('qtgui_time_sink_x', 'label4', { type: 'complex', nconnections: 2 }),
  'two complex inputs must reveal four traces');
assert.ok(!shown('qtgui_time_sink_x', 'label3', { type: 'complex', nconnections: 1 }),
  'one complex input must not reveal a third trace');

// The other sinks draw one line per connection.
for (const block of ['qtgui_freq_sink_x', 'qtgui_const_sink_x', 'qtgui_waterfall_sink_x']) {
  assert.ok(param(block, 'nconnections'), `${block} must expose nconnections`);
  assert.ok(!shown(block, 'label2', { nconnections: 1 }),
    `${block} must hide the second line with one input`);
  assert.ok(shown(block, 'label2', { nconnections: 2 }),
    `${block} must reveal the second line with two inputs`);
}

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

// A .grc that omits them gets the same defaults, since the runner has no yaml:
// configure_line's own fallbacks are the Time/Frequency Sink's, and a sink whose
// yaml declares others (the Bercurve Sink's circles) overrides them at the call.
assert.match(runner, /int default_style = 1,\s*\n\s*int default_marker = -1\)/,
  'an unspecified Time/Frequency Sink marker must default to no marker');

console.log('checked multi-input QT GUI sink traces and line markers');
