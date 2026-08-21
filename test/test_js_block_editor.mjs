// The JavaScript Block in the *editor*: the half test_js_block.mjs cannot see.
//
//   node test/test_js_block_editor.mjs [port]
//
// The runner is fed a .grc and reads each block's descriptor for itself. The
// editor instead derives a block's parameters and ports from its source in a
// sandboxed iframe, and rebuilds its schema, its ports and its .grc from the
// answer — on a keystroke debounce, with no runtime to fetch and no button to
// press. Nothing else exercises that: editor/test/js-block.test.mjs covers the
// translation on plain Node, but the sandbox itself needs a browser.
//
// It is also the path where a mistake is silent, the same way it is for a Python
// Block: a JS Block whose editor-side ports do not match its code produces a
// flowgraph that is wired one way and built another.
//
// So: place a JS Block, retype its source to change its ports and parameters, and
// check the canvas followed *without* anything being clicked. Then check that a
// broken source reddens the block, and that the popup editor shows the derived
// interface. Needs a built editor and a built runner (the sandbox evaluates
// runner/build/js_runtime.js, so the editor and the runner cannot disagree).
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
const PORT = Number(process.argv[2] || 8106);

for (const [path, hint] of [
  ['editor/dist/index.html', 'run `npm run build` in editor/'],
  ['runner/build/js_runtime.js', 'build the runner'],
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

// Two inputs, one output, two parameters and a different label -- none of which
// the default source has, so every derived thing has to change for this to pass.
const EDITED_SOURCE = `gr.export({
  label: 'Weighted Sum',
  doc: 'Weighted sum of two streams',
  inputs: ['float', 'float'],
  outputs: ['float'],
  params: { left: 1.0, right: 0.5 },
  work(nout, input, output) {
    const a = input[0], b = input[1], y = output[0];
    for (let i = 0; i < nout; i++) y[i] = a[i] * this.left + b[i] * this.right;
    return nout;
  },
});
`;

// The editor gives blocks no DOM identity, so every probe goes through this: the
// JS Block is the *selected* one -- placing it selects it -- and its ports are
// read off their labels, which is how a user tells them apart too.
const PROBE = `(() => {
  const block = document.querySelector('#nodes .blk.sel');
  if (!block) return null;
  const labels = [...block.querySelectorAll('text.port-label')].map(t => t.textContent.trim());
  return {
    title: block.querySelector('text.title')?.textContent || '',
    subtitle: block.querySelector('text.subtitle')?.textContent || '',
    invalid: block.classList.contains('invalid'),
    ports: labels,
    inputs: labels.filter(l => l.startsWith('in')).length,
    outputs: labels.filter(l => l.startsWith('out')).length,
    rows: [...block.querySelectorAll('text.param')].map(t => t.textContent.trim()),
    errors: [...block.querySelectorAll('text.validation-error')].map(t => t.textContent.trim())
      .join(' '),
  };
})()`;
const probe = () => page.evaluate(PROBE);

// Two real clicks: select()/drag rebuild a block's DOM node on every press, so
// the editor does its own double-press detection on pointerdown (see startDrag in
// main.ts) and a synthetic 'dblclick' reaches nothing. On a JS Block this opens
// the popup code editor rather than Properties.
//
// The point is chosen by hit-testing rather than taken as the centre of the
// block's box: a freshly placed block can be drawn under the Options block on an
// otherwise empty canvas, and a click at its centre would then land on that one
// instead — silently opening the wrong dialog.
const doubleClickBlock = async () => {
  const point = await page.evaluate(() => {
    const block = document.querySelector('#nodes .blk.sel');
    if (!block) return null;
    const box = block.getBoundingClientRect();
    for (let x = box.left + 6; x < box.right - 6; x += 4)
      for (const y of [box.top + 8, box.top + 14]) {
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest('.blk') === block) return { x, y };
      }
    return null;
  });
  if (!point) throw new Error('the selected block is completely covered');
  await page.mouse.click(point.x, point.y);
  await page.mouse.click(point.x, point.y);
};

// The double-press window is 350 ms wide and the editor rebuilds the block's node
// between the two presses, so a press that lands during a re-render is dropped and
// the pair reads as two singles. Retry rather than fail: what is under test is the
// modal, not the input plumbing.
const openCodeModal = async () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    await doubleClickBlock();
    try {
      await page.waitForSelector('.modal.code-modal textarea.code-modal-area',
                                 { timeout: 8000 });
      return;
    } catch {
      // A missed pair may have opened Properties instead; close it and try again.
      await page.evaluate(() => document.querySelector('.modal.props .dlgclose')?.click());
    }
  }
  throw new Error('the code editor never opened');
};

const setSource = source => page.evaluate((text, selector) => {
  const area = document.querySelector(selector);
  area.value = text;
  area.dispatchEvent(new Event('input', { bubbles: true }));
}, source, '.modal.code-modal textarea.code-modal-area');

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
await page.waitForFunction(() =>
  !document.documentElement.classList.contains('app-bootstrapping'), { timeout: 30000 });

// ---- the palette ------------------------------------------------------------

const placed = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.pal-item')]
    .find(node => node.textContent.trim() === 'JS Block');
  if (!item) return 'no palette entry';
  if (item.classList.contains('unavailable')) return 'palette entry is greyed out';
  item.click();
  return '';
});
check(placed === '', 'the palette offers a runnable JS Block', placed);

// The three shipped repo blocks are palette entries like any other, with no
// relink and nothing fetched to make them so.
const repoBlocks = await page.evaluate(() => {
  const wanted = ['Complex Soft Clipper', 'Phase Unwrap', 'Peak Hold (decimating)'];
  const items = [...document.querySelectorAll('.pal-item')];
  return wanted.map(label => {
    const item = items.find(node => node.textContent.trim() === label);
    return [label, !item ? 'absent' : item.classList.contains('unavailable') ? 'greyed out' : 'ok'];
  });
});
check(repoBlocks.every(([, state]) => state === 'ok'),
      'the repo JavaScript blocks are placeable from the palette',
      JSON.stringify(repoBlocks));

// Straight from the palette it already has the default source's ports, because
// the `_js_io` default in blocks/grc/wasm_js_block.block.yml describes them --
// nothing has been evaluated yet.
const initial = await probe();
check(initial?.title === 'JS Block', 'the block face shows the descriptor label',
      JSON.stringify(initial));
check(initial?.subtitle === 'JavaScript', 'the face says which language its source is in',
      JSON.stringify(initial));
check(initial?.inputs === 1 && initial?.outputs === 1,
      "the default source's ports are drawn without evaluating anything",
      JSON.stringify(initial));

// ---- the popup editor, and ports following the code as it is typed ----------

await openCodeModal();
await page.waitForSelector('.modal.code-modal .code-cm .cm-content', { timeout: 15000 });
// The panel is filled by a real derivation in the sandbox, so wait for it.
await page.waitForFunction(
  () => (document.querySelector('.code-modal-label')?.textContent || '').trim() === 'JS Block',
  { timeout: 20000, polling: 100 });

const modal = await page.evaluate(() => {
  const content = document.querySelector('.modal.code-modal .code-cm .cm-content');
  const area = document.querySelector('.modal.code-modal textarea.code-modal-area');
  return {
    monospace: /mono/i.test(getComputedStyle(content).fontFamily),
    hasDefaultCode: area.value.includes('gr.export({'),
    shown: content.textContent.includes('gr.export({'),
    // CodeMirror parsed it as JavaScript: `const` is a keyword, so the highlight
    // style applied.
    highlighted: [...content.querySelectorAll('span')]
      .some(span => span.textContent === 'const' && getComputedStyle(span).color !==
            getComputedStyle(content).color),
    gutter: !!document.querySelector('.modal.code-modal .code-cm .cm-lineNumbers'),
    areaHidden: getComputedStyle(area).display === 'none',
    ports: document.querySelector('.code-modal-ports')?.textContent || '',
    params: document.querySelector('.code-modal-params')?.textContent || '',
    notes: document.querySelector('.code-modal-notes')?.textContent || '',
    // No re-read button anywhere: derivation is automatic here.
    reread: [...document.querySelectorAll('.modal.code-modal button')]
      .map(b => b.textContent.trim()),
  };
});
check(modal.monospace && modal.gutter && modal.areaHidden && modal.shown,
      'double-clicking a JS Block opens a mounted code editor', JSON.stringify(modal));
check(modal.highlighted, 'the source is highlighted as JavaScript');
check(/in: complex.*out: complex/.test(modal.ports),
      'the live panel names the derived ports', modal.ports);
check(/gain/.test(modal.params) && /live/.test(modal.params),
      'and its parameters, marking the ones a Range can drive', modal.params);
check(/start\(\)/.test(modal.notes), 'and the optional hooks it defines', modal.notes);
check(!modal.reread.some(label => /read/i.test(label)),
      'nothing has to be pressed to read the code', JSON.stringify(modal.reread));

// Retype the source. Nothing is clicked: the ports must follow on their own.
await setSource(EDITED_SOURCE);
await page.waitForFunction(`(${PROBE})?.inputs === 2`, { timeout: 20000, polling: 100 });

const after = await probe();
const panel = await page.evaluate(() => ({
  label: document.querySelector('.code-modal-label')?.textContent || '',
  ports: document.querySelector('.code-modal-ports')?.textContent || '',
  params: document.querySelector('.code-modal-params')?.textContent || '',
}));
check(after.title === 'Weighted Sum', "the label follows the descriptor's label", after.title);
check(after.inputs === 2 && after.outputs === 1,
      'the ports follow the code as it is typed, with nothing pressed',
      JSON.stringify([after.inputs, after.outputs]));
check(after.rows.some(row => row.includes('Left')) && after.rows.some(row => row.includes('Right')),
      'the derived parameters appear on the block face', JSON.stringify(after.rows));
check(panel.label === 'Weighted Sum' && /in: float, float/.test(panel.ports),
      'and the live panel agrees with them', JSON.stringify(panel));

// A broken source must say so, and redden the block rather than fail silently.
await setSource('gr.export({ inputs: ["nonsense"], outputs: [], work() {} });');
await page.waitForFunction(
  () => !document.querySelector('.code-modal-error')?.hidden,
  { timeout: 20000, polling: 100 });
const broken = await page.evaluate(() => ({
  message: document.querySelector('.code-modal-error')?.textContent || '',
  flagged: document.querySelector('.code-modal-panel')?.classList.contains('has-error') || false,
}));
check(broken.flagged && /unknown port type/i.test(broken.message),
      'a descriptor the runtime rejects is reported, in its own words', broken.message);
// The block keeps the last interface that *did* read, rather than losing its
// ports and its connections to a half-typed line -- the same thing a Python
// Block does with a source it could not read. The block face carries the error
// too, but not checkably here: this block has three unconnected ports, and the
// face shows only the first five wrapped lines of a block's issues.
check((await probe())?.inputs === 2,
      'and the last interface that did read still stands, ports and all');

// A source that never registers itself gets a real error, not a mystery.
await setSource('const x = 1;');
await page.waitForFunction(
  () => /gr\.export/.test(document.querySelector('.code-modal-error')?.textContent || ''),
  { timeout: 20000, polling: 100 });
check(true, 'a source that never calls gr.export() is told so');

// Save & Close puts the last good source back and commits it.
await setSource(EDITED_SOURCE);
await page.waitForFunction(
  () => document.querySelector('.code-modal-error')?.hidden === true,
  { timeout: 20000, polling: 100 });
await page.evaluate(() => [...document.querySelectorAll('.modal.code-modal .dlgfoot button')]
  .find(b => b.textContent === 'Save & Close')?.click());
await page.waitForFunction(() => !document.querySelector('.modal.code-modal'),
                           { timeout: 10000 });

// The committed block. It is still invalid -- nothing is connected to it -- but
// the source error is gone, which is the thing Save & Close had to carry.
const saved = await probe();
check(saved.title === 'Weighted Sum' && saved.inputs === 2 && saved.outputs === 1,
      'Save & Close commits the source and its derived interface', JSON.stringify(saved));

await browser.close();
server.close();
if (failures.length) {
  console.log('\n   page logs: ' + logs.slice(-15).join('\n              '));
  console.log(`\nJS_BLOCK_EDITOR_FAIL (${failures.length})`);
  process.exit(1);
}
console.log('\nJS_BLOCK_EDITOR_PASS');
