// End-to-end smoke test of the BUILT runner: do real flowgraphs actually run,
// and do samples actually move?
//
// This exists because a build that compiles and links cleanly can still be dead
// on arrival. The case that motivated it: an unpatched VOLK whose volk_malloc()
// returned NULL under Emscripten, so every flowgraph threw std::bad_alloc during
// construction -- CI was green and the deployed app could not run anything.
//
// Each case loads a .grc in the runner, waits for its RESULT verdict, and then
// checks the diagnostics snapshot (window.__grstats, published ~3 Hz by the
// runner) to confirm the named blocks moved a non-zero number of items. A graph
// that starts but produces nothing -- a missing length tag, a stalled buffer --
// fails here too, which a RUNNER_PASS check alone would miss.
//
//   node test_smoke.mjs [port]
//
// Serves the repository root (COOP/COEP, as SharedArrayBuffer requires) so there is no
// background server to manage. Exits non-zero if any case fails.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = normalize(new URL('.', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8101);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
               '.json': 'application/json', '.svg': 'image/svg+xml' };

// Flowgraphs to run. The pass rule is deliberately name-independent: EVERY block
// in the diagnostics snapshot must have moved items. That stays valid when an
// example is edited, and it catches a graph that starts but stalls somewhere in
// the middle -- the "missing length tag" signature, where the source runs and
// everything downstream sits at zero.
const CASES = [
  { name: 'analog demo (core module only)', grc: 'example_flowgraphs/example_1.grc' },
  { name: 'PSK constellation (hier block + qtgui sinks)', grc: 'example_flowgraphs/PSK_constellation.grc' },
];

const server = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const fp = normalize(join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(fp);
    res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream');
    res.writeHead(200);
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, r));

const base = join(ROOT, 'chrome-headless-shell');
const exe = existsSync(base)
  ? readdirSync(base).map(d => join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell')).find(existsSync)
  : undefined;
if (!exe) {
  console.error('chrome-headless-shell not found under chrome-headless-shell/.\n' +
                'Install it with:  npx @puppeteer/browsers install chrome-headless-shell@stable --path .');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: exe, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader'],
});

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
      { timeout: 60000, polling: 200 });
    verdict = await page.evaluate(() => document.getElementById('result').textContent);
  } catch { /* fall through with whatever is there */ }
  const started = verdict.includes('RUNNER_PASS');

  // Let the graph run before sampling the counters, so "started" and "actually
  // producing" stay distinguishable.
  await new Promise(r => setTimeout(r, 4000));
  const stats = await page.evaluate(() => window.__grstats || null);
  const blocks = stats ? JSON.parse(stats).blocks : [];
  const idle = blocks.filter(b => !(b.items > 0)).map(b => `${b.name} (${b.id})`);

  const ok = started && blocks.length > 0 && idle.length === 0;
  allOk = allOk && ok;
  console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  console.log(`   ${verdict.trim()}`);
  if (blocks.length)
    console.log('   items: ' + blocks.map(b => `${b.name}=${b.items}`).join(' '));
  else console.log('   no diagnostics snapshot — the graph never reached the scheduler');
  if (idle.length) console.log(`   produced nothing: ${idle.join(', ')}`);
  if (!ok && logs.length) console.log('   logs: ' + logs.slice(-4).join('\n         '));
  await page.close();
}

await browser.close();
server.close();
console.log(`\n=== ${allOk ? 'ALL SMOKE TESTS PASS' : 'SMOKE TESTS FAILED'} ===`);
process.exit(allOk ? 0 : 1);
