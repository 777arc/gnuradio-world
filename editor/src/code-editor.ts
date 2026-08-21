// CodeMirror for a Code field — the Embedded Python Block's, and the JavaScript
// Block's.
//
// The field stays a <textarea>: it is what the Properties dialog builds, what
// holds the value, and what everything downstream (`tmp.params`, the validation
// node, the browser test) reads and writes. CodeMirror is mounted *over* it and
// the two are mirrored — the same arrangement CodeMirror 5's `fromTextArea`
// offered and CodeMirror 6 dropped. Two things fall out of it that are worth the
// mirroring:
//
//   * CodeMirror is loaded on demand. It is a few hundred kB, a Code field is
//     the only place in the editor that wants one, and until the chunk arrives —
//     or if it never does — the textarea is a working editor rather than an empty
//     box. Nothing is fetched by a session that never opens a Python or JS Block.
//   * Nothing in main.ts has to know CodeMirror exists.
//
// Everything here is dynamically imported for that reason; keep it that way, and
// keep this module out of any import chain main.ts evaluates eagerly.

/** Which language mode to mount. The field's dtype chooses it, not this module. */
export type CodeLanguage = 'python' | 'javascript';

/** A mounted editor. `destroy()` puts the plain textarea back. */
export interface CodeEditorHandle {
  destroy(): void;
}

// Matches the dialog's own palette (see .dlgrow input in editor.css) rather than
// bringing in a stock CodeMirror theme, so the field looks like the rest of the
// form it sits in.
const COLORS = {
  background: '#171a24',
  foreground: '#e6e9f0',
  gutter: '#141824',
  gutterText: '#6b7699',
  activeLine: '#1c2132',
  selection: '#2b3557',
  cursor: '#8ab4ff',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  number: '#79c0ff',
  comment: '#8b949e',
  definition: '#d2a8ff',
  type: '#ffa657',
  property: '#79c0ff',
};

/**
 * Upgrade a Code textarea to CodeMirror, mirroring the two.
 *
 * Resolves to null when the chunk cannot be loaded, leaving the textarea alone —
 * a missing code editor is not worth failing a Properties dialog over.
 */
export async function mountCodeEditor(
  area: HTMLTextAreaElement,
  language: CodeLanguage = 'python',
): Promise<CodeEditorHandle | null> {
  let modules;
  try {
    modules = await Promise.all([
      import('codemirror'),
      import('@codemirror/view'),
      import('@codemirror/state'),
      import('@codemirror/language'),
      import('@codemirror/commands'),
      // Both modes are separate chunks; only the one the field asked for is
      // fetched, so a session that never opens a JS Block never pays for it.
      language === 'javascript' ? import('@codemirror/lang-javascript')
                                : import('@codemirror/lang-python'),
      import('@lezer/highlight'),
    ]);
  } catch {
    return null;
  }
  // The dialog can be closed while the chunk is in flight.
  if (!area.isConnected) return null;

  const [
    { basicSetup },
    { EditorView, keymap },
    { EditorState },
    { HighlightStyle, indentUnit, syntaxHighlighting },
    { indentWithTab },
    languageModule,
    { tags },
  ] = modules as any[];
  const languageSupport = language === 'javascript'
    ? languageModule.javascript() : languageModule.python();
  // Four spaces for Python, as PEP 8 and every GRC Python Block template use;
  // two for JavaScript, which is what the shipped JS blocks are written in.
  const indent = language === 'javascript' ? '  ' : '    ';

  const theme = EditorView.theme({
    // No height here: the box is sized by .code-cm in editor.css, and CodeMirror
    // scrolls inside whatever height its own element is given.
    '&': { color: COLORS.foreground, backgroundColor: COLORS.background,
           fontSize: '14px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
                     padding: '8px 0', caretColor: COLORS.cursor },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.45' },
    '.cm-gutters': { backgroundColor: COLORS.gutter, color: COLORS.gutterText,
                     border: 'none' },
    '.cm-activeLine': { backgroundColor: COLORS.activeLine },
    '.cm-activeLineGutter': { backgroundColor: COLORS.activeLine,
                              color: COLORS.foreground },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: COLORS.cursor },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
      { backgroundColor: COLORS.selection },
    '.cm-selectionMatch': { backgroundColor: '#2b355788' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket':
      { backgroundColor: '#3a4366', outline: 'none' },
    '.cm-tooltip': { backgroundColor: '#1f2434', border: '1px solid #3a4366',
                     color: COLORS.foreground },
    '.cm-tooltip-autocomplete ul li[aria-selected]':
      { backgroundColor: '#2b3557', color: COLORS.foreground },
    '.cm-panels': { backgroundColor: '#1f2434', color: COLORS.foreground },
    '.cm-panels input, .cm-panels button': { backgroundColor: COLORS.background,
                                             color: COLORS.foreground,
                                             border: '1px solid #3a4366' },
  }, { dark: true });

  const highlight = HighlightStyle.define([
    { tag: [tags.keyword, tags.moduleKeyword, tags.operatorKeyword,
            tags.controlKeyword, tags.self, tags.null, tags.bool],
      color: COLORS.keyword },
    { tag: [tags.string, tags.special(tags.string), tags.docString],
      color: COLORS.string },
    { tag: [tags.number, tags.atom], color: COLORS.number },
    { tag: [tags.comment, tags.lineComment, tags.blockComment],
      color: COLORS.comment, fontStyle: 'italic' },
    { tag: [tags.function(tags.variableName), tags.function(tags.definition(tags.variableName))],
      color: COLORS.definition },
    { tag: [tags.className, tags.typeName, tags.standard(tags.variableName)],
      color: COLORS.type },
    { tag: [tags.propertyName, tags.attributeName], color: COLORS.property },
    { tag: [tags.operator, tags.punctuation, tags.bracket], color: '#a7b0cc' },
    { tag: tags.invalid, color: '#ff7b72' },
  ]);

  // `syncing` is what keeps the mirror from echoing: whichever side started an
  // edit does not get told about its own change coming back.
  let syncing = false;

  // CodeMirror -> textarea. The `input` event is how the dialog hears about an
  // edit (main.ts assigns area.oninput), so a change made here has to raise one
  // exactly as typing into the textarea would.
  const push = () => {
    const text = view.state.doc.toString();
    if (area.value === text) return;
    area.value = text;
    if (syncing) return;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // textarea -> CodeMirror, for a value set from outside (the browser test does
  // exactly this, and so would anything that pastes a source in).
  const pull = () => {
    if (syncing || area.value === view.state.doc.toString()) return;
    syncing = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: area.value } });
    syncing = false;
  };

  const view = new EditorView({
    state: EditorState.create({
      doc: area.value,
      extensions: [
        basicSetup,
        languageSupport,
        // Tab indents rather than leaving the field, which is what the textarea
        // it replaces did; Escape first, then Tab, still moves focus on.
        indentUnit.of(indent),
        keymap.of([indentWithTab]),
        theme,
        syntaxHighlighting(highlight),
        EditorView.updateListener.of((update: any) => { if (update.docChanged) push(); }),
        // CodeMirror owns the editor element's class attribute and rewrites it
        // whenever the theme changes, so the hook editor.css styles the box
        // through has to be declared as an extension rather than added by hand.
        EditorView.editorAttributes.of({ class: 'code-cm' }),
      ],
    }),
  });

  area.insertAdjacentElement('beforebegin', view.dom);
  const hadFocus = document.activeElement === area;
  area.hidden = true;
  area.addEventListener('input', pull);
  if (hadFocus) view.focus();

  return {
    destroy() {
      area.removeEventListener('input', pull);
      view.destroy();
      area.hidden = false;
    },
  };
}
