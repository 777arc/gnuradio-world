import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';
import { mainSource as main, cssSource as css } from './editor-contract-source.mjs';

const { validateFlowgraph, NAME_FIELD, BLOCK_FIELD } =
  await bundleModule('../src/validation.ts');

const inst = (uid, id, name, params = {}, extra = {}) => ({
  uid, id, name, params, x: 0, y: 0, enabled: true, rotation: 0,
  bypassed: false, ...extra,
});
const port = (domain = 'stream', vlen = 1, optional = false) =>
  ({ domain, vlen, optional, streamIndex: 0 });
const ports = {
  portCount(block, kind) {
    const def = block.id === 'analog_sig_source_x' ? [0, 1]
      : block.id === 'blocks_null_sink' ? [1, 0]
      : block.id === 'blocks_complex_to_mag_squared' ? [1, 1]
      : [0, 0];
    return def[kind === 'in' ? 0 : 1];
  },
  portMeta() { return port(); },
  portType(block, kind) {
    if (block.id === 'blocks_complex_to_mag_squared') return kind === 'in' ? 'complex' : 'float';
    return block.params.type || 'complex';
  },
  resolvedPorts() { return []; },
};

const signal = inst('sig', 'analog_sig_source_x', 'sig', {
  type: 'complex', samp_rate: 'samp_rate', waveform: 'analog.GR_COS_WAVE',
  frequency: 'samp_rate/4', amplitude: '1',
});
const variable = inst('rate', 'variable', 'samp_rate', { value: '32000' });
assert.deepEqual(validateFlowgraph([variable, signal], [], ports), [],
  'numeric expressions may use active plain variables');

const invalid = validateFlowgraph([
  inst('missing', 'analog_sig_source_x', '', {
    type: 'wrong', samp_rate: 'not_defined', waveform: 'bad', frequency: 1, amplitude: 1,
  }),
  inst('one', 'variable', 'duplicate', { value: 1 }),
  inst('two', 'variable', 'duplicate', { value: 2 }),
], [], ports);
assert.ok(invalid.some(issue => issue.field === NAME_FIELD && issue.message === 'Block ID is required.'));
assert.ok(invalid.some(issue => issue.message.includes('is used more than once')));
assert.ok(invalid.some(issue => issue.message.includes('must be a number')));
assert.ok(invalid.some(issue => issue.message.includes('unsupported value')));

const live = inst('range', 'variable_qtgui_range', 'freq', {
  label: '', rangeType: 'float', value: 10, start: 20, stop: 10, step: 0,
  widget: 'slider', orient: 'QtCore.Qt.Horizontal', min_len: 0,
});
signal.params.frequency = 'freq/2';
const liveIssues = validateFlowgraph([live, signal], [], ports);
assert.ok(liveIssues.some(issue => issue.message.includes('only on its own')));
assert.ok(liveIssues.some(issue => issue.field === 'stop'));
assert.ok(liveIssues.some(issue => issue.field === 'step'));
assert.ok(liveIssues.some(issue => issue.field === 'min_len'));

const sink = inst('sink', 'blocks_null_sink', 'sink', { type: 'float' });
const mismatch = validateFlowgraph([signal, sink], [{ from: 'sig', fp: 0, to: 'sink', tp: 0 }], ports);
assert.ok(mismatch.some(issue => issue.field === BLOCK_FIELD && issue.message.includes('type mismatch')));
const badPort = validateFlowgraph([signal, sink], [{ from: 'sig', fp: 4, to: 'sink', tp: 0 }], ports);
assert.ok(badPort.some(issue => issue.message.includes('invalid output port')));

const disabled = inst('disabled', 'unknown', '', {}, { enabled: false });
assert.ok(validateFlowgraph([disabled], [], ports).every(issue => !issue.blocking),
  'disabled-block diagnostics do not prevent a run');

// Keep a small integration contract for presentation and run wiring. Business
// rules above are tested through the module API instead of source regexes.
assert.match(main, /validateGraph\(\)\.filter\(issue => issue\.blocking\)/);
assert.match(main, /class: 'validation-error'/);
assert.match(main, /setFieldError\(/);
for (const selector of ['.blk.invalid rect.body', '.wire.invalid', '.field-invalid', '.field-error'])
  assert.ok(css.includes(selector), `missing ${selector} validation style`);

console.log('checked validation behavior and error presentation');
