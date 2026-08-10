// End-to-end test of the Embedded Python Block: does a flowgraph whose work() is
// Python actually run, and does it compute the right thing?
//
//   node test/test_python_block.mjs [port]
//
// Separate from test_smoke.mjs on purpose. This is the only test that needs the
// vendored Pyodide distribution (deps/fetch-pyodide.sh, ~16 MB), and the smoke
// test gates the deploy -- it should not start failing on a tree that simply has
// not fetched an optional runtime. This one skips with a clear message instead.
//
// Serves the repository root with COOP/COEP, as SharedArrayBuffer requires, so
// there is no background server to manage.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import {
  contentType,
  launchBrowser,
  setIsolationHeaders,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8103);

// A Const source at amplitude 1 through a decim_block that scales by
// samp_rate/32000*4 == 4, so every output sample is exactly 4.0. That one number
// is the whole point: it only comes out right if the parameter expression was
// evaluated with the flowgraph's variables in scope, if the input samples were
// copied into Pyodide's memory, and if the results were copied back out.
const CASES = [
  {
    name: 'decim_block scales a Const source',
    grc: 'test/fixtures/epy_block_scale.grc',
    probe: 'blocks_probe_signal_x_0',
    expectProbe: 4.0,
    expectPrint: 'epy first output 4.000',
  },
  // The second case is about the *import*: a block whose source asks for scipy
  // gets scipy, installed from its own import statements before it runs (see
  // loadImports in gr_pyodide_worker.js). Its 4-tap filter over a constant 1.0
  // sums to exactly 10, so an installed-but-broken scipy fails here too.
  {
    name: 'a block importing scipy filters with scipy.signal.fftconvolve',
    grc: 'test/fixtures/epy_block_scipy.grc',
    probe: 'blocks_probe_signal_x_0',
    expectProbe: 10.0,
    expectPrint: 'epy scipy steady output 10.000',
  },
];

if (!await stat(join(ROOT, 'pyodide', 'pyodide.mjs')).catch(() => null)) {
  console.log('SKIP: no pyodide/ -- run `bash deps/fetch-pyodide.sh` to enable ' +
              'the Embedded Python Block tests');
  process.exit(0);
}

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
    // Generous: the first run downloads and starts CPython before the flowgraph
    // is even built.
    await page.waitForFunction(
      () => { const d = document.getElementById('result'); return d && d.dataset.status !== 'pending'; },
      { timeout: 120000, polling: 250 });
    verdict = await page.evaluate(() => document.getElementById('result').textContent);
  } catch { /* fall through with whatever is there */ }
  const started = verdict.includes('RUNNER_PASS');

  // Let it run, then read the counters and the probe the same way the smoke test
  // does -- a Python Block that starts and then stalls must fail here.
  await new Promise(r => setTimeout(r, 5000));
  const stats = await page.evaluate(() => window.__grstats || null);
  const snapshot = stats ? JSON.parse(stats) : { blocks: [] };
  const blocks = snapshot.blocks || [];
  const idle = blocks.filter(b => !b.msg_only && !(b.items > 0)).map(b => `${b.name} (${b.id})`);
  const probe = blocks.find(b => b.name === test.probe);
  const probeOk = probe !== undefined && Math.abs(probe.value - test.expectProbe) < 1e-4;
  const printOk = logs.some(line => line.includes(test.expectPrint));

  const ok = started && blocks.length > 0 && idle.length === 0 && probeOk && printOk;
  allOk = allOk && ok;
  console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  console.log(`   ${verdict.trim()}`);
  if (blocks.length) console.log('   items: ' + blocks.map(b => `${b.name}=${b.items}`).join(' '));
  if (idle.length) console.log(`   produced nothing: ${idle.join(', ')}`);
  if (!probeOk)
    console.log(`   probe ${test.probe} = ${probe ? probe.value : '(absent)'}, ` +
                `expected ${test.expectProbe}`);
  if (!printOk) console.log(`   never printed ${JSON.stringify(test.expectPrint)}`);
  if (!ok && logs.length) console.log('   logs: ' + logs.slice(-12).join('\n         '));
  await page.close();
}

await browser.close();
server.close();
console.log(allOk ? '\nPYTHON_BLOCK_PASS' : '\nPYTHON_BLOCK_FAIL');
process.exit(allOk ? 0 : 1);
