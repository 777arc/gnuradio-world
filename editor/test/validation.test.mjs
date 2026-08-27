import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as main, cssSource as css } from './editor-contract-source.mjs';

const { validateFlowgraph, NAME_FIELD, BLOCK_FIELD, VARIABLE_CONTROL_IDS } =
  await bundleModule('../src/validation.ts');
// The hand-written schemas the cases below use (analog_sig_source_x, variable,
// the null sink) come from block-defs, which is where validateFlowgraph's
// injected `def` accessor reads them from in the editor too.
const { RUNNABLE: DEFS } = await bundleModule('../src/block-defs.ts');
const {
  dismissUnpacedRunWarning,
  hasActiveRateLimiter,
  shouldWarnAboutUnpacedRun,
  unpacedRunWarningDismissed,
} = await bundleModule('../src/run-pacing.ts');

const inst = (uid, id, name, params = {}, extra = {}) => ({
  uid, id, name, params, x: 0, y: 0, enabled: true, rotation: 0,
  bypassed: false, ...extra,
});

// Run-time pacing is a warning rather than a validation error: only an enabled,
// non-bypassed block carrying GNU Radio's `throttle` flag suppresses it.
const rateLimiters = new Set(['blocks_throttle2', 'audio_sink', 'wasm_rtlsdr_source']);
const sourceOnly = [inst('src', 'analog_sig_source_x', 'src')];
assert.equal(shouldWarnAboutUnpacedRun(sourceOnly, rateLimiters), true);
assert.equal(hasActiveRateLimiter([
  ...sourceOnly, inst('thr', 'blocks_throttle2', 'thr'),
], rateLimiters), true);
assert.equal(shouldWarnAboutUnpacedRun([
  ...sourceOnly, inst('audio', 'audio_sink', 'audio'),
], rateLimiters), false, 'naturally paced audio counts like a Throttle block');
assert.equal(shouldWarnAboutUnpacedRun([
  ...sourceOnly, inst('radio', 'wasm_rtlsdr_source', 'radio', {}, { enabled: false }),
], rateLimiters), true, 'disabled hardware does not pace the running graph');
assert.equal(shouldWarnAboutUnpacedRun([
  ...sourceOnly, inst('thr', 'blocks_throttle2', 'thr', {}, { bypassed: true }),
], rateLimiters), true, 'a bypassed Throttle does not pace the running graph');

const stored = new Map();
const storage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
};
assert.equal(unpacedRunWarningDismissed(storage), false);
dismissUnpacedRunWarning(storage);
assert.equal(unpacedRunWarningDismissed(storage), true,
  'the do-not-remind choice persists for later runs');
assert.match(main,
  /if \(!await askToRunUnpacedFlowgraph\(\)\)[\s\S]*?flowgraph has no rate limit/,
  'the visible Run path must await the unpaced-flowgraph confirmation');
// ...and the unattended path must NOT, because there is nobody to answer it: a
// modal waiting on a click that never comes hangs whoever asked for the run,
// with no timeout on that path. Graham's runs go through here.
assert.match(main,
  /options\.unattended[\s\S]{0,400}isUnpacedFlowgraph\(\)[\s\S]{0,300}cannot run: the flowgraph has no rate limit/,
  'an unattended run must decline an unpaced flowgraph instead of opening the dialog');
assert.match(main, /blocks_throttle2/,
  'and must name the block that fixes it, since the caller acts on that line');
assert.match(main,
  /isUnpacedFlowgraph: \(\) => !unpacedRunWarningDismissed\(\)/,
  'the unattended predicate must honour the do-not-remind choice, so it declines ' +
  'exactly the runs a human would have been asked about');
assert.match(main, /run: \(\) => run\(\{ unattended: true \}\)/,
  "Graham's run harness must take the unattended path");
assert.match(main,
  /blockFlags\(block\.flags\)\.includes\('throttle'\)/,
  'the warning must use GNU Radio metadata for Throttle, SDR, and audio blocks');
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

// An expression parameter that is not numeric -- filter taps, a raw vector --
// is evaluated by native GRC against the flowgraph's namespace, so a bare name
// the flowgraph does not define is an error there. Without this the text would
// reach the runner and be coerced to zero silently. Module access and names the
// flowgraph does publish stay legal.
{
  const taps = inst('lpf', 'blocks_complex_to_mag_squared', 'lpf', {});
  // Only the parameter issues matter here; the stub block is unconnected, which
  // raises connectivity issues of its own.
  const withValue = params => { taps.params = params; return validateFlowgraph(
    [variable, taps], [], { ...ports, def: () => ({
      label: 'x', inputs: 1, outputs: 1,
      params: [{ id: 'taps', label: 'Taps', type: 'string', dtype: 'real_vector', def: '' }],
    }) }).filter(issue => issue.field === 'taps'); };

  const undefinedRef = withValue({ taps: 'firdes.low_pass(1, sample_rate, 1e3, 1e3)' });
  assert.ok(undefinedRef.some(issue => issue.message.includes('references "sample_rate"')),
    'an undefined name in an expression parameter is reported');

  assert.deepEqual(withValue({ taps: 'firdes.low_pass(1, samp_rate, 1e3, 1e3)' }), [],
    'a name the flowgraph defines is not reported');
  assert.deepEqual(withValue({ taps: 'digital.constellation_bpsk().points()' }), [],
    'module access this evaluator does not model is not a missing variable');
}

// A vector parameter may name a live control, but only on its own -- the runner
// binds a control to a parameter by matching the whole value against the
// control's ID. Wrapping it in a list, which is how a one-element vector reads
// to anyone writing one by hand, silently reaches the runner as literal text.
{
  const control = inst('ctl', 'variable_qtgui_range', 'target_range', {
    label: '', rangeType: 'float', value: 200, start: 50, stop: 500, step: 1,
    widget: 'counter_slider', orient: 'QtCore.Qt.Horizontal', min_len: 200,
  });
  const sim = inst('sim', 'blocks_complex_to_mag_squared', 'sim', {});
  const withRange = value => { sim.params = { range: value }; return validateFlowgraph(
    [control, variable, sim], [], { ...ports, def: block => block.id === 'variable_qtgui_range'
      ? DEFS[block.id]
      : ({ label: 'x', inputs: 1, outputs: 1,
           params: [{ id: 'range', label: 'Range', type: 'string',
                      dtype: 'real_vector', def: '' }] }) })
    .filter(issue => issue.field === 'range'); };

  assert.ok(withRange('[target_range]').some(issue => issue.message.includes('only on its own')),
    'a live control wrapped in a list literal is reported');
  assert.deepEqual(withRange('target_range'), [],
    "GRC's own spelling -- the control on its own -- is accepted");
  assert.deepEqual(withRange('[samp_rate]'), [],
    'a plain variable inside a list literal stays legal');
}

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

// Desktop GRC stores an enum value with the quotes its own code generation needs
// (`rangeType: '"float"'` against options spelled `float`), so both spellings
// have to name the same choice or importing a native flowgraph reports an error
// on a field the user cannot fix.
const quoted = inst('quoted', 'variable_qtgui_range', 'gain', {
  label: '', rangeType: '"float"', value: 5, start: 0, stop: 10, step: 1,
  widget: 'slider', orient: 'QtCore.Qt.Horizontal', min_len: 100,
});
assert.deepEqual(validateFlowgraph([quoted], [], ports)
  .filter(issue => issue.field === 'rangeType'), [],
  'a quoted enum value picks the same option as the bare one');

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

  // Complex noise is Uniform or Gaussian only: the gr_complex specializations of
  // both noise sources have no Laplacian or Impulse case and throw "invalid
  // type", and Fast Noise Source throws it from its *constructor*, so without
  // this the flowgraph dies at Run with only that string to explain itself.
  // Generated schema, hence this scope rather than the DEFS-backed cases above.
  const noisePorts = { ...ports, def: block => RUNNABLE[block.id] };
  const noise = params => inst('noise', 'analog_fastnoise_source_x', 'noise',
    { amp: 1, seed: 0, samples: 8192, ...params });
  assert.ok(validateFlowgraph(
    [noise({ type: 'complex', noise_type: 'analog.GR_LAPLACIAN' })], [], noisePorts)
    .some(issue => issue.field === 'noise_type' && issue.blocking &&
          issue.message.includes('Uniform and Gaussian')),
    'complex + Laplacian is refused on the Noise Type field');
  for (const params of [
    { type: 'complex', noise_type: 'analog.GR_GAUSSIAN' },  // complex has this one
    { type: 'float', noise_type: 'analog.GR_LAPLACIAN' },   // every real type has all four
    { type: 'complex', noise_type: 'analog::GR_UNIFORM' },  // the runner's spelling
  ])
    assert.ok(!validateFlowgraph([noise(params)], [], noisePorts)
      .some(issue => issue.field === 'noise_type'),
      `${params.type} + ${params.noise_type} is a supported combination`);

  const hackrfPorts = {
    ...ports,
    def: block => RUNNABLE[block.id],
    portCount: (block, kind) =>
      block.id === 'wasm_hackrf_source' && kind === 'out' ? 1 : 0,
    portType: () => 'complex',
  };
  const invalidHackRf = inst('hackrf', 'wasm_hackrf_source', 'hackrf', {
    device: 'fake', samp_rate: 1000000, center_freq: 7000000000,
    bandwidth: 1234567, lna_gain: 17, vga_gain: 15,
    amp: 'False', bias_tee: 'False', transfer_size: 1000,
  });
  const hackrfFields = new Set(validateFlowgraph(
    [invalidHackRf], [], hackrfPorts).map(issue => issue.field));
  for (const field of [
    'samp_rate', 'center_freq', 'bandwidth', 'lna_gain', 'vga_gain', 'transfer_size',
  ])
    assert.ok(hackrfFields.has(field), `invalid HackRF ${field} must block the run`);

  // Audio Sink's two limits are the browser's, not a device's: an AudioContext
  // refuses a rate outside 3 kHz-384 kHz outright, and Web Audio caps a node at
  // 32 channels. Both are cheaper to catch here than as a failed run.
  const audioPorts = {
    ...ports,
    def: block => RUNNABLE[block.id],
    portCount: () => 0,
    portType: () => 'float',
  };
  const invalidAudio = inst('audio', 'audio_sink', 'audio', {
    samp_rate: 1000, device_name: '', ok_to_block: 'True', num_inputs: 0,
  });
  const audioFields = new Set(validateFlowgraph(
    [invalidAudio], [], audioPorts).map(issue => issue.field));
  for (const field of ['samp_rate', 'num_inputs'])
    assert.ok(audioFields.has(field), `invalid Audio Sink ${field} must block the run`);
  assert.equal(validateFlowgraph([inst('audio', 'audio_sink', 'audio', {
    samp_rate: 48000, device_name: '', ok_to_block: 'True', num_inputs: 2,
  })], [], audioPorts).length, 0, 'a stereo 48 kHz Audio Sink is valid');

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

  // A block must never arrive on the canvas holding a value it rejects, which is
  // what a choice parameter whose default is not one of its own options amounts
  // to: place it, and the title goes red over a field the user never touched.
  // Nearly forty parameters were in that state upstream (a widget hint pasted
  // into `default:`, an option label where the value belongs, a value older than
  // the option list); gen_blocklib.py's enum_default repairs them, so assert the
  // property over the whole palette rather than over the blocks that happened to
  // be noticed. Options are compared the way validateFlowgraph compares them --
  // a boolean option would fail typeof, and Python quoting is not a difference.
  const unquote = text => {
    const trimmed = String(text).trim();
    return trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && /['"]/.test(trimmed[0])
      ? trimmed.slice(1, -1) : trimmed;
  };
  for (const block of library.blocks || []) {
    for (const param of block.params || []) {
      const options = param.options || [];
      for (const option of options)
        assert.notEqual(typeof option, 'boolean',
          `${block.id}.${param.id} offers a boolean option; a .grc stores text`);
      // `bool` joins `enum` because the editor resolves both to a choice field.
      if (!options.length || !['enum', 'bool'].includes(String(param.dtype))) continue;
      if (param.default === '' || param.default == null) continue;  // means options[0]
      assert.ok(options.some(option => unquote(option) === unquote(param.default)),
        `${block.id}.${param.id} defaults to ${JSON.stringify(param.default)}, ` +
        `which is not one of ${JSON.stringify(options)}`);
    }
  }

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
