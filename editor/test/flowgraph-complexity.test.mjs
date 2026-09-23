import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as source, markupSource as markup } from './editor-contract-source.mjs';

const { calculateFlowgraphComplexity } =
  await bundleModule('../src/flowgraph-complexity.ts');

const options = () => block('options', 0, 0, true, 'options');
function block(id, inputs, outputs, enabled = true, uid = id,
               optionalInputs = [], optionalOutputs = []) {
  return {
    uid, id, enabled, bypassed: false, name: uid, x: 0, y: 0, rotation: 0, params: {},
    ports: {
      in: Array.from({ length: inputs }, (_, index) =>
        ({ optional: optionalInputs.includes(index) })),
      out: Array.from({ length: outputs }, (_, index) =>
        ({ optional: optionalOutputs.includes(index) })),
    },
  };
}
const connection = (from, fp, to, tp) => ({ from, fp, to, tp });
const calculate = (blocks, connections) =>
  calculateFlowgraphComplexity(blocks, connections, (candidate, kind) => candidate.ports[kind]);

assert.equal(calculate([options()], []), 0, 'an empty flowgraph is zero Bálints');

{
  const blocks = [options(), block('source', 0, 1), block('sink', 1, 0)];
  assert.equal(calculate(blocks, [connection('source', 0, 'sink', 0)]), 1e-6,
    'the smallest connected flowgraph matches native GRC');
}

{
  const blocks = [options(), block('source', 0, 1), block('middle', 1, 1), block('sink', 1, 0)];
  const connections = [
    connection('source', 0, 'middle', 0),
    connection('middle', 0, 'sink', 0),
  ];
  assert.equal(calculate(blocks, connections), 3e-6,
    'a three-block chain matches the native calculator');
}

{
  const blocks = [options(), block('source', 0, 1),
    block('sink1', 1, 0), block('sink2', 1, 0), block('sink3', 1, 0)];
  const connections = [1, 2, 3].map(index => connection('source', 0, `sink${index}`, 0));
  assert.equal(calculate(blocks, connections), 12e-6,
    'output fan-out and the Options-enabled-count quirk match native GRC');
}

{
  const blocks = [options(), block('source1', 0, 1), block('sink1', 1, 0),
    block('source2', 0, 1), block('sink2', 1, 0, false)];
  const connections = [
    connection('source1', 0, 'sink1', 0),
    connection('source2', 0, 'sink2', 0),
  ];
  assert.equal(calculate(blocks, connections), 12e-6,
    'connections touching a disabled block use native disabled multipliers');
}

{
  const blocks = [options(), block('source', 0, 1),
    block('asymmetric', 2, 1), block('sink', 1, 0)];
  const connections = [
    connection('source', 0, 'asymmetric', 0),
    connection('asymmetric', 0, 'sink', 0),
  ];
  assert.equal(calculate(blocks, connections), 2e-6,
    'unequal required-port counts use native port-ratio weighting');
}

{
  const blocks = [options(), block('source', 0, 2, true, 'source', [], [1]),
    block('sink1', 1, 0), block('sink2', 1, 0)];
  const connections = [
    connection('source', 0, 'sink1', 0),
    connection('source', 1, 'sink2', 0),
  ];
  assert.equal(calculate(blocks, connections), 5e-6,
    'optional outputs stay out of the port total but their fan-out still counts');
}

{
  // This topology produces an unrounded 0.0000035. Python's round(value, 6)
  // returns 0.000003 for that binary float; Math.round(value * 1e6) would drift.
  const blocks = [options(), block('a', 1, 2), block('b', 1, 2)];
  const connections = [
    connection('a', 0, 'b', 0), connection('a', 0, 'b', 0),
    connection('a', 1, 'b', 0), connection('b', 0, 'a', 0),
    connection('b', 0, 'a', 0), connection('b', 1, 'a', 0),
    connection('b', 1, 'a', 0),
  ];
  assert.equal(calculate(blocks, connections), 3e-6,
    'six-place rounding follows Python at binary half boundaries');
}

assert.match(source,
  /get\('complexity'\)[\s\S]*?value !== null && value !== '0' && value\.toLowerCase\(\) !== 'false'/,
  '?complexity follows the editor query-flag convention');
assert.match(source,
  /let showFlowgraphComplexity = SHOW_FLOWGRAPH_COMPLEXITY_FROM_URL/,
  'the query flag chooses the checkbox initial state');
assert.match(source,
  /label: 'Show Flowgraph Complexity', run: toggleShowFlowgraphComplexity,[\s\S]*?check: \(\) => showFlowgraphComplexity/,
  'Tools exposes a checked menu item');
assert.match(source,
  /const value = `\$\{fmtVal\(complexity\)\} bal`/,
  'the readout uses the existing native engineering-number formatter');
assert.match(markup,
  /id="canvasHud"[\s\S]*?id="flowgraphComplexity"[\s\S]*?id="trainingStatus"/,
  'complexity and training readouts share a non-overlapping top-right HUD');
assert.match(markup,
  /\.canvas-hud \{[^}]*position:absolute;[^}]*top:12px;[^}]*right:18px;/,
  'the Bálint readout is fixed at the canvas top-right');
assert.match(markup,
  /#app\.embedded \.canvas-hud \{[^}]*top:64px;[^}]*\}[\s\S]*#app\.embedded\.embed-no-controls \.canvas-hud \{[^}]*top:82px;/,
  'the embedded Bálint readout clears both top-right control variants');

console.log('checked native flowgraph complexity and canvas wiring');
