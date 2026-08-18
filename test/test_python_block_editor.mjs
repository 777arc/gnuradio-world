// The Embedded Python Block in the *editor*: the half test_python_block.mjs
// cannot see.
//
//   node test/test_python_block_editor.mjs [port]
//
// The runner is fed a .grc and derives everything from live Python. The editor
// instead derives a block's parameters and ports from its source by hand, through
// the same Pyodide worker, and rebuilds its schema, its ports and its .grc from
// the answer. Nothing in the headless harnesses exercises that path, and it is
// the one where a mistake is silent: a Python Block whose editor-side ports do
// not match its code produces a flowgraph that is wired one way and built
// another.
//
// So: place a Python Block, edit its code to change its ports and parameters,
// press the button that re-reads it, and check the canvas and the saved .grc
// followed. Needs the vendored Pyodide (deps/fetch-pyodide.sh) and a built
// editor; skips with a message if either is missing.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import {
  contentType,
  launchBrowser,
  setIsolationHeaders,
  suppressEditorWelcome,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8104);

for (const [path, hint] of [
  ['pyodide/pyodide.mjs', 'run `bash deps/fetch-pyodide.sh`'],
  ['editor/dist/index.html', 'run `npm run build` in editor/'],
  ['runner/build/pyodide/gr_pyodide_worker.js', 'build the runner'],
]) {
  if (!await stat(join(ROOT, path)).catch(() => null)) {
    console.log(`SKIP: missing ${path} -- ${hint}`);
    process.exit(0);
  }
}

const server = http.createServer(async (req, res) => {
  setIsolationHeaders(res);
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/example_flowgraphs' || p === '/example_flowgraphs/') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end('[]');
    }
    // Make startup ordering deterministic: palette construction must finish
    // first, while the bootstrap gate still prevents it from being used.
    if (p === '/example_flowgraphs/digital/welcome_example.grc')
      await new Promise(resolve => setTimeout(resolve, 250));
    if (p.endsWith('/')) p += 'index.html';
    const direct = normalize(join(ROOT, p));
    if (!direct.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    // Same fallback as server.mjs: the editor is served from the site root.
    const fp = await stat(direct).then(s => s.isFile()).catch(() => false)
      ? direct : normalize(join(ROOT, 'editor', 'dist', p));
    const body = await readFile(fp);
    res.setHeader('Content-Type', contentType(fp));
    res.writeHead(200);
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, r));

// A block with two inputs, one output and two parameters -- none of which the
// default source has, so every derived thing has to change for this to pass.
const EDITED_SOURCE = `import numpy as np
from gnuradio import gr


class blk(gr.sync_block):
    """Weighted sum of two streams"""

    def __init__(self, left=1.0, right=0.5):
        gr.sync_block.__init__(
            self,
            name='Weighted Sum',
            in_sig=[np.float32, np.float32],
            out_sig=[np.float32])
        self.left = left
        self.right = right

    def work(self, input_items, output_items):
        output_items[0][:] = self.left * input_items[0] + self.right * input_items[1]
        return len(output_items[0])
`;


// The editor gives blocks no DOM identity, so every probe goes through this: the
// Python Block is the *selected* one -- placing it selects it, and the dialog's
// Apply re-selects it -- and its ports are read off their labels ("in0"/"out"),
// which is how a user tells them apart too. The starting flowgraph's blocks are
// on the canvas as well, hence not simply taking the first one.
const PROBE = `(() => {
  const block = document.querySelector('#nodes .blk.sel');
  if (!block) return null;
  const labels = [...block.querySelectorAll('text.port-label')].map(t => t.textContent.trim());
  return {
    title: block.querySelector('text.title')?.textContent || '',
    invalid: block.classList.contains('invalid'),
    ports: labels,
    inputs: labels.filter(l => l.startsWith('in')).length,
    outputs: labels.filter(l => l.startsWith('out')).length,
    rows: [...block.querySelectorAll('text.param')].map(t => t.textContent.trim()),
  };
})()`;
const probe = () => page.evaluate(PROBE);

// Open the Python Block's Properties dialog with two real clicks. It has to be
// real mouse input: select()/drag rebuild a block's DOM node on every press, so
// the editor does its own double-press detection on pointerdown (see startDrag in
// main.ts) and a synthetic 'dblclick' reaches nothing.
const openProperties = async () => {
  const handle = await page.$('#nodes .blk.sel');
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2, y = box.y + 10;
  await page.mouse.click(x, y);
  await page.mouse.click(x, y);
  await page.waitForSelector('.modal.props textarea.code-editor', { timeout: 15000 });
  // CodeMirror is mounted over that textarea from a chunk of its own, so the
  // dialog exists for a moment without it. Everything below still drives the
  // textarea -- it stays the field's value, and the two are mirrored.
  await page.waitForSelector('.modal.props .code-cm .cm-content', { timeout: 15000 });
};

const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(what);
};

const browser = await launchBrowser(ROOT);
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
await page.setViewport({ width: 1400, height: 900 });
await suppressEditorWelcome(page);
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
// Palette rows are built before the asynchronous default flowgraph arrives.
// Wait for bootstrap's shared readiness boundary so that load cannot replace a
// block placed by the test (or by a fast user) immediately afterward.
await page.waitForFunction(() =>
  !document.documentElement.classList.contains('app-bootstrapping'), { timeout: 30000 });

// Place a Python Block by clicking its palette entry, the way a user does.
const placed = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.pal-item')]
    .find(node => node.textContent.trim() === 'Python Block');
  if (!item) return 'no palette entry';
  if (item.classList.contains('unavailable')) return 'palette entry is greyed out';
  item.click();
  return '';
});
check(placed === '', 'the palette offers a runnable Python Block', placed);

// Straight from the palette it must already have the default source's ports, with
// no Python runtime fetched -- that is what the _io_cache default in
// blocks/grc/epy_block.block.yml is for.
const initial = await probe();
check(initial?.title === 'Embedded Python Block', 'the block face shows the class label',
      JSON.stringify(initial));
check(initial?.inputs === 1 && initial?.outputs === 1,
      'the default source\'s ports are drawn before Python is loaded',
      JSON.stringify(initial));

// Open Properties and confirm the Code field is a code editor, not a text input.
await openProperties();
const dialog = await page.evaluate(() => {
  const area = document.querySelector('.modal.props textarea.code-editor');
  const content = document.querySelector('.modal.props .code-cm .cm-content');
  return {
    monospace: /mono/i.test(getComputedStyle(content).fontFamily),
    hasDefaultCode: area.value.includes('class blk(gr.sync_block)'),
    // CodeMirror shows the same source, and shows it as Python: `class` and
    // `def` are keywords, so the parser ran and the highlight style applied.
    shown: content.textContent.includes('class blk(gr.sync_block)'),
    highlighted: [...content.querySelectorAll('span')]
      .some(span => span.textContent === 'class' && getComputedStyle(span).color !==
            getComputedStyle(content).color),
    gutter: !!document.querySelector('.modal.props .code-cm .cm-lineNumbers'),
    // The plain textarea is the value, but only one of the two is on screen.
    areaHidden: getComputedStyle(area).display === 'none',
    wide: document.querySelector('.modal.props .dlg-code') !== null,
    reload: document.querySelector('.code-reload')?.textContent || '',
    // The interface cache is bookkeeping; it must not be an editable field.
    cacheField: [...document.querySelectorAll('.modal.props .dlgrow label')]
      .some(label => label.textContent.includes('IO Cache')),
  };
});
check(dialog.monospace, 'the Code field is monospace');
check(dialog.hasDefaultCode, 'the Code field holds the default block source');
check(dialog.shown, 'CodeMirror shows that source');
check(dialog.highlighted, 'the source is highlighted as Python');
check(dialog.gutter, 'the code editor has line numbers');
check(dialog.areaHidden, 'the mirrored textarea is not drawn under the editor');
check(dialog.wide, 'a Python Block gets the wide dialog');
check(/Load Python/.test(dialog.reload), 'loading Python is offered, not automatic',
      dialog.reload);
check(!dialog.cacheField, 'the derived-interface cache has no field');

// Edit the code. Until it is re-read, Apply and OK must be refused: committing
// would leave the block's ports describing the previous source.
await page.evaluate(source => {
  const area = document.querySelector('.modal.props textarea.code-editor');
  area.value = source;
  area.dispatchEvent(new Event('input', { bubbles: true }));
}, EDITED_SOURCE);
const pending = await page.evaluate(() => ({
  ok: [...document.querySelectorAll('.dlgfoot button')].find(b => b.textContent === 'OK')?.disabled,
  apply: [...document.querySelectorAll('.dlgfoot button')].find(b => b.textContent === 'Apply')?.disabled,
  status: document.querySelector('.code-status')?.textContent || '',
  mirrored: (document.querySelector('.modal.props .code-cm .cm-content')?.textContent || '')
    .includes('Weighted sum of two streams'),
}));
check(pending.mirrored, 'a source set on the textarea reaches the code editor');
check(pending.ok === true && pending.apply === true,
      'edited code cannot be applied until it is read', JSON.stringify(pending));
check(/code has changed/i.test(pending.status), 'the field says why', pending.status);

// Now read it. This is the download, so allow real time for it.
await page.evaluate(() => document.querySelector('.code-reload').click());
await page.waitForFunction(
  `(${PROBE})?.inputs === 2`, { timeout: 180000, polling: 250 });

const after = await probe();
after.fields = await page.evaluate(() =>
  [...document.querySelectorAll('.modal.props .dlgrow label')]
    .map(label => label.textContent.trim()));
check(after.title === 'Weighted Sum', 'the label follows the block\'s name()', after.title);
check(after.inputs === 2 && after.outputs === 1, 'the ports follow in_sig/out_sig',
      JSON.stringify([after.inputs, after.outputs]));
check(after.rows.some(row => row.includes('Left')) && after.rows.some(row => row.includes('Right')),
      'the derived parameters appear on the block face', JSON.stringify(after.rows));
check(after.fields.some(f => f.startsWith('Left')) && after.fields.some(f => f.startsWith('Right')),
      'the dialog reopened on the new parameters', JSON.stringify(after.fields));

// Commit, so the next case starts from the edited block. (The .grc round trip of
// the source and its cache is covered by editor/test/epy-block.test.mjs, which
// can read the writer's output directly.)
await page.evaluate(() => [...document.querySelectorAll('.dlgfoot button')]
  .find(b => b.textContent === 'OK')?.click());

// A broken source must redden the block rather than fail silently.
await openProperties();
await page.evaluate(() => {
  const area = document.querySelector('.modal.props textarea.code-editor');
  area.value = 'this is not python(';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.code-reload').click();
});
await page.waitForFunction(() => /error|Error/.test(
  document.querySelector('.code-status')?.className + ' ' +
  (document.querySelector('.code-status')?.textContent || '')), { timeout: 60000, polling: 200 });
const broken = await page.evaluate(() => ({
  status: document.querySelector('.code-status')?.textContent || '',
  flagged: document.querySelector('.code-status')?.classList.contains('code-error') || false,
}));
check(broken.flagged && /error|invalid|syntax/i.test(broken.status),
      'a source that will not compile is reported in the field', broken.status);

await browser.close();
server.close();
if (failures.length) {
  console.log('\n   page logs: ' + logs.slice(-15).join('\n              '));
  console.log(`\nPYTHON_BLOCK_EDITOR_FAIL (${failures.length})`);
  process.exit(1);
}
console.log('\nPYTHON_BLOCK_EDITOR_PASS');
