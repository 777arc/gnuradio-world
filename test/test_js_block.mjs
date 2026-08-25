// End-to-end test of the JavaScript Block: does a flowgraph whose work() is
// JavaScript actually run, and does it compute the right thing?
//
//   node test/test_js_block.mjs [port]
//
// Unlike the Embedded Python Block's test this needs no optional runtime -- there
// is nothing to download and nothing to skip over -- so the same cases are also
// in test_smoke.mjs, which gates the deploy. What this file adds is the *values*:
// each case reads a probe whose number can only come out right if the parameter
// reached the block, the views addressed GNU Radio's own buffers, and the
// consume/produce arithmetic matched the block's rate.
//
// The two halves this cannot reach are covered elsewhere:
//   * the harness itself (validation, view shapes, the shipped blocks'
//     arithmetic) -- runner/test/js_runtime.test.mjs, on plain Node;
//   * the editor (derivation, defFor, the .grc round trip) --
//     editor/test/js-block.test.mjs.
//
// Serves the repository root with COOP/COEP, as SharedArrayBuffer requires, so
// there is no background server to manage.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import {
  contentType,
  launchBrowser,
  setIsolationHeaders,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8105);

const CASES = [
  {
    // Inline source, carried by the flowgraph itself. A Const source at
    // amplitude 1 through a decimation-2 JS block scaling by 4, so every output
    // sample is exactly 4.0 -- which only happens if the flowgraph's `scale`
    // parameter reached `this.scale` as a number rather than as the string "4",
    // and if the input view really was 2 * nout items long.
    //
    // The same graph carries a generalWork() block doing a complex 1:1
    // passthrough with its own this.consume(); a block that consumed the wrong
    // amount stalls its chain and fails the "everything moved items" rule below.
    name: 'inline JavaScript: a decimating work() and a generalWork()',
    grc: 'test/fixtures/wasm_js_block.grc',
    expectProbes: { probe: 4.0 },
    expectPrint: 'js_scale: first output 4.000',
    expectJsDiagnostics: 2,
  },
  {
    // Repo blocks (blocks/js/), whose sources the runner fetches by id before
    // any block is built -- no instance here carries one inline. A constant
    // 2+0j clipped to 0.5 must read exactly 0.5; a constant -3.0 peak-held with
    // Absolute on must read exactly 3.0.
    name: 'repo JavaScript blocks, fetched by id',
    grc: 'test/fixtures/wasm_js_repo_blocks.grc',
    expectProbes: { probe_clip: 0.5, probe_peak: 3.0 },
    expectJsDiagnostics: 3,
  },
];

const server = http.createServer(async (req, res) => {
  setIsolationHeaders(res);
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const fp = normalize(join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(fp);
    res.setHeader('Content-Type', contentType(fp));
    res.writeHead(200);
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, r));

const browser = await launchBrowser(ROOT);
let allOk = true;

for (const test of CASES) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));

  const grc = readFileSync(join(ROOT, test.grc), 'utf8');
  await page.goto(`http://localhost:${PORT}/runner/build/runner.html#${encodeURIComponent(grc)}`,
                  { waitUntil: 'load', timeout: 30000 });

  let verdict = '(no #result)';
  try {
    await page.waitForFunction(
      () => { const d = document.getElementById('result'); return d && d.dataset.status !== 'pending'; },
      { timeout: 60000, polling: 250 });
    verdict = await page.evaluate(() => document.getElementById('result').textContent);
  } catch { /* fall through with whatever is there */ }
  const started = verdict.includes('RUNNER_PASS');

  // Let it run, then read the counters and the probes the same way the smoke
  // test does -- a JS block that starts and then stalls must fail here.
  await new Promise(r => setTimeout(r, 5000));
  const stats = await page.evaluate(() => window.__grstats || null);
  const snapshot = stats ? JSON.parse(stats) : { blocks: [] };
  const blocks = snapshot.blocks || [];
  const idle = blocks.filter(b => !b.msg_only && !(b.items > 0)).map(b => `${b.name} (${b.id})`);

  const wrong = [];
  for (const [name, expected] of Object.entries(test.expectProbes)) {
    const probe = blocks.find(b => b.name === name);
    if (!probe || Math.abs(probe.value - expected) > 1e-4)
      wrong.push(`${name} = ${probe ? probe.value : '(absent)'}, expected ${expected}`);
  }
  const printOk = !test.expectPrint || logs.some(line => line.includes(test.expectPrint));
  const jsDiagnostics = blocks.filter(block => block.javascript);
  const diagnosticsOk = jsDiagnostics.length === test.expectJsDiagnostics &&
    jsDiagnostics.every(block => block.javascript.work_calls > 0 &&
      block.javascript.last_requested > 0 && block.javascript.last_produced >= 0 &&
      block.javascript.zero_progress_calls >= 0);

  const ok = started && blocks.length > 0 && idle.length === 0 && !wrong.length &&
    printOk && diagnosticsOk;
  allOk = allOk && ok;
  console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  console.log(`   ${verdict.trim()}`);
  if (blocks.length) console.log('   items: ' + blocks.map(b => `${b.name}=${b.items}`).join(' '));
  if (idle.length) console.log(`   produced nothing: ${idle.join(', ')}`);
  for (const line of wrong) console.log(`   probe ${line}`);
  if (!printOk) console.log(`   never printed ${JSON.stringify(test.expectPrint)}`);
  if (!diagnosticsOk) console.log(`   JS diagnostics: ${JSON.stringify(jsDiagnostics)}`);
  if (!ok && logs.length) console.log('   logs: ' + logs.slice(-12).join('\n         '));
  await page.close();
}

await browser.close();
server.close();
console.log(allOk ? '\nJS_BLOCK_PASS' : '\nJS_BLOCK_FAIL');
process.exit(allOk ? 0 : 1);
