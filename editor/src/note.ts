// Text layout for GRC's Note block: a canvas annotation whose text *is* the
// block's body. A normal parameter row is one truncated line ("Note: some very
// long comm…"), which defeats the point of writing a note, so the note is laid
// out as wrapped lines and the block grows to fit all of them.
//
// Kept DOM-free (the caller supplies the text measurer) so it can be unit-tested
// under node — see editor/test/note.test.mjs.

// Widest run of note text, in px, before a line wraps. Roughly 45 characters at
// the 16px block-parameter font: wide enough for a sentence, narrow enough that
// a note doesn't crowd the flowgraph it annotates.
export const NOTE_MAX_TEXT_W = 380;
// Matches `.blk text.param` in editor.css, so the measured width is the drawn width.
export const NOTE_FONT_SIZE = 16;

// Measures a string's rendered width in px at NOTE_FONT_SIZE.
export type Measure = (text: string) => number;

// Break a single word that is wider than the column at the last character that
// still fits, so a long URL or identifier can never overflow the block.
function splitLongWord(word: string, measure: Measure, maxWidth: number): string[] {
  if (measure(word) <= maxWidth) return [word];
  const parts: string[] = [];
  let chunk = '';
  for (const ch of word) {
    if (chunk && measure(chunk + ch) > maxWidth) { parts.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) parts.push(chunk);
  return parts;
}

// Greedy word wrap by measured width. Explicit newlines start a new line (and a
// blank line stays blank), so a note can be written as paragraphs.
export function wrapNoteText(text: string, measure: Measure,
                             maxWidth = NOTE_MAX_TEXT_W): string[] {
  const lines: string[] = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const raw of paragraph.split(/\s+/)) {
      if (!raw) continue;
      for (const word of splitLongWord(raw, measure, maxWidth)) {
        const candidate = line ? line + ' ' + word : word;
        if (!line || measure(candidate) <= maxWidth) line = candidate;
        else { lines.push(line); line = word; }
      }
    }
    lines.push(line);
  }
  return lines;
}

// ---- background colour (browser-only; native GRC's Note has no such field) ----
//
// The Note block's id, shared by the geometry in main.ts and the tint in
// canvas-renderer.ts so neither has to spell it again.
export const NOTE_ID = 'note';
// The parameter holding the tint. Empty means "the block palette's own fill",
// which is also what every .grc written before this parameter existed says by
// saying nothing -- see grcParams' caller in main.ts, which keeps it out of the
// file while it is empty so those files stay byte-identical.
export const NOTE_BG_PARAM = 'bgcolor';
// `.blk rect.body` in editor.css: what an untinted block is filled with, and so
// what the colour picker should open on.
export const NOTE_DEFAULT_BG = '#f1ecff';

// Accept the two hex spellings a colour input or a hand-written .grc can hold
// and return one canonical `#rrggbb`; anything else (including empty) reads as
// "no tint" rather than as an error, because a note is an annotation and a
// mistyped colour must never make the flowgraph invalid.
export function normalizeNoteColor(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text))
    return '#' + [...text.slice(1)].map(c => c + c).join('');
  return '';
}

// Whether black body text would be hard to read on this fill, so the canvas can
// switch the note to light text. Rec. 601 luma, the same weighting a browser's
// own contrast heuristics use, against the midpoint of the range.
export function isDarkNoteColor(hex: string): boolean {
  const color = normalizeNoteColor(hex);
  if (!color) return false;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}
