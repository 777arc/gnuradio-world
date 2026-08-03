#!/usr/bin/env node
// Run an example flowgraph the way a user does: load it in the *editor*, press
// Run, and report what came back.
//
// This exists because feeding a .grc straight to runner.html (scripts/run.mjs,
// test/test_smoke.mjs) skips everything the editor does to a flowgraph on the
// way to the runner, and two whole classes of bug live in that gap:
//
//   * parameter ids. A hand-written RUNNABLE schema in editor/src/main.ts wins
//     over the generated one, and unknown parameters are dropped in silence.
//     A .grc using GRC's `freq`/`amp` on analog_sig_source_x (whose schema says
//     `frequency`/`amplitude`) loads with those values replaced by defaults —
//     the runner accepts both spellings, so it runs correctly when loaded
//     directly and silently wrong through the editor.
//   * validation. Connection type checks, required-parameter checks and
//     expression resolution all run in the editor. A flowgraph that the runner
//     would happily execute can still be refused before it gets there.
//
// Needs `node server.mjs 8090 "$PWD"` already running (as scripts/run.mjs does),
// and the editor built (cd editor && npm run build).
//
// Usage: node scripts/run_example.mjs <example.grc | title substring>
//                                     [port] [runSeconds] [--expect=<substring>]
//                                     [--reject=<substring>]...
// Exits non-zero if the editor refuses the flowgraph, the runner fails, a block
// sits idle, a flowgraph with a printing block prints nothing, --expect is
// absent, or any --reject substring appears in the console pane.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { launchBrowser } from './browser-test-support.mjs';

const args = process.argv.slice(2);
const expectIndex = args.findIndex(a => a.startsWith('--expect='));
const expect = expectIndex >= 0 ? args.splice(expectIndex, 1)[0].slice('--expect='.length) : '';
const rejects = args.filter(a => a.startsWith('--reject=')).map(
  a => a.slice('--reject='.length));
for (let i = args.length - 1; i >= 0; --i)
  if (args[i].startsWith('--reject=')) args.splice(i, 1);
const [target, port = '8090', runSeconds = '25'] = args;
if (!target) {
  console.error('usage: node scripts/run_example.mjs <example.grc | title> [port] [runSeconds] ' +
                '[--expect=<substring the console must contain>] ' +
                '[--reject=<substring the console must not contain>]...');
  process.exit(2);
}

// Blocks that exist to report to the user by printing. If a flowgraph has one
// and prints nothing, it is not working, however healthily the graph runs — the
// motivating case being a demodulator silently mis-parameterised by the editor,
// which leaves every block happily moving samples and decoding nothing.
const PRINTING_BLOCKS = [
  'blocks_message_debug', 'satellites_print_header', 'satellites_print_timestamp',
  'satellites_hexdump_sink',
];
let expectsOutput = false;
// Accept a filename and look up the title the editor lists it under, so either
// form works on the command line.
let title = target;
if (target.endsWith('.grc')) {
  const exampleRoot = new URL('../example_flowgraphs/', import.meta.url).pathname;
  const path = resolve(exampleRoot, target);
  const rootPrefix = exampleRoot.endsWith(sep) ? exampleRoot : exampleRoot + sep;
  if (!path.startsWith(rootPrefix)) {
    console.error(`example path escapes example_flowgraphs: ${target}`); process.exit(2);
  }
  if (!existsSync(path)) { console.error(`no such example: ${path}`); process.exit(2); }
  const text = readFileSync(path, 'utf8');
  const match = text.match(/^\s+title:\s*(.+?)\s*$/m);
  title = match ? match[1].replace(/^['"]|['"]$/g, '') : basename(target, '.grc');
  expectsOutput = PRINTING_BLOCKS.some(
    id => new RegExp(`^\\s+id:\\s*${id}\\s*$`, 'm').test(text));
}

const browser = await launchBrowser(new URL('..', import.meta.url).pathname);
let ok = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1500));

  const tab = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')].find(b => /Example Flowgraphs/.test(b.textContent || '')));
  if (!tab.asElement()) throw new Error('Example Flowgraphs tab not found');
  await tab.asElement().click();
  await new Promise(r => setTimeout(r, 3000));

  const entry = await page.evaluateHandle(t => {
    const leaf = [...document.querySelectorAll('div')].find(
      d => d.children.length === 0 && (d.textContent || '').trim().includes(t));
    if (!leaf) return null;
    for (let parent = leaf.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    return leaf.closest('.ex-row')?.querySelector('.ex-item') || leaf;
  }, title);
  if (!entry.asElement()) throw new Error(`example not listed in the editor: ${title}`);
  await entry.asElement().click();
  await new Promise(r => setTimeout(r, 2500));
  const placed = await page.evaluate(() => document.querySelectorAll('#nodes > *').length);
  console.log(`loaded "${title}" — ${placed} blocks on the canvas`);

  const run = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '▶'));
  if (!run.asElement()) throw new Error('Run button not found');
  await run.asElement().click();
  await new Promise(r => setTimeout(r, Number(runSeconds) * 1000));

  // The editor's console pane: validation refusals land here, and so does
  // anything the flowgraph printed (Message Debug and friends).
  const pane = await page.evaluate(() => (document.getElementById('log').textContent || '').split('\n'));
  const refused = pane.filter(l => /^cannot run|^ {2}\S.*must be|run failed/.test(l));

  // The runner's own verdict, from inside the iframe.
  let verdict = '(runner iframe never appeared)', moved = 0, idle = [];
  for (const frame of page.frames()) {
    if (!/runner\.html/.test(frame.url())) continue;
    ({ verdict, moved, idle } = await frame.evaluate(() => {
      const d = document.getElementById('result');
      const s = window.__grstats ? JSON.parse(window.__grstats) : null;
      return {
        verdict: d ? d.textContent : '(no #result)',
        moved: s ? s.blocks.filter(b => b.items > 0).length : 0,
        idle: s ? s.blocks.filter(b => !b.msg_only && !(b.items > 0)).map(b => b.name) : [],
      };
    }));
  }

  // What the *flowgraph* printed. Everything the editor itself logs has to be
  // filtered out, or the "printed nothing" check below silently passes: an
  // example backed by a recording always logs its "ready to stream" binding line
  // before the graph even starts.
  const EDITOR_LOG = /^(Editor ready|opened |loaded example|▶ running|workers: |ready to stream |recordings for example |example "[^"]*" references unavailable recording)/;
  const printed = pane.filter(l => l.trim() && !EDITOR_LOG.test(l));
  console.log(`runner: ${verdict.trim()}`);
  console.log(`blocks moving items: ${moved}${idle.length ? `  | idle: ${idle.join(', ')}` : ''}`);
  console.log(`console pane: ${pane.length} lines, ${printed.length} from the flowgraph`);
  for (const line of printed.slice(0, 6)) console.log('   |', line);

  if (refused.length) {
    console.log('EDITOR REFUSED THE FLOWGRAPH:');
    for (const line of refused) console.log('   !', line);
  }
  const silent = expectsOutput && printed.length === 0;
  if (silent)
    console.log('NO OUTPUT: the flowgraph has a printing block (Message Debug or similar) ' +
                'but printed nothing — it runs without producing anything.');
  const missing = expect && !pane.some(l => l.includes(expect));
  if (missing) console.log(`MISSING: the console never contained ${JSON.stringify(expect)}`);
  const rejected = rejects.filter(value => pane.some(l => l.includes(value)));
  for (const value of rejected)
    console.log(`REJECTED: the console contained ${JSON.stringify(value)}`);
  ok = !refused.length && verdict.includes('RUNNER_PASS') && idle.length === 0 &&
       !silent && !missing && rejected.length === 0;
} catch (err) {
  console.error('failed:', err.message);
} finally {
  await browser.close();
}
console.log(ok ? 'RESULT: EXAMPLE_PASS' : 'RESULT: EXAMPLE_FAIL');
process.exit(ok ? 0 : 1);
