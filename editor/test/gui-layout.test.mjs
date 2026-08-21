// The GUI Layout block: the grid that decides where a flowgraph's QT GUI
// widgets go in the runner window, replacing GRC's per-block `gui_hint`.
//
// Covers the packing rules in editor/src/gui-layout.ts (DOM-free, so they run
// here directly) plus the wiring on either side of them that a type check
// cannot see: that the block is a required singleton like Options, that the
// runner and the editor agree about the spec, and that both ends of the
// live-Arrange round trip name the same messages.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

// gui-layout.ts is TypeScript; bundle it, same as note.test.mjs and grid.test.mjs.
const out = join(tmpdir(), `gui-layout-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/gui-layout.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const {
  DEFAULT_COLUMNS, DEFAULT_ROW_HEIGHT, MAX_COLUMNS, CONTROL_ROWS, SINK_ROWS,
  clampTile, parseTiles, serializeTiles, settle, rowsUsed, packLayout, placeTile,
  layoutColumns, layoutRowHeight, isControlWidget,
} = await import(pathToFileURL(out));

const tile = (col, row, w, h) => ({ col, row, w, h });

// ---- parse / serialize round trip -----------------------------------------
{
  const text = '{"a":[0,0,6,4],"b":[6,0,6,2]}';
  const parsed = parseTiles(text);
  assert.deepEqual(parsed.a, tile(0, 0, 6, 4));
  assert.deepEqual(parsed.b, tile(6, 0, 6, 2));
  // Byte-identical on the way out, so re-saving an untouched flowgraph does not
  // rewrite its .grc. Keys are sorted for the same reason.
  assert.equal(serializeTiles(parsed), text);
  assert.equal(serializeTiles(parseTiles('{"b":[6,0,6,2],"a":[0,0,6,4]}')), text);
}

// A spec is cosmetic: nothing in it may make loading a flowgraph fail.
for (const bad of ['', 'null', '[]', 'not json', '{"a":[1,2]}', '{"a":"x"}', '{"a":[1,2,3,"x"]}'])
  assert.deepEqual(parseTiles(bad), {}, `parseTiles(${JSON.stringify(bad)})`);
// A partly-bad spec keeps the tiles that are fine.
assert.deepEqual(parseTiles('{"a":[0,0,4,2],"b":[1,2]}'), { a: tile(0, 0, 4, 2) });

// ---- clamping into the grid ------------------------------------------------
{
  // Too wide: narrowed, not moved.
  assert.deepEqual(clampTile(tile(0, 0, 99, 1), 12), tile(0, 0, 12, 1));
  // Off the right edge: pulled back so the whole tile is inside.
  assert.deepEqual(clampTile(tile(10, 0, 6, 1), 12), tile(6, 0, 6, 1));
  // Negatives and zero spans are not representable.
  assert.deepEqual(clampTile(tile(-4, -2, 0, 0), 12), tile(0, 0, 1, 1));
}

// ---- settle: no overlaps, no gaps ------------------------------------------
{
  // Two tiles asking for the same cell: one keeps it, the other lands below.
  const settled = settle({ a: tile(0, 0, 6, 2), b: tile(0, 0, 6, 2) }, 12);
  const rows = Object.values(settled).map(t => t.row).sort();
  assert.deepEqual(rows, [0, 2], 'the second tile drops below the first');
}
{
  // Side by side is not an overlap: both keep row 0.
  const settled = settle({ a: tile(0, 0, 6, 4), b: tile(6, 0, 6, 4) }, 12);
  assert.equal(settled.a.row, 0);
  assert.equal(settled.b.row, 0);
}
{
  // Gaps close upward, which is what keeps the runner's equally-stretched rows
  // meaningful -- an empty row would otherwise take a share of the window.
  const settled = settle({ a: tile(0, 7, 12, 1) }, 12);
  assert.equal(settled.a.row, 0, 'a lone tile rises to the top');
}
{
  // The dragged tile wins its row and pushes the incumbent down.
  const settled = settle({ held: tile(0, 0, 12, 2), moved: tile(0, 0, 12, 2) }, 12, 'moved');
  assert.equal(settled.moved.row, 0);
  assert.equal(settled.held.row, 2);
}
{
  // Nothing overlaps anything, for a deliberately tangled input.
  const messy = { a: tile(0, 0, 8, 3), b: tile(4, 1, 8, 3), c: tile(2, 2, 6, 2), d: tile(0, 0, 12, 1) };
  const settled = settle(messy, 12);
  const entries = Object.values(settled);
  for (let i = 0; i < entries.length; ++i)
    for (let j = i + 1; j < entries.length; ++j) {
      const [x, y] = [entries[i], entries[j]];
      const hit = x.col < y.col + y.w && y.col < x.col + x.w &&
                  x.row < y.row + y.h && y.row < x.row + x.h;
      assert.equal(hit, false, `${JSON.stringify(x)} overlaps ${JSON.stringify(y)}`);
    }
  assert.equal(settled.a.row, 0, 'the topmost tile still starts at the top');
}

// ---- packLayout: the arrangement a flowgraph actually gets ------------------
{
  const widgets = [
    { name: 'qtgui_freq_sink_x_0', id: 'qtgui_freq_sink_x' },
    { name: 'freq', id: 'variable_qtgui_range' },
  ];
  // Never arranged: every widget gets a full-width row, tallest-first by kind.
  // This is the same fallback apply_gui_layout() uses in the runner, so an
  // unarranged flowgraph looks the same in the preview and in the window.
  const packed = packLayout(widgets, {}, 12);
  assert.deepEqual(packed.qtgui_freq_sink_x_0, tile(0, 0, 12, SINK_ROWS));
  assert.deepEqual(packed.freq, tile(0, SINK_ROWS, 12, CONTROL_ROWS));
  assert.equal(isControlWidget('variable_qtgui_range'), true);
  assert.equal(isControlWidget('qtgui_freq_sink_x'), false);
}
{
  const widgets = [{ name: 'sink', id: 'qtgui_time_sink_x' },
                   { name: 'added_later', id: 'qtgui_freq_sink_x' }];
  // A sink added since the flowgraph was arranged goes *below* what is placed,
  // never on top of it -- the one rule that keeps a new sink from being invisible.
  const packed = packLayout(widgets, { sink: tile(0, 0, 6, 3) }, 12);
  assert.deepEqual(packed.sink, tile(0, 0, 6, 3));
  assert.equal(packed.added_later.row >= 3, true, 'the new widget lands under the placed one');
}
{
  // A tile whose block is gone does not linger in the arrangement.
  const packed = packLayout([{ name: 'kept', id: 'qtgui_time_sink_x' }],
                            { kept: tile(0, 0, 12, 2), deleted: tile(0, 2, 12, 2) }, 12);
  assert.deepEqual(Object.keys(packed), ['kept']);
}
{
  // Re-packing an arrangement changes nothing: opening and saving a flowgraph
  // must not rewrite its layout.
  const widgets = [{ name: 'a', id: 'qtgui_time_sink_x' }, { name: 'b', id: 'qtgui_freq_sink_x' }];
  const once = packLayout(widgets, {}, 12);
  assert.equal(serializeTiles(packLayout(widgets, once, 12)), serializeTiles(once));
}

// ---- placeTile: one drag ---------------------------------------------------
{
  const start = { a: tile(0, 0, 6, 2), b: tile(6, 0, 6, 2) };
  // Drop a on top of b: a takes the spot, b moves down.
  const after = placeTile(start, 'a', tile(6, 0, 6, 2), 12);
  assert.deepEqual(after.a, tile(6, 0, 6, 2));
  assert.equal(after.b.row, 2);
  // A drag beyond the right edge is clamped rather than refused.
  assert.deepEqual(placeTile(start, 'a', tile(99, 0, 6, 2), 12).a, tile(6, 0, 6, 2));
  // A name that is not in the map is not invented.
  assert.equal(placeTile(start, 'nope', tile(0, 0, 1, 1), 12), start);
}

// ---- parameter coercion ----------------------------------------------------
assert.equal(layoutColumns('12'), 12);
assert.equal(layoutColumns(''), DEFAULT_COLUMNS);
assert.equal(layoutColumns('0'), 1);
assert.equal(layoutColumns('9999'), MAX_COLUMNS);
assert.equal(layoutRowHeight('60'), DEFAULT_ROW_HEIGHT);
assert.equal(layoutRowHeight('nonsense'), DEFAULT_ROW_HEIGHT);
assert.equal(rowsUsed({ a: tile(0, 0, 1, 3), b: tile(1, 1, 1, 1) }), 3);

// ---- the .grc is the storage medium ----------------------------------------
// The spec is JSON inside a YAML scalar, which is the one place it could be
// quietly mangled: `{`, `"` and `,` all mean something to YAML, and the runner
// has its own parser rather than a full YAML library.
{
  const grcOut = join(tmpdir(), `gui-layout-grc-${process.pid}.mjs`);
  await build({
    entryPoints: [new URL('../src/grc.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', outfile: grcOut, logLevel: 'silent',
  });
  const { dumpGrc, parseGrc } = await import(pathToFileURL(grcOut));
  const spec = serializeTiles({ scope: tile(0, 0, 6, 4), 'freq_ctl': tile(6, 0, 6, 1) });
  const text = dumpGrc({
    options: { parameters: { id: 'x' }, states: { coordinate: [10, 10] } },
    blocks: [{ name: 'gui', id: 'wasm_gui_layout',
               parameters: { columns: '12', layout: spec, row_height: '60' },
               states: { coordinate: [10, 120], rotation: 0, state: 'enabled' } }],
    connections: [], metadata: { file_format: 1 },
  });
  // Quoted, or YAML reads the leading `{` as a flow mapping.
  assert.match(text, /layout: '\{"freq_ctl":\[6,0,6,1\],"scope":\[0,0,6,4\]\}'/);
  const reparsed = parseGrc(text).blocks[0].parameters.layout;
  assert.equal(reparsed, spec, 'the spec survives the YAML round trip');
  assert.deepEqual(parseTiles(reparsed), parseTiles(spec));
}

// ---- the block definition, and the runner that renders it ------------------
const world = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, world), 'utf8');
const [blockYaml, runnerHpp, runnerCpp, registryCpp, runnerHtml, blocksJson] =
  await Promise.all([
    read('blocks/grc/wasm_gui_layout.block.yml'),
    read('runner/src/gui_layout.hpp'),
    read('runner/src/runner.cpp'),
    read('runner/src/registry.cpp'),
    read('runner/src/runner.html'),
    read('editor/public/blocks.json'),
  ]);

// The parameter ids the editor writes have to be the ones the factory reads.
for (const param of ['layout', 'columns', 'row_height']) {
  assert.match(blockYaml, new RegExp(`id: ${param}\\b`), `${param} is declared`);
  assert.match(registryCpp, new RegExp(`"${param}"`), `the factory reads ${param}`);
}
// The two ends of the spec agree on its defaults, or a flowgraph would be laid
// out one way in the preview and another in the window.
assert.match(runnerHpp, new RegExp(`kDefaultColumns = ${DEFAULT_COLUMNS}\\b`));
assert.match(runnerHpp, new RegExp(`kDefaultRowHeight = ${DEFAULT_ROW_HEIGHT}\\b`));
assert.match(runnerHpp, new RegExp(`kMaxColumns = ${MAX_COLUMNS}\\b`));
// The default size of a widget nobody has placed, which both ends compute for
// themselves: the editor to draw the preview, the runner to lay out the window.
// If these drift, an unarranged flowgraph is previewed as something other than
// what it runs as -- and nothing else would ever say so.
assert.match(runnerHpp, new RegExp(`kControlRows = ${CONTROL_ROWS}\\b`));
assert.match(runnerHpp, new RegExp(`kSinkRows = ${SINK_ROWS}\\b`));
assert.match(runnerCpp, /is_variable_control\(placed\.id\) \? gui_layout::kControlRows/,
             'the runner sizes an unplaced control the way the editor does');

// It is a runtime object, not a scheduler block: run_now() must skip it the way
// it skips a constellation, or the graph tries to connect something that is not
// a gr::block.
assert.match(runnerCpp, /id == "wasm_gui_layout"/);
// The hand-written factory table is what declares this id custom -- gen_registry.py
// reads the set back out of it, so the entry below is the only place it is said.
assert.match(registryCpp, /\{"wasm_gui_layout", \[\]\(const json&/,
             'registry.cpp registers the hand-written factory');

// The live-Arrange round trip: the editor posts gr-set-layout down and the
// runner posts gr-widgets back. Both names appear on both sides, or a drag
// silently does nothing.
assert.match(source, /'gr-set-layout'/, 'the editor sends the spec');
assert.match(runnerHtml, /'gr-set-layout'/, 'the runner listens for it');
assert.match(runnerHtml, /gr_apply_gui_layout/, 'and applies it without restarting');
assert.match(runnerCpp, /gr_apply_gui_layout/);
assert.match(runnerCpp, /'gr-widgets'/, 'the runner reports its widgets');
assert.match(source, /'gr-widgets'/, 'the editor listens for that report');
// The export list is separate from the C++ definition, and a missing entry is a
// runtime failure in the browser rather than a link error.
assert.match(await read('runner/CMakeLists.txt'), /_gr_apply_gui_layout/);

// ---- the singleton contract ------------------------------------------------
// Auto-inserted, like Options, so every flowgraph is arrangeable without anyone
// knowing the block exists -- and undeletable, so it stays that way.
assert.match(source, /function ensureLayoutBlock\(\)/);
assert.match(source, /i\.id === OPTIONS_ID \|\| i\.id === LAYOUT_ID/,
             'delete keeps both singletons');
assert.match(html, /id="btnArrange"/, 'the Arrange button is in the run bar');
assert.match(html, /id="arrangeOverlay"/);

// ---- the gui flag the designer depends on ----------------------------------
{
  const blocks = JSON.parse(blocksJson).blocks;
  const byId = new Map(blocks.map(b => [b.id, b]));
  // Every block whose factory builds a QWidget is flagged, because that flag is
  // the editor's only way of knowing which blocks need a tile.
  for (const id of ['qtgui_time_sink_x', 'qtgui_freq_sink_x', 'qtgui_waterfall_sink_x',
                    'qtgui_const_sink_x', 'qtgui_number_sink', 'variable_qtgui_range',
                    'variable_qtgui_chooser', 'fosphor_qt_sink_c'])
    assert.equal(byId.get(id)?.gui, true, `${id} is flagged as a GUI widget`);
  // And nothing else is: a block with no widget must not appear in the designer.
  for (const id of ['blocks_throttle2', 'analog_sig_source_x', 'wasm_text_sink',
                    'wasm_gui_layout'])
    assert.equal(byId.get(id)?.gui, false, `${id} is not a GUI widget`);
  // The layout block itself has to be runnable, or every flowgraph fails to run
  // the moment it is auto-inserted.
  assert.equal(byId.get('wasm_gui_layout')?.runnable, true);
}

console.log('gui-layout tests passed');
