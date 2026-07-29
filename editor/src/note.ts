// Text layout for GRC's Note block: a canvas annotation whose text *is* the
// block's body. A normal parameter row is one truncated line ("Note: some very
// long comm…"), which defeats the point of writing a note, so the note is laid
// out as wrapped lines and the block grows to fit all of them.
//
// Kept DOM-free (the caller supplies the text measurer) so it can be unit-tested
// under node — see editor/test/note.test.mjs.

// Widest run of note text, in px, before a line wraps. Roughly 45 characters at
// the 11px block-parameter font: wide enough for a sentence, narrow enough that
// a note doesn't crowd the flowgraph it annotates.
export const NOTE_MAX_TEXT_W = 260;
// Matches `.blk text.param` in index.html, so the measured width is the drawn width.
export const NOTE_FONT_SIZE = 11;

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
