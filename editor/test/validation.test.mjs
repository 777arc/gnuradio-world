import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { mainSource as main, cssSource as css } from './editor-contract-source.mjs';

const { validateFlowgraph, NAME_FIELD, BLOCK_FIELD, VARIABLE_CONTROL_IDS } =
  await bundleModule('../src/validation.ts');
// The hand-written schemas the cases below use (analog_sig_source_x, variable,
// the null sink) come from block-defs, which is where validateFlowgraph's
// injected `def` accessor reads them from in the editor too.
const { RUNNABLE: DEFS } = await bundleModule('../src/block-defs.ts');

const inst = (uid, id, name, params = {}, extra = {}) => ({
  uid, id, name, params, x: 0, y: 0, enabled: true, rotation: 0,
  bypassed: false, ...extra,
});
// Port counts per block id, as [inputs, outputs]. `blocks_complex_to_float`
// stands in for the optional-port case: native GRC marks its `im` output
// optional, so leaving it dangling is legal.
const PORTS = {
  analog_sig_source_x: [0, 1],
  blocks_null_sink: [1, 0],
  blocks_complex_to_mag_squared: [1, 1],
  blocks_complex_to_float: [1, 2],
};
const ports = {
  portCount(block, kind) { return (PORTS[block.id] || [0, 0])[kind === 'in' ? 0 : 1]; },
  portMeta(block, kind, index) {
    return {
      domain: 'stream', vlen: 1, streamIndex: index,
      name: `${kind}${index}`,
      optional: block.id === 'blocks_complex_to_float' && kind === 'out' && index === 1,
      hidden: false,
    };
  },
  portType(block, kind) {
    if (block.id === 'blocks_complex_to_mag_squared') return kind === 'in' ? 'complex' : 'float';
    if (block.id === 'blocks_complex_to_float') return kind === 'in' ? 'complex' : 'float';
    return block.params.type || 'complex';
  },
  // Definitions are looked up per instance, because an Embedded Python Block's
  // parameters come from its own source rather than from its block id. Every
  // block here has a plain generated schema, so this is the id lookup.
  def(block) { return DEFS[block.id]; },
};

const signal = inst('sig', 'analog_sig_source_x', 'sig', {
  type: 'complex', samp_rate: 'samp_rate', waveform: 'analog.GR_COS_WAVE',
  frequency: 'samp_rate/4', amplitude: '1',
});
const variable = inst('rate', 'variable', 'samp_rate', { value: '32000' });
const terminated = inst('term', 'blocks_null_sink', 'term', { type: 'complex', vlen: 1 });
const wired = [{ from: 'sig', fp: 0, to: 'term', tp: 0 }];
assert.deepEqual(validateFlowgraph([variable, signal, terminated], wired, ports), [],
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

const sink = inst('sink', 'blocks_null_sink', 'sink', { type: 'float', vlen: 1 });
const mismatch = validateFlowgraph([signal, sink], [{ from: 'sig', fp: 0, to: 'sink', tp: 0 }], ports);
assert.ok(mismatch.some(issue => issue.field === BLOCK_FIELD && issue.message.includes('type mismatch')));
const badPort = validateFlowgraph([signal, sink], [{ from: 'sig', fp: 4, to: 'sink', tp: 0 }], ports);
assert.ok(badPort.some(issue => issue.message.includes('invalid output port')));

const disabled = inst('disabled', 'unknown', '', {}, { enabled: false });
assert.ok(validateFlowgraph([disabled], [], ports).every(issue => !issue.blocking),
  'disabled-block diagnostics do not prevent a run');

// Port connectivity, as native GRC enforces it (grc/core/ports/port.py).
const source = inst('src', 'analog_sig_source_x', 'src', {
  type: 'complex', samp_rate: 32000, waveform: 'analog.GR_COS_WAVE',
  frequency: 1000, amplitude: 1,
});
const drain = inst('drain', 'blocks_null_sink', 'drain', { type: 'complex', vlen: 1 });
const link = { from: 'src', fp: 0, to: 'drain', tp: 0 };
const unconnected = validateFlowgraph([source, drain], [], ports);
assert.deepEqual(unconnected.map(issue => issue.message).sort(), [
  'Input port "in0" is not connected.',
  'Output port "out0" is not connected.',
], 'both ends of an unwired pair report their dangling port');
assert.ok(unconnected.every(issue => issue.blocking && issue.field === BLOCK_FIELD),
  'a dangling port is a blocking, block-level error so the title goes red');
assert.deepEqual(validateFlowgraph([source, drain], [link], ports), [],
  'a wired pair is clean');

// An optional port needs no connection; its non-optional sibling still does.
const split = inst('split', 'blocks_complex_to_float', 'split', {});
const optionalPorts = validateFlowgraph([source, split], [{ from: 'src', fp: 0, to: 'split', tp: 0 }], ports);
assert.deepEqual(optionalPorts.map(issue => issue.message),
  ['Output port "out0" is not connected.'],
  'only the required output of Complex To Float is reported');

// A hidden port is not connectable, so it is not required either.
const hiddenPorts = { ...ports, portMeta: (block, kind, index) =>
  ({ ...ports.portMeta(block, kind, index), hidden: true }) };
assert.deepEqual(validateFlowgraph([source, drain], [], hiddenPorts), [],
  'hidden ports are exempt, matching GRC\'s `not optional and not hidden`');

// A disabled neighbour breaks the connection; a bypassed one still carries it,
// and a bypassed block's own ports are never reported.
const passthrough = (extra) =>
  inst('pass', 'blocks_complex_to_mag_squared', 'pass', {}, extra);
const chain = [{ from: 'src', fp: 0, to: 'pass', tp: 0 }, { from: 'pass', fp: 0, to: 'drain', tp: 0 }];
assert.deepEqual(validateFlowgraph([source, passthrough({ enabled: false }), drain], chain, ports)
  .map(issue => issue.message).sort(), [
  'Input port "in0" is not connected.',
  'Output port "out0" is not connected.',
], 'a disabled block leaves its neighbours dangling');
assert.deepEqual(validateFlowgraph([source, passthrough({ bypassed: true }), drain], chain, ports), [],
  'a bypassed block is wired through and reports nothing itself');

// The rule above is only as good as the `optional` flag it reads, and a
// hand-written schema has no port templates to carry one — installGeneratedBlocks
// has to lift it out of blocks.json instead. Complex To Float is the case that
// matters: native GRC marks its `im` output optional, and without this the
// editor would demand a connection the desktop never asks for.
{
  const { installGeneratedBlocks, RUNNABLE, portOptional } =
    await bundleModule('./_library-entry.ts');
  const library = JSON.parse(await readFile(
    new URL('../public/blocks.json', import.meta.url), 'utf8'));
  installGeneratedBlocks(library.blocks || []);
  assert.deepEqual(RUNNABLE.blocks_complex_to_float.outOptional, [false, true],
    'the hand-written Complex To Float schema must inherit its optional `im` output');
  assert.deepEqual(RUNNABLE.blocks_complex_to_float.inOptional, [false]);
  assert.deepEqual(RUNNABLE.analog_sig_source_x.outOptional, [false],
    'a plain source output stays required');

  // The flag is native's EvaluatedFlag, not a string: a `${ ... }` expression is
  // evaluated against the block's parameters and defaults to False — required —
  // when it cannot be. Reading the template text as truthy is what used to
  // exempt every QT GUI sink input from the connectivity rule above.
  assert.equal(portOptional(undefined, {}), false);
  assert.equal(portOptional(true, {}), true);
  assert.equal(portOptional(0, {}), false, 'the yaml `optional: 0` spelling is False');
  assert.equal(portOptional(1, {}), true);
  assert.equal(portOptional('${ opt }', { opt: 'True' }), true);
  assert.equal(portOptional('${ opt }', { opt: 'False' }), false);
  assert.equal(portOptional('${ not showports }', { showports: 'True' }), false);
  assert.equal(portOptional("${ (True if type.startswith('msg') else False) }", { type: 'complex' }),
    false, 'an expression this evaluator cannot read leaves the port required, as native does');
  for (const id of ['qtgui_time_sink_x', 'qtgui_freq_sink_x',
                    'qtgui_const_sink_x', 'qtgui_waterfall_sink_x'])
    assert.deepEqual(RUNNABLE[id].inOptional, [false],
      `${id} must require its stream input, like native GRC`);

  // An enum's options have to be spelled the way a .grc spells its values, or
  // validateFlowgraph rejects the block for holding its own default. Most
  // boolean parameters write `options: ['True', 'False']`, but a few blocks --
  // Matrix Interleaver, QT GUI Matrix Sink, three gr-satellites decoders --
  // leave the quotes off, so yaml hands back Python booleans; gen_blocklib.py
  // normalizes them, and this asserts no other type ever reaches the palette.
  for (const block of library.blocks || []) {
    for (const param of block.params || []) {
      for (const option of param.options || [])
        assert.notEqual(typeof option, 'boolean',
          `${block.id}.${param.id} offers a boolean option; a .grc stores text`);
    }
  }
  const deint = RUNNABLE.blocks_matrix_interleaver.params.find(p => p.id === 'deint');
  assert.deepEqual(deint.options, ['True', 'False']);
  assert.ok(deint.options.includes(String(deint.def)),
    'Matrix Interleaver must not arrive holding a Deinterleave value it rejects');

  // VARIABLE_CONTROL_IDS is a hand-kept copy of `is_variable_control()` in
  // runner/src/grc_lower.hpp, and the two disagreeing is silent in the worst
  // way: the runner resolves a parameter naming a control the editor does not
  // know is one, so the editor rejects a flowgraph that would have run — with
  // the wrong reason ("only on its own, not inside an expression") for a
  // reference that is on its own. Assert the C++ rule against what the palette
  // actually offers.
  const controls = (library.blocks || []).filter(block => block.runnable &&
    (String(block.id).startsWith('variable_qtgui_') ||
     block.id === 'qtgui_msgdigitalnumbercontrol')).map(block => block.id);
  assert.deepEqual([...VARIABLE_CONTROL_IDS].sort(), controls.sort(),
    'VARIABLE_CONTROL_IDS must match is_variable_control() in grc_lower.hpp');
}

// Keep a small integration contract for presentation and run wiring. Business
// rules above are tested through the module API instead of source regexes.
assert.match(main, /validateGraph\(\)\.filter\(issue => issue\.blocking\)/);
assert.match(main, /class: 'validation-error'/);
assert.match(main, /setFieldError\(/);
for (const selector of ['.blk.invalid rect.body', '.wire.invalid', '.field-invalid', '.field-error'])
  assert.ok(css.includes(selector), `missing ${selector} validation style`);

console.log('checked validation behavior and error presentation');
