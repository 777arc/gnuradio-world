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
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { contentType, launchBrowser, setIsolationHeaders } from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8101);
// First eight cf32_le samples from the fm_rds example recording. Keeping only
// this prefix in the test makes it deterministic in CI, where the full
// git-ignored recording is intentionally unavailable.
const OFFSET_RECORDING_PATH = '/recordings/fm_rds_250k_1Msamples.sigmf-data';
const OFFSET_RECORDING_BASE64 =
  'dMG5PFtRrb3Awd88U7GpvUWBojxmwbK9gAHAOGlBtL3DgWG8WAGsvXFBuLxLsaW9/4H/vEAhoL064Ry9PBGevQ==';
const OFFSET_SAMPLE = 3;
const rangeRequests = [];

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
  { name: 'OFDM loopback (deferred digital module)', grc: 'example_flowgraphs/ofdm/ofdm.grc' },
  { name: 'PSK constellation (hier block + qtgui sinks)', grc: 'example_flowgraphs/digital/psk_constellation.grc' },
  { name: 'AM modulation example', grc: 'example_flowgraphs/analog/am_modulation.grc' },
  { name: 'FM loopback example (core module only)', grc: 'example_flowgraphs/analog/fm_loopback.grc' },
  { name: 'low-pass filter example', grc: 'example_flowgraphs/analog/low_pass_filter.grc' },
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
  setIsolationHeaders(res);
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__recording_test__') {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      return res.end('<!doctype html><title>Recording test harness</title>');
    }
    if (p === '/__range_recording__') {
      const bytes = Buffer.from(OFFSET_RECORDING_BASE64, 'base64');
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!match) { res.writeHead(400); return res.end('Range required'); }
      const start = Number(match[1]), end = Number(match[2]);
      rangeRequests.push({ start, end });
      if (start < 0 || end < start || end >= bytes.length) {
        res.setHeader('Content-Range', `bytes */${bytes.length}`);
        res.writeHead(416); return res.end();
      }
      const body = bytes.subarray(start, end + 1);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
      res.setHeader('Content-Length', body.length);
      res.writeHead(206);
      return res.end(body);
    }
    if (p.endsWith('/')) p += 'index.html';
    const editorAsset = p === '/index.html' || p === '/blocks.json' || p.startsWith('/assets/');
    const fp = normalize(join(editorAsset ? join(ROOT, 'editor/dist') : ROOT, p));
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

// Exercise the HTTP backend. The test server refuses requests without Range,
// so this cannot accidentally pass by downloading the complete recording.
{
  const test = {
    name: 'File Source streams an example recording with bounded HTTP ranges',
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
  rangeRequests.length = 0;
  await page.goto(`http://localhost:${PORT}/__recording_test__`,
                  { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(({ grc, recordingPath, size, port }) => {
    window.__grTakeRecordingFiles = token => token === 'range-test'
      ? [{
          kind: 'http',
          path: recordingPath,
          url: `http://localhost:${port}/__range_recording__`,
          size,
        }]
      : [];
    const frame = document.createElement('iframe');
    frame.id = 'runner';
    frame.src = '/runner/build/runner.html?recordingToken=range-test#' +
      encodeURIComponent(grc);
    document.body.appendChild(frame);
  }, {
    grc,
    recordingPath: OFFSET_RECORDING_PATH,
    size: bytes.length,
    port: PORT,
  });

  let verdict = '(no #result)', probe = null, fileStats = [];
  try {
    await page.waitForFunction(() => {
      const frame = document.getElementById('runner');
      const result = frame?.contentDocument?.getElementById('result');
      return result && result.dataset.status !== 'pending';
    }, { timeout: 60000, polling: 200 });
    verdict = await page.evaluate(() =>
      document.getElementById('runner').contentDocument.getElementById('result').textContent);
    await page.waitForFunction(() => {
      const runner = document.getElementById('runner')?.contentWindow;
      if (!runner?.__grstats) return false;
      return JSON.parse(runner.__grstats).blocks.find(item => item.name === 'probe')?.items === 1;
    }, { timeout: 10000, polling: 100 });
    ({ probe, fileStats } = await page.evaluate(() => {
      const runner = document.getElementById('runner').contentWindow;
      return {
        probe: JSON.parse(runner.__grstats).blocks.find(item => item.name === 'probe'),
        fileStats: Object.values(runner.__grFileStats || {}),
      };
    }));
  } catch { /* report captured state below */ }

  const valueOk = probe?.value?.length === 2 &&
    Math.abs(probe.value[0] - expected[0]) <= 1e-7 &&
    Math.abs(probe.value[1] - expected[1]) <= 1e-7;
  const expectedStart = OFFSET_SAMPLE * 8;
  const rangesOk = rangeRequests.length === 1 &&
    rangeRequests[0].start === expectedStart &&
    rangeRequests[0].end === expectedStart + 7;
  const bounded = fileStats.length === 1 &&
    fileStats[0].maxChunkBytes <= 2 * 1024 * 1024 &&
    fileStats[0].bytesRead === 8;
  const ok = verdict.includes('RUNNER_PASS') && valueOk && rangesOk && bounded;
  allOk = allOk && ok;
  console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  console.log(`   ${verdict.trim()}`);
  console.log(`   ranges: ${JSON.stringify(rangeRequests)}  stats: ${JSON.stringify(fileStats)}`);
  if (!ok && logs.length) console.log('   logs: ' + logs.slice(-6).join('\n         '));
  await page.close();
}

// Select a sparse >4 GiB file through the actual editor UI and read one byte
// beyond the 32-bit boundary. A whole-file implementation would OOM; a
// truncated offset would observe the wrong byte.
{
  const test = {
    name: 'Editor File Source streams a local file beyond 4 GiB',
    grc: 'test/fixtures/local_file_source_large_offset.grc',
  };
  const largeOffset = 4294967312;
  const expected = 0xa5;
  const tempDir = await mkdtemp(join(tmpdir(), 'gnuradio-world-file-source-'));
  const sparsePath = join(tempDir, 'large-sparse.bin');
  const handle = await open(sparsePath, 'w');
  await handle.truncate(largeOffset + 1);
  await handle.write(Buffer.from([expected]), 0, 1, largeOffset);
  await handle.close();

  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  let verdict = '(no #result)', probe = null, fileStats = [], selectedSize = null;
  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0', timeout: 60000 });
    const openInput = await page.$('#fileOpen');
    await openInput.uploadFile(join(ROOT, test.grc));
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#nodes .title')]
        .some(node => node.textContent === 'File Source'), { timeout: 10000 });

    await page.evaluate(() => {
      const title = [...document.querySelectorAll('#nodes .title')]
        .find(node => node.textContent === 'File Source');
      const group = title?.closest('.blk');
      group?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 200, clientY: 200,
      }));
    });
    await page.evaluate(() => {
      const properties = [...document.querySelectorAll('.ctxitem')]
        .find(item => item.textContent === 'Properties');
      properties?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForSelector('.file-picker-native');
    await (await page.$('.file-picker-native')).uploadFile(sparsePath);
    selectedSize = await page.$eval(
      '.file-picker-native', input => input.files?.[0]?.size ?? null);
    await page.evaluate(() => {
      const ok = [...document.querySelectorAll('.dlgfoot button')]
        .find(button => button.textContent === 'OK');
      ok?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.click('button[aria-label="Execute"]');
    await page.waitForFunction(() => {
      const frame = document.getElementById('runFrame');
      const result = frame?.contentDocument?.getElementById('result');
      return result && result.dataset.status !== 'pending';
    }, { timeout: 60000, polling: 200 });
    verdict = await page.evaluate(() =>
      document.getElementById('runFrame').contentDocument.getElementById('result').textContent);
    await page.waitForFunction(() => {
      const runner = document.getElementById('runFrame')?.contentWindow;
      if (!runner?.__grstats) return false;
      return JSON.parse(runner.__grstats).blocks.find(item => item.name === 'probe')?.items === 1;
    }, { timeout: 10000, polling: 100 });
    ({ probe, fileStats } = await page.evaluate(() => {
      const runner = document.getElementById('runFrame').contentWindow;
      return {
        probe: JSON.parse(runner.__grstats).blocks.find(item => item.name === 'probe'),
        fileStats: Object.values(runner.__grFileStats || {}),
      };
    }));
  } catch (error) {
    logs.push('TESTERROR ' + error.message);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true, force: true });
  }

  const bounded = fileStats.length === 1 &&
    fileStats[0].ringBytes <= 16 * 1024 * 1024 &&
    fileStats[0].maxChunkBytes <= 2 * 1024 * 1024 &&
    fileStats[0].bytesRead === 1;
  const ok = verdict.includes('RUNNER_PASS') && probe?.value === expected && bounded;
  allOk = allOk && ok;
  console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  console.log(`   ${verdict.trim()}`);
  console.log(`   selected size: ${selectedSize}  observed: ${probe?.value ?? '(no probe)'}  ` +
              `stats: ${JSON.stringify(fileStats)}`);
  if (!ok && logs.length) console.log('   logs: ' + logs.slice(-8).join('\n         '));
}

// Pick a picture from "this computer" for gr-paint's Image File Source, through
// the same editor Properties > Browse control the File Source case uses. The
// image is an SVG, which is the one format createImageBitmap refuses, so this
// also covers the <img> fallback in runner.html: a decode that silently lost
// either the local binding or that fallback shows up here as a flowgraph that
// never starts.
{
  const test = {
    name: 'Editor Image File Source decodes a local SVG',
    grc: 'test/fixtures/local_image_source.grc',
  };
  const width = 64, height = 32;
  const tempDir = await mkdtemp(join(tmpdir(), 'gnuradio-world-image-source-'));
  const imagePath = join(tempDir, 'white-block.svg');
  // Solid white, so every luma byte is 255 with the BT.709 mapping off.
  await writeFile(imagePath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/></svg>\n`);

  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  let verdict = '(no #result)', probe = null, announced = '', selectedName = null;
  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0', timeout: 60000 });
    const openInput = await page.$('#fileOpen');
    await openInput.uploadFile(join(ROOT, test.grc));
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#nodes .title')]
        .some(node => node.textContent === 'Image File Source'), { timeout: 10000 });

    await page.evaluate(() => {
      const title = [...document.querySelectorAll('#nodes .title')]
        .find(node => node.textContent === 'Image File Source');
      title?.closest('.blk')?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 200, clientY: 200,
      }));
    });
    await page.evaluate(() => {
      const properties = [...document.querySelectorAll('.ctxitem')]
        .find(item => item.textContent === 'Properties');
      properties?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForSelector('.file-picker-native');
    await (await page.$('.file-picker-native')).uploadFile(imagePath);
    selectedName = await page.$eval(
      '.file-picker-native', input => input.files?.[0]?.name ?? null);
    await page.evaluate(() => {
      const ok = [...document.querySelectorAll('.dlgfoot button')]
        .find(button => button.textContent === 'OK');
      ok?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.click('button[aria-label="Execute"]');
    await page.waitForFunction(() => {
      const frame = document.getElementById('runFrame');
      const result = frame?.contentDocument?.getElementById('result');
      return result && result.dataset.status !== 'pending';
    }, { timeout: 60000, polling: 200 });
    verdict = await page.evaluate(() =>
      document.getElementById('runFrame').contentDocument.getElementById('result').textContent);
    await page.waitForFunction(() => {
      const runner = document.getElementById('runFrame')?.contentWindow;
      if (!runner?.__grstats) return false;
      return JSON.parse(runner.__grstats).blocks.find(item => item.name === 'probe')?.items > 0;
    }, { timeout: 10000, polling: 100 });
    probe = await page.evaluate(() => JSON.parse(
      document.getElementById('runFrame').contentWindow.__grstats)
      .blocks.find(item => item.name === 'probe'));
    // The block prints the decoded size to the editor's console pane; it is
    // what tells the reader the Spectrum Painter's Image Width to use.
    announced = await page.evaluate(() => {
      const line = [...document.getElementById('log').textContent.split('\n')]
        .find(text => text.includes('paint.image_source:'));
      return line || '';
    });
  } catch (error) {
    logs.push('TESTERROR ' + error.message);
  } finally {
    await page.close();
    await rm(tempDir, { recursive: true, force: true });
  }

  const ok = verdict.includes('RUNNER_PASS') && probe?.value === 255 &&
    announced.includes(`${width * height} bytes, ${width}px width`);
  allOk = allOk && ok;
  console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  console.log(`   ${verdict.trim()}`);
  console.log(`   selected: ${selectedName}  luma: ${probe?.value ?? '(no probe)'}  ` +
              `announced: ${announced.trim() || '(nothing)'}`);
  if (!ok && logs.length) console.log('   logs: ' + logs.slice(-8).join('\n         '));
}

await browser.close();
server.close();
console.log(`\n=== ${allOk ? 'ALL SMOKE TESTS PASS' : 'SMOKE TESTS FAILED'} ===`);
process.exit(allOk ? 0 : 1);
