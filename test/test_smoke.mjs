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
//   node test/test_smoke.mjs [port]
//
// Serves the repository root (COOP/COEP, as SharedArrayBuffer requires) so there is no
// background server to manage. Exits non-zero if any case fails.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8101);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
               '.json': 'application/json', '.svg': 'image/svg+xml' };
// First eight cf32_le samples from the fm_rds example recording. Keeping only
// this prefix in the test makes it deterministic in CI, where the full
// git-ignored recording is intentionally unavailable.
const OFFSET_RECORDING_PATH = '/recordings/fm_rds_250k_1Msamples.sigmf-data';
const OFFSET_RECORDING_BASE64 =
  'dMG5PFtRrb3Awd88U7GpvUWBojxmwbK9gAHAOGlBtL3DgWG8WAGsvXFBuLxLsaW9/4H/vEAhoL064Ry9PBGevQ==';
const OFFSET_SAMPLE = 3;

// Flowgraphs to run. Each .grc is handed straight to runner.html, which is NOT
// the editor's Run path: parameter expressions are resolved by the editor
// (resolveParamsForRun -> editor/src/expr.ts) and never by the C++ runner. So
// every case here has to be expression-free, which is why the gr-satellites
// AX.25 examples -- which keep upstream's `2*math.pi*1000/samp_rate` and friends
// -- are covered by the expression-free fixtures below instead of directly.
//
// The pass rule is deliberately name-independent: EVERY block
// in the diagnostics snapshot must have moved items. That stays valid when an
// example is edited, and it catches a graph that starts but stalls somewhere in
// the middle -- the "missing length tag" signature, where the source runs and
// everything downstream sits at zero.
const CASES = [
  { name: 'analog demo (core module only)', grc: 'example_flowgraphs/example_1.grc' },
  { name: 'PSK constellation (hier block + qtgui sinks)', grc: 'example_flowgraphs/PSK_constellation.grc' },
  { name: 'AM modulation example', grc: 'example_flowgraphs/am_modulation.grc' },
  { name: 'FM loopback example', grc: 'example_flowgraphs/fm_loopback.grc' },
  { name: 'low-pass filter example', grc: 'example_flowgraphs/low_pass_filter.grc' },
  { name: 'new core/filter blocks', grc: 'test/fixtures/wasm_added_core.grc' },
  { name: 'new constellation and synchronizer blocks', grc: 'test/fixtures/wasm_added_digital.grc' },
  { name: 'new FEC leaf blocks', grc: 'test/fixtures/wasm_added_fec.grc' },
  { name: 'gr-satellites hier rebuilds', grc: 'test/fixtures/wasm_satellites_hier.grc' },
  { name: 'gr-satellites AX.25 framer/deframer loopback',
    grc: 'test/fixtures/wasm_satellites_ax25_loopback.grc' },
  { name: 'gr-satellites demodulator components',
    grc: 'test/fixtures/wasm_satellites_demodulators.grc' },
];

const server = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__recording_test__') {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      return res.end('<!doctype html><title>Recording test harness</title>');
    }
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
  // Message-only blocks carry no item counter (see msg_only in the runner's
  // snapshot), so requiring items > 0 of them would fail every PDU chain.
  const idle = blocks.filter(b => !b.msg_only && !(b.items > 0))
                     .map(b => `${b.name} (${b.id})`);

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

// Exercise the editor-to-runner recording handoff as an iframe, then assert the
// value observed by a Probe Signal after the WASM scheduler has consumed the
// one sample selected by File Source. The offset is deliberately a sample
// index: for cf32 it must advance by 8 bytes, not 3 bytes.
{
  const test = {
    name: 'File Source starts an example recording at its sample offset',
    grc: 'test/fixtures/file_source_offset.grc',
  };
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));

  const grc = readFileSync(join(ROOT, test.grc), 'utf8');
  const bytes = Buffer.from(OFFSET_RECORDING_BASE64, 'base64');
  const expected = [
    bytes.readFloatLE(OFFSET_SAMPLE * 8),
    bytes.readFloatLE(OFFSET_SAMPLE * 8 + 4),
  ];
  await page.goto(`http://localhost:${PORT}/__recording_test__`,
                  { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(({ grc, recordingBase64, recordingPath }) => {
    const binary = atob(recordingBase64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    window.__grTakeRecordingFiles = token => token === 'offset-test'
      ? [{ path: recordingPath, blob: new Blob([bytes]) }]
      : [];
    const frame = document.createElement('iframe');
    frame.id = 'runner';
    frame.src = '/runner/build/runner.html?recordingToken=offset-test#' +
      encodeURIComponent(grc);
    document.body.appendChild(frame);
  }, {
    grc,
    recordingBase64: OFFSET_RECORDING_BASE64,
    recordingPath: OFFSET_RECORDING_PATH,
  });

  let verdict = '(no #result)';
  let probe = null;
  try {
    await page.waitForFunction(() => {
      const frame = document.getElementById('runner');
      const result = frame?.contentDocument?.getElementById('result');
      return result && result.dataset.status !== 'pending';
    }, { timeout: 60000, polling: 200 });
    verdict = await page.evaluate(() =>
      document.getElementById('runner').contentDocument.getElementById('result').textContent);
    await page.waitForFunction(() => {
      const stats = document.getElementById('runner').contentWindow.__grstats;
      if (!stats) return false;
      const block = JSON.parse(stats).blocks.find(item => item.name === 'probe');
      return block?.items === 1 && Array.isArray(block.value);
    }, { timeout: 10000, polling: 100 });
    probe = await page.evaluate(() => {
      const stats = document.getElementById('runner').contentWindow.__grstats;
      return JSON.parse(stats).blocks.find(item => item.name === 'probe');
    });
  } catch { /* report the captured state below */ }

  const closeEnough = (actual, wanted) =>
    Number.isFinite(actual) && Math.abs(actual - wanted) <= 1e-7;
  const valueOk = probe?.value?.length === 2 &&
    closeEnough(probe.value[0], expected[0]) &&
    closeEnough(probe.value[1], expected[1]);
  const ok = verdict.includes('RUNNER_PASS') && probe?.items === 1 && valueOk;
  allOk = allOk && ok;
  console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  console.log(`   ${verdict.trim()}`);
  console.log(`   expected sample ${OFFSET_SAMPLE}: ${JSON.stringify(expected)}`);
  console.log(`   observed: ${probe ? JSON.stringify(probe.value) : '(no probe value)'}`);
  if (!ok && logs.length) console.log('   logs: ' + logs.slice(-4).join('\n         '));
  await page.close();
}

await browser.close();
server.close();
console.log(`\n=== ${allOk ? 'ALL SMOKE TESTS PASS' : 'SMOKE TESTS FAILED'} ===`);
process.exit(allOk ? 0 : 1);
