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
// So: place a JS Block, check the canvas drew the default source's ports without
// evaluating anything, open the popup editor through Properties ▸ Expand Editor,
// and retype the source to change its ports and parameters -- the live panel has
// to follow on its own. Then check that a broken source is reported in the
// runtime's own words, and that Save & Close carries the derived interface onto
// the block. Needs a built editor and a built runner (the sandbox evaluates
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

const GRAHAM_SOURCE = `gr.export({
  label: 'Graham Gain',
  inputs: ['float'],
  outputs: ['float'],
  params: { gain: 2 },
  work(nout, input, output) {
    for (let i = 0; i < nout; i++) output[0][i] = input[0][i] * this.gain;
    return nout;
  },
});`;

const GRAHAM_MODIFIED_SOURCE = `gr.export({
  label: 'Graham Weighted Sum',
  inputs: ['float', 'float'],
  outputs: ['float'],
  params: { left: 1, right: 1 },
  work(nout, input, output) {
    for (let i = 0; i < nout; i++)
      output[0][i] = input[0][i] * this.left + input[1][i] * this.right;
    return nout;
  },
});`;

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

// Return is the editor's Properties shortcut for the selected block. Use that
// supported path here instead of the canvas's 350 ms double-press gesture: a
// click rebuilds the SVG, and a loaded CI runner can spend longer than that
// between the two events even though nothing is wrong with the dialog under test.
const openPropsDialog = async () => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal.props .code-field textarea.code-editor',
                             { timeout: 15000 });
};

// "Expand Editor ⤢" beside the dialog's Code field. The modal is seeded from the
// dialog's working copy and written back to it -- which is why it is reached
// through the dialog rather than straight from the canvas.
const openCodeModal = async () => {
  await openPropsDialog();
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.modal.props .code-controls button')]
      .find(node => /Expand Editor/.test(node.textContent || ''));
    if (!button) return false;
    button.click();
    return true;
  });
  if (!opened) throw new Error('the Properties dialog has no Expand Editor button');
  await page.waitForSelector('.modal.code-modal textarea.code-modal-area',
                             { timeout: 15000 });
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
let aiRequests = 0;
await page.setRequestInterception(true);
page.on('request', request => {
  if (!request.url().includes('ai.gnuradioworld.com/v1/chat/completions')) {
    void request.continue();
    return;
  }
  const origin = `http://localhost:${PORT}`;
  if (request.method() === 'OPTIONS') {
    void request.respond({ status: 204, headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    } });
    return;
  }
  aiRequests++;
  const chunk = aiRequests === 1
    ? { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'create_js', type: 'function', function: {
        name: 'create_js_block', arguments: JSON.stringify({
          name: 'graham_gain', source: GRAHAM_SOURCE,
        }),
      } },
      { index: 1, id: 'exercise_js', type: 'function', function: {
        name: 'exercise_js_block', arguments: JSON.stringify({
          name: 'graham_gain', calls: [{ nout: 4, inputs: [[1, 2, 3, 4]],
            set_params: { gain: 3 } }],
        }),
      } },
    ] } }] }
    : aiRequests === 3
      ? { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'modify_js', type: 'function', function: {
          name: 'set_js_block_source', arguments: JSON.stringify({
            name: 'graham_gain', source: GRAHAM_MODIFIED_SOURCE,
          }),
        } },
        { index: 1, id: 'exercise_modified_js', type: 'function', function: {
          name: 'exercise_js_block', arguments: JSON.stringify({
            name: 'graham_gain', calls: [{ nout: 2, inputs: [[1, 2], [3, 4]],
              set_params: { left: 2, right: -1 } }],
          }),
        } },
      ] } }] }
      : aiRequests === 5
        ? { choices: [{ delta: { tool_calls: [
          { index: 0, id: 'fork_js', type: 'function', function: {
            name: 'fork_js_block', arguments: JSON.stringify({
              name: 'js_phase_unwrap_ff_0',
            }),
          } },
        ] } }] }
        : { choices: [{ delta: { content: aiRequests === 2
          ? 'Created and exercised Graham Gain.'
          : aiRequests === 4 ? 'Modified and exercised Graham Weighted Sum.'
          : 'Forked Phase Unwrap into an editable inline block.' } }] };
  void request.respond({ status: 200, contentType: 'text/event-stream', headers: {
    'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-cache',
  }, body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` });
});
const logs = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
await page.setViewport({ width: 1400, height: 900 });
await suppressEditorWelcome(page);
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('gnuradio-world.hosted-consent', 'yes');
});
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
      'Expand Editor opens a mounted code editor', JSON.stringify(modal));
check(modal.highlighted, 'the source is highlighted as JavaScript');
check(/in: complex.*out: complex/.test(modal.ports),
      'the live panel names the derived ports', modal.ports);
check(/gain/.test(modal.params) && /live/.test(modal.params),
      'and its parameters, marking the ones a Range can drive', modal.params);
check(/start\(\)/.test(modal.notes), 'and the optional hooks it defines', modal.notes);
check(!modal.reread.some(label => /read/i.test(label)),
      'nothing has to be pressed to read the code', JSON.stringify(modal.reread));

// Retype the source. Nothing is clicked: the derived interface must follow on its
// own. It follows in the *panel*: the modal edits the Properties dialog's working
// copy, which Cancel still discards, so the block face follows only when Save &
// Close commits it -- checked at the end.
await setSource(EDITED_SOURCE);
await page.waitForFunction(
  () => (document.querySelector('.code-modal-label')?.textContent || '').trim() ===
        'Weighted Sum',
  { timeout: 20000, polling: 100 });

const panel = await page.evaluate(() => ({
  label: document.querySelector('.code-modal-label')?.textContent || '',
  ports: document.querySelector('.code-modal-ports')?.textContent || '',
  params: document.querySelector('.code-modal-params')?.textContent || '',
}));
check(panel.label.trim() === 'Weighted Sum', "the label follows the descriptor's label",
      panel.label);
check(/in: float, float/.test(panel.ports) && /out: float/.test(panel.ports),
      'the ports follow the code as it is typed, with nothing pressed', panel.ports);
check(/left/.test(panel.params) && /right/.test(panel.params),
      'and the derived parameters follow with them', panel.params);
check((await probe())?.inputs === 1,
      'the canvas holds its committed interface while the popup is open');

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
// The panel keeps the last interface that *did* read, rather than losing the
// ports to a half-typed line -- the same thing a Python Block does with a source
// it could not read. The block face carries the error too, but not checkably
// here: this block has unconnected ports, and the face shows only the first five
// wrapped lines of a block's issues.
const stillStands = await page.evaluate(() => ({
  label: (document.querySelector('.code-modal-label')?.textContent || '').trim(),
  ports: document.querySelector('.code-modal-ports')?.textContent || '',
}));
check(stillStands.label === 'Weighted Sum' && /in: float, float/.test(stillStands.ports),
      'and the last interface that did read still stands, ports and all',
      JSON.stringify(stillStands));

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
check(saved.rows.some(row => row.includes('Left')) && saved.rows.some(row => row.includes('Right')),
      'the derived parameters appear on the block face', JSON.stringify(saved.rows));

// It reopens the dialog it was launched from, on the committed source: the
// parameter and port set that dialog was drawn from has just changed.
const reopened = await page.evaluate(() => {
  const area = document.querySelector('.modal.props .code-field textarea.code-editor');
  return { open: !!area, seeded: /Weighted Sum/.test(area?.value || '') };
});
check(reopened.open && reopened.seeded,
      'and reopens Properties on the committed source', JSON.stringify(reopened));

// Graham's dedicated source path: a stub model creates a block and exercises
// it in the same round. This reaches main.ts's real dependency bundle, the
// sandboxed descriptor derivation and the disposable Worker; the plain Node
// tool tests deliberately cannot reach any of those browser boundaries.
await page.evaluate(() => document.querySelector('.modal.props .dlgclose')?.click());
await page.evaluate(() => document.querySelector('.ai-toggle')?.click());
// A first-time visitor meets the payment chooser before anything else in the
// dock; take the free shared provider, which is what the stub above stands in
// for. Until that choice is made the prompt form is hidden and Send does
// nothing.
await page.waitForSelector('.ai-onboarding-choice');
await page.evaluate(() => document.querySelector('.ai-onboarding-choice')?.click());
await page.waitForSelector('.ai-prompt', { visible: true });
await page.evaluate(() => {
  const prompt = document.querySelector('.ai-prompt');
  prompt.value = 'Create and test a float gain JS Block.';
  prompt.closest('form').requestSubmit();
});
await page.waitForFunction(() =>
  (document.querySelector('.ai-transcript')?.textContent || '')
    .includes('Created and exercised Graham Gain.'),
{ timeout: 30000, polling: 100 });
const graham = await probe();
check(graham?.title === 'Graham Gain' && graham.inputs === 1 && graham.outputs === 1,
      'Graham creates a JS Block through descriptor-safe source tooling', JSON.stringify(graham));
check(graham?.rows.some(row => /Gain/.test(row)),
      'Graham’s derived numeric parameter reaches the canvas', JSON.stringify(graham?.rows));
check(aiRequests === 2,
      'create and exercise share one tool round before the final answer', String(aiRequests));
const sourceWasTrusted = await page.evaluate(source => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const key = hash.toString(16).padStart(8, '0') + ':' + source.length;
  return JSON.parse(localStorage.getItem('gnuradio-world.js-blocks-accepted') || '[]').includes(key);
}, GRAHAM_SOURCE);
check(!sourceWasTrusted,
      'Graham-authored source still requires the normal human review before a live run');

await page.evaluate(() => {
  const prompt = document.querySelector('.ai-prompt');
  prompt.value = 'Modify it into a tested weighted sum with two float inputs.';
  prompt.closest('form').requestSubmit();
});
await page.waitForFunction(() =>
  (document.querySelector('.ai-transcript')?.textContent || '')
    .includes('Modified and exercised Graham Weighted Sum.'),
{ timeout: 30000, polling: 100 });
const modifiedByGraham = await probe();
check(modifiedByGraham?.title === 'Graham Weighted Sum' &&
      modifiedByGraham.inputs === 2 && modifiedByGraham.outputs === 1,
      'Graham source modification atomically refreshes the derived interface',
      JSON.stringify(modifiedByGraham));
check(modifiedByGraham?.rows.some(row => /Left/.test(row)) &&
      modifiedByGraham?.rows.some(row => /Right/.test(row)),
      'newly derived parameters replace the prior source parameter set',
      JSON.stringify(modifiedByGraham?.rows));
check(aiRequests === 4,
      'modify and exercise also share one tool round before the final answer', String(aiRequests));

const placedRepoForFork = await page.evaluate(() => {
  const item = [...document.querySelectorAll('.pal-item')]
    .find(node => node.textContent.trim() === 'Phase Unwrap');
  item?.click();
  return !!item;
});
check(placedRepoForFork, 'a repository JS block is available for Graham to fork');
await page.evaluate(() => {
  const prompt = document.querySelector('.ai-prompt');
  prompt.value = 'Fork the selected Phase Unwrap repository JS block so I can edit it.';
  prompt.closest('form').requestSubmit();
});
await page.waitForFunction(() =>
  (document.querySelector('.ai-transcript')?.textContent || '')
    .includes('Forked Phase Unwrap into an editable inline block.'),
{ timeout: 30000, polling: 100 });
await page.evaluate(() => document.querySelector('.ai-toggle')?.click());
await openPropsDialog();
const forkedSource = await page.evaluate(() =>
  document.querySelector('.modal.props .code-field textarea.code-editor')?.value || '');
check(/Phase Unwrap/.test(forkedSource) && /gr\.export/.test(forkedSource),
      'Graham can fork a shipped repository JS block into editable inline source');
check(aiRequests === 6, 'forking completes in one tool round', String(aiRequests));

await browser.close();
server.close();
if (failures.length) {
  console.log('\n   page logs: ' + logs.slice(-15).join('\n              '));
  console.log(`\nJS_BLOCK_EDITOR_FAIL (${failures.length})`);
  process.exit(1);
}
console.log('\nJS_BLOCK_EDITOR_PASS');
