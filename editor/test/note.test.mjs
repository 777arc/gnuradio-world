// The Note block: canvas annotation with no GNU Radio block behind it. Covers
// the text wrapping (editor/src/note.ts, DOM-free by design) plus the editor and
// runner wiring that make the block placeable and harmless at run time.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

// ---- wrapping (note.ts is TypeScript; bundle it, same as grid.test.mjs) ----
const out = join(tmpdir(), `note-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/note.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const { wrapNoteText, NOTE_MAX_TEXT_W, NOTE_DEFAULT_BG, normalizeNoteColor,
        isDarkNoteColor } = await import(pathToFileURL(out));

// A stand-in for the canvas text metrics: every glyph is 6px wide.
const GLYPH = 6;
const measure = text => text.length * GLYPH;
const wrap = (text, maxWidth = 60) => wrapNoteText(text, measure, maxWidth);

assert.deepEqual(wrap('short'), ['short'], 'text that fits stays on one line');
// 60px fits ten glyphs, so each line takes as many whole words as reach that.
assert.deepEqual(wrap('aaa bbb ccc ddd eee'), ['aaa bbb', 'ccc ddd', 'eee'],
  'text wider than the column wraps at word boundaries');
assert.deepEqual(wrap('one\ntwo'), ['one', 'two'], 'explicit newlines start a new line');
assert.deepEqual(wrap('one\n\ntwo'), ['one', '', 'two'], 'blank lines are preserved');
assert.deepEqual(wrap('aaaaaaaaaaaaaaaaaaaa'), ['aaaaaaaaaa', 'aaaaaaaaaa'],
  'a word wider than the column is broken so it cannot overflow the block');
assert.deepEqual(wrap('ab   cd'), ['ab cd'], 'runs of whitespace collapse to one space');
for (const line of wrap('the quick brown fox jumps over the lazy dog', 60))
  assert.ok(measure(line) <= 60, `wrapped line "${line}" must fit the column`);
assert.ok(NOTE_MAX_TEXT_W > 0, 'the note column must have a width');

// ---- background colour (browser-only; native GRC's Note has no such field) ----
assert.equal(normalizeNoteColor('#AABBCC'), '#aabbcc', 'a full hex is canonicalized');
assert.equal(normalizeNoteColor(' #abc '), '#aabbcc', 'the short hex expands to the same colour');
for (const bad of ['', 'red', '#12', '#gggggg', 'rgb(1,2,3)', undefined, null])
  assert.equal(normalizeNoteColor(bad), '',
    `"${bad}" must read as no tint rather than as an error -- a note is an annotation`);
assert.equal(normalizeNoteColor(NOTE_DEFAULT_BG), NOTE_DEFAULT_BG,
  'the default fill must itself be a colour the picker can open on');
assert.ok(isDarkNoteColor('#102040') && isDarkNoteColor('#000000'),
  'a dark fill must ask the canvas for light text');
assert.ok(!isDarkNoteColor('#ffff88') && !isDarkNoteColor(NOTE_DEFAULT_BG) && !isDarkNoteColor(''),
  'a light or unset fill must keep the black body text');

assert.match(source, /id: NOTE_BG_PARAM[^}]*color: true/,
  "the Note block's background must be a colour param");
assert.match(html, /\.blk\.note-tinted rect\.body \{ fill:var\(--note-bg\); \}/,
  'the tint must reach the block face through --note-bg');
assert.match(source, /g\.style\.setProperty\('--note-bg', tint\)/,
  'the canvas must set --note-bg per block');
assert.match(source, /export function colorField\(/,
  'a colour param must get the browser colour picker, not a bare text field');
assert.match(source, /if \(inst\.id !== NOTE_ID \|\| normalizeNoteColor\(params\[NOTE_BG_PARAM\]\)\) return params;/,
  'an unset note colour must stay out of the .grc, so existing files are unchanged');
assert.match(html, /\.color-field \{/, 'the colour field must be styled');

// ---- editor wiring ----
assert.match(source, /\n\s*note:\s*{[\s\S]*?label: 'Note'/,
  'the Note block must be registered as a hand-written schema (that is what makes it placeable)');
assert.match(source, /id: 'note'[^}]*multiline: true/,
  "the Note block's text must be a multiline param");
assert.match(source, /if \(inst\.id === NOTE_ID\) return noteGeom\(inst, d\)/,
  'the Note block must use its own geometry, not the one-row-per-param layout');
assert.match(source, /wrapNoteText\(text, s => textW\(s, NOTE_FONT_SIZE\)\)/,
  'note text must be wrapped against the same metrics it is drawn with');
assert.match(source,
  /w: ceilToGrid\([\s\S]*?Math\.max\(BLOCK_MIN_W,[\s\S]*?SNAP_GRID_SIZE \* 2\)/,
  'the Note block width must span an even number of grid tiles');
assert.match(source, /document\.createElement\(p\.multiline \? 'textarea' : 'input'\)/,
  'multiline params must be edited in a textarea so notes can hold line breaks');
assert.match(html, /\.dlgrow textarea/, 'the properties textarea must be styled');

// ---- runner wiring: a note never reaches the block factory registry ----
const lower = await readFile(
  new URL('../../runner/src/grc_lower.hpp', import.meta.url), 'utf8');
assert.match(lower, /id == "options" \|\| id == "variable" \|\| id == "note"/,
  'lowering must drop note blocks like options and variables');

console.log('checked Note block wrapping, editor schema and runner lowering');
