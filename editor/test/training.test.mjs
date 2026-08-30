import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as main, htmlSource as html, cssSource as css } from './editor-contract-source.mjs';

const {
  TrainingSession,
  TRAINING_SNAP_ENTER,
  TRAINING_SNAP_EXIT,
} = await bundleModule('../src/training.ts');

const block = (uid, id, name, x, y, params = {}) => ({
  uid, id, name, x, y, params, enabled: true, rotation: 0, bypassed: false,
});
const options = block('t0', 'options', 'options', 10, 10);
const sourceA = block('t1', 'analog_sig_source_x', 'analog_sig_source_x_0', 100, 100,
  { freq: 1000 });
const sourceB = block('t2', 'analog_sig_source_x', 'analog_sig_source_x_1', 500, 100,
  { freq: 2000 });
const sink = block('t3', 'qtgui_time_sink_x', 'qtgui_time_sink_x_0', 800, 100,
  { nconnections: 2 });
const template = {
  insts: [options, sourceA, sourceB, sink],
  conns: [
    { from: 't1', fp: 0, to: 't3', tp: 0 },
    { from: 't2', fp: 0, to: 't3', tp: 1 },
  ],
  counter: 4,
};
const session = new TrainingSession(template, ['options']);
const actualOptions = structuredClone(options);
const actualA = block('b5', sourceA.id, 'analog_sig_source_x_2', 10, 300);
const actualB = block('b6', sourceB.id, 'analog_sig_source_x_3', 10, 400);
const actualSink = block('b7', sink.id, 'qtgui_time_sink_x_1', 10, 500);
const live = [actualOptions, actualA, actualB, actualSink];

assert.deepEqual([...session.reservedNames(live)].sort(),
  [sourceA.name, sourceB.name, sink.name].sort(), 'unfilled target names stay reserved');
assert.equal(session.updateSnapCandidate(actualA, 10, 300, live), undefined,
  'a matching block does not snap from far away');
assert.equal(session.updateSnapCandidate(actualSink, sourceA.x, sourceA.y, live), undefined,
  'a different block type cannot fill the target');

assert.equal(session.updateSnapCandidate(
  actualA, sourceA.x + TRAINING_SNAP_ENTER, sourceA.y, live)?.uid, sourceA.uid,
  'entering the magnetic radius previews the nearest same-type target');
assert.equal(session.unfilledBlocks(live).some(item => item.uid === sourceA.uid), false,
  'the previewed ghost is hidden while the pointer is held');
assert.equal(session.updateSnapCandidate(
  actualA, sourceA.x + TRAINING_SNAP_EXIT - 1, sourceA.y, live)?.uid, sourceA.uid,
  'the wider exit radius prevents boundary flicker');
assert.equal(session.updateSnapCandidate(
  actualA, sourceA.x + TRAINING_SNAP_EXIT + 1, sourceA.y, live), undefined,
  'moving beyond the exit radius detaches the preview');

session.updateSnapCandidate(actualA, sourceA.x, sourceA.y, live);
assert.equal(session.commitSnap(actualA.uid)?.uid, sourceA.uid);
assert.equal(session.targetForActual(actualA.uid)?.uid, sourceA.uid);
assert.equal(session.counts(live, []).filledBlocks, 1);

assert.equal(session.updateSnapCandidate(actualB, sourceB.x + 5, sourceB.y, live)?.uid, sourceB.uid,
  'duplicate block types fill their nearest remaining slot');
session.commitSnap(actualB.uid);
session.updateSnapCandidate(actualSink, sink.x, sink.y, live);
session.commitSnap(actualSink.uid);
assert.deepEqual(session.counts(live, []), {
  filledBlocks: 3, totalBlocks: 3, filledConnections: 0, totalConnections: 2,
});

const wrong = [{ from: actualA.uid, fp: 0, to: actualSink.uid, tp: 1 }];
assert.equal(session.connectionGuides(live, wrong).length, 2,
  'a connection to the wrong target port does not consume a guide');
const correctA = { from: actualA.uid, fp: 0, to: actualSink.uid, tp: 0 };
assert.equal(session.connectionGuides(live, [correctA]).length, 1,
  'only the exact completed target connection disappears');
const correctB = { from: actualB.uid, fp: 0, to: actualSink.uid, tp: 1 };
assert.equal(session.complete(live, [correctA, correctB]), true);

const saved = session.capture();
const withoutA = live.filter(item => item !== actualA);
assert.equal(session.unfilledBlocks(withoutA).some(item => item.uid === sourceA.uid), true,
  'deleting an assigned block restores its ghost');
assert.equal(session.connectionGuides(withoutA, [correctB]).length, 1,
  'deleting a block restores the affected connection guide');

session.restore(saved);
assert.equal(session.complete(live, [correctA, correctB]), true,
  'history can restore target assignments independently of the template');

assert.match(main, /URLSearchParams\(location\.search\)\.get\('training'\)/,
  'the training example is selected through a query parameter');
assert.match(main, /pointermove[\s\S]*updateSnapCandidate[\s\S]*commitSnap/,
  'magnetic feedback happens during movement and commits on release');
assert.match(main, /async function run[\s\S]*trainingSession\.complete/,
  'the Run path independently refuses an incomplete lesson');
assert.match(html, /id="trainingWires"[\s\S]*id="trainingNodes"/,
  'training guides have dedicated canvas layers');
assert.match(css, /\.training-ghost[\s\S]*stroke-dasharray/,
  'ghost blocks have an outline-only dashed treatment');
assert.match(css, /\.training-wire[\s\S]*stroke-dasharray/,
  'ghost connections have a dashed treatment');

console.log('checked training block magnets, assignments, connection guides, and restoration');
