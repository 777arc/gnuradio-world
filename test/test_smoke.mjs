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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import {
  contentType,
  launchBrowser,
  setIsolationHeaders,
  suppressEditorWelcome,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8101);
// First eight cf32_le samples from the fm_rds example recording. Keeping only
// this prefix in the test makes it deterministic in CI, where the full
// git-ignored recording is intentionally unavailable.
// The path GR World Recording's factory derives from the key in
// gr_world_recording_offset.grc, and the one a File Source bound to a local file
// is rewritten to by the editor.
const OFFSET_RECORDING_PATH = '/recordings/fm_rds_250k_1Msamples.sigmf-data';
const OFFSET_LOCAL_PATH = '/local-files/offset-test/fm_rds_250k_1Msamples.sigmf-data';
const OFFSET_RECORDING_BASE64 =
  'dMG5PFtRrb3Awd88U7GpvUWBojxmwbK9gAHAOGlBtL3DgWG8WAGsvXFBuLxLsaW9/4H/vEAhoL064Ry9PBGevQ==';
const OFFSET_SAMPLE = 3;
// SigMF Source's binding, whose .sigmf-meta rides beside the samples.
const SIGMF_LOCAL_PATH = '/local-files/sigmf-test/tagged.sigmf-data';
const rangeRequests = [];

function expectedPoolTier(grc) {
  const start = grc.search(/^blocks:\s*$/m);
  if (start < 0) return 16;
  const afterStart = grc.slice(start).replace(/^blocks:\s*\n?/, '');
  const end = afterStart.search(/^(?:connections|metadata):\s*$/m);
  const blockSection = end < 0 ? afterStart : afterStart.slice(0, end);
  const blockCount = (blockSection.match(/^-\s+name\s*:/gm) || []).length;
  // Mirrors poolTierForBlockCount() in runner.html: multiples of 8, clamped.
  return Math.min(256, Math.max(8, Math.ceil((blockCount + 1) / 8) * 8));
}

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
  // RTL-SDR Source against its own generator rather than a dongle: CI has no
  // hardware, but the ring, the futex handoff, the command mailbox and the
  // u8->complex conversion are all the same code either way. `expectLogs`
  // catches the one thing a "blocks moved items" pass cannot — that the block
  // reported the rate the RTL2832U's resampler can actually reach, not the one
  // that was asked for. See docs/rtlsdr.md.
  { name: 'RTL-SDR Source (generated samples, no hardware)',
    grc: 'test/fixtures/rtlsdr_fake.grc',
    expectLogs: ['RTL-SDR Source: running at 1024000 S/s'] },
  { name: 'PlutoSDR Source and Sink (generated samples, no hardware)',
    grc: 'test/fixtures/plutosdr_fake.grc',
    expectLogs: [
      'PlutoSDR Source: running at 2500000 S/s with 1 channel',
      'PlutoSDR Sink: running at 2500000 S/s with 1 channel',
    ] },
  { name: 'HackRF Source and Sink (generated samples, no hardware)',
    grc: 'test/fixtures/hackrf_fake.grc',
    expectLogs: [
      'HackRF Source: running at 2000000 S/s',
      'HackRF Sink: running at 2000000 S/s',
    ] },
  // Audio Sink and Audio Source against Chrome's null audio device and fake
  // microphone -- no sound card needed, but every other part is the real one:
  // the AudioContext, the worklet, the ring in shared memory and the futex
  // handoff. `expectLogs` covers what a "blocks moved items" pass cannot, which
  // is that a device opened at the rate the flowgraph asked for; a graph whose
  // audio never started would still move items, paced by the sink's wall-clock
  // fallback. See docs/audio.md.
  { name: 'Audio Sink and Audio Source (browser audio devices)',
    grc: 'test/fixtures/audio_devices.grc',
    expectLogs: [
      'Audio Sink: running at 48000 Hz, 1 channel',
      'Audio Source: running at 48000 Hz, 1 channel',
    ] },
  // The PMT-valued blocks. `expectLogs` is what makes this case meaningful: a
  // PMT parameter that parsed into the *wrong* PMT still builds, still runs and
  // still moves items, so only what the tag and message debuggers print can tell
  // pmt.cons(intern, init_u8vector) apart from a symbol named after its own
  // source text. See wasm_registry::pmt_value().
  { name: 'PMT message/tag strobes and Tag Object',
    grc: 'test/fixtures/wasm_pmt_blocks.grc',
    expectLogs: [
      '(payload . #[11 22 33 44])',  // Message Strobe: a PDU built by pmt.cons
      'RANDOM_STROBE',               // Message Strobe Random-Delay: pmt.intern
      'Key: strobe_key',             // Tags Strobe: its key and pmt.from_double
      'Value: 2.5',
      'Key: burst',                  // Tag Object, emitted by Vector Source
      'Source: vector_src',
    ] },
  // The QT GUI controls. Their widgets need a click to say anything, which this
  // harness has no way to deliver, so what the logs prove is the half that runs
  // without one: a Message Strobe drives the Digital Number Control's `valuein`
  // and the control republishes on `valueout`, exercising both directions of a
  // control's message path, and the Message Edit Box emits its default value at
  // start(). Everything else here is proved by constructing at all -- a control
  // whose parameters it cannot make sense of throws rather than running.
  { name: 'QT GUI control widgets', grc: 'test/fixtures/wasm_qtgui_controls.grc',
    expectLogs: [
      '(freq . 42)',    // Digital Number Control: message in, message back out
      '(edit . hello)', // Message Edit Box: its default, published by start()
    ] },
  // The seven gr-qtgui sinks the Qt6 port added after the original four. Only
  // three of them have example flowgraphs, and an example is not run by this
  // harness anyway; what a case here proves is that each sink's display chain
  // is still in the qtgui archive and still constructs, which is the half of
  // the port that a CMake edit can silently undo. The Bercurve Sink also has
  // its log checked: it is fed a random stream against an alternating
  // reference, so it must reach a bit error rate near 0.5 (log10 -0.3) and say
  // so -- a sink that constructs but never pairs its two inputs prints nothing.
  { name: 'QT GUI sinks (eye, histogram, raster, vector, matrix, combined, BER)',
    grc: 'test/fixtures/wasm_qtgui_sinks.grc', expectLogs: ['ber_sink_b -'] },
  // The in-tree Python hier blocks rebuilt in C++ (blocks/src/*_hier.hpp). A
  // hier_block2 is not a gr::block, so it never appears in the diagnostics
  // snapshot itself: what these cases check is that each one constructs and that
  // the leaf blocks *downstream* of it moved items, which is what a hierarchy
  // that builds but stalls inside would fail.
  // expectLogs covers the one block here with no stream side at all: the async
  // encoder answers a 4-bit PDU with an 8-bit one, so the length Message Debug
  // prints is what says the rate-1/2 encoder ran rather than the PDU passing
  // straight through.
  { name: 'core hier rebuilds (interleaver, decimator, logpwrfft, channelizer, FEC)',
    grc: 'test/fixtures/wasm_hier_core.grc',
    expectLogs: ['pdu length =', '8 bytes'] },
  { name: 'GFSK/GMSK modems (deferred digital module)',
    grc: 'test/fixtures/wasm_hier_modems.grc' },
  // The BER curve generator is the one case here that checks the *arithmetic*
  // rather than the wiring: each Es/N0 point encodes a random byte stream, adds
  // Gaussian noise at that ratio and decodes, so what the BER sink prints says
  // whether the convolutional code is really being applied. The two points are
  // chosen either side of the K=7 rate-1/2 code's threshold: -4 dB is past it
  // and prints a bit error rate, +12 dB is well inside it and runs out of bits
  // to test before it finds an error ("BER Limit Reached"). A chain that ran but
  // decoded nothing would print a rate near log10(0.5) at both.
  { name: 'FEC BER curve generator (extended encoder/decoder per Es/N0 point)',
    grc: 'test/fixtures/wasm_hier_bercurve.grc',
    expectLogs: ['ber_sink_b -', 'BER Limit Reached'] },
  { name: 'CVSD vocoder and ATSC RX filter (deferred vocoder/dtv modules)',
    grc: 'test/fixtures/wasm_hier_vocoder_dtv.grc' },
  // The JavaScript Block is a case here, not an exemption. Unlike the Embedded
  // Python Block there is no optional runtime to skip over -- the harness is in
  // runner.js itself -- so the deploy gate covers it. `expectLogs` is what makes
  // the first case meaningful: a constant 1.0 through a decimation-2 JS block
  // scaling by 4 must print exactly 4.000, which only happens if the flowgraph's
  // parameter arrived as a number and the input view was 2 * nout items long.
  // Both cases' probe *values* are checked by test/test_js_block.mjs.
  { name: 'JavaScript Block (inline source: work(), generalWork(), live parameter)',
    grc: 'test/fixtures/wasm_js_block.grc',
    expectLogs: ['js_scale: first output 4.000'] },
  { name: 'repo JavaScript blocks (blocks/js/, fetched by id)',
    grc: 'test/fixtures/wasm_js_repo_blocks.grc' },
  { name: 'gr-satellites hier rebuilds', grc: 'test/fixtures/wasm_satellites_hier.grc' },
  { name: 'gr-satellites AX.25 framer/deframer loopback',
    grc: 'test/fixtures/wasm_satellites_ax25_loopback.grc' },
  { name: 'gr-satellites demodulator components',
    grc: 'test/fixtures/wasm_satellites_demodulators.grc', exactWorkers: 41,
    preloadedWorkers: 32, expectedPool: 48 },
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

// Each case is a separate page/tab in the same browser process, so the
// 60s-verdict-wait and the fixed 4s run-in settle time overlap across cases
// instead of serializing — that dead time, not CPU work, is most of what this
// loop spends. CONCURRENCY caps how many WASM runners run at once: CI's
// `ubuntu-latest` has 4 vCPUs, and each page's runner spins up its own pthread
// pool (some cases run dozens of workers), so this stays below what a bigger
// dev box could sustain to avoid trading wall-clock time for CI flakiness.
const CONCURRENCY = 4;

async function runCase(test) {
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
  const pool = stats ? JSON.parse(stats).pool : null;
  const dspThreads = stats ? JSON.parse(stats).dsp_threads : null;
  const initialExpectedPool = expectedPoolTier(grc);
  const monitor = await page.evaluate(() => ({
    tier: document.getElementById('d-tier')?.textContent?.trim() || '',
    workers: document.getElementById('d-workers')?.textContent?.trim() || '',
    threads: document.getElementById('d-thr')?.textContent?.trim() || '',
    tierBoundaries: [0, 7, 8, 15, 16, 31, 32].map(window.__grPoolTierForBlockCount),
    workerStats: window.__grWorkerStats ? { ...window.__grWorkerStats } : null,
  }));
  const workerLogOk = logs.some(line =>
    line.includes('workers: calc_used_blocks() = ') &&
    (test.exactWorkers === undefined ||
     line.includes(`workers: calc_used_blocks() = ${test.exactWorkers};`)));
  const preloadLogOk = test.preloadedWorkers === undefined || logs.some(line =>
    line.includes(`workers: preloading ${test.preloadedWorkers} missing workers`));
  // `prewarmed` is asserted alongside the rest because it is what the flake was
  // made of: the tracker used to size itself from the stats snapshot, which is
  // published by a separate 3 Hz timer, so a tick landing between the pre-start
  // top-up and the next snapshot compared the corrected pool against the tier it
  // replaced and booked the whole preload as scheduler-created extras.
  const correctedPoolOk = test.preloadedWorkers === undefined ||
    (pool === test.expectedPool && monitor.workerStats?.allocated === test.expectedPool &&
     monitor.workerStats?.prewarmed === test.expectedPool &&
     monitor.workerStats?.additionalCreated === 0);
  const poolOk = test.expectedPool === undefined
    ? pool % 8 === 0 && pool <= 256 && pool >= initialExpectedPool
    : pool === test.expectedPool;
  const monitorOk = poolOk &&
    JSON.stringify(monitor.tierBoundaries) === JSON.stringify([8, 8, 16, 16, 24, 32, 40]) &&
    new RegExp(`^tier ${pool} \\+\\d+ extra$`).test(monitor.tier) &&
    /^active workers \d+$/.test(monitor.workers) &&
    monitor.threads === `dsp threads ${dspThreads}` &&
    (test.exactWorkers === undefined || dspThreads === test.exactWorkers) &&
    workerLogOk && preloadLogOk && correctedPoolOk;
  // Message-only blocks carry no item counter (see msg_only in the runner's
  // snapshot), so requiring items > 0 of them would fail every PDU chain.
  const idle = blocks.filter(b => !b.msg_only && !(b.items > 0))
                     .map(b => `${b.name} (${b.id})`);
  // What the flowgraph printed, for a case whose correctness the item counters
  // cannot see (a block that ran with the wrong parameter value).
  const missingLogs = (test.expectLogs || [])
    .filter(expected => !logs.some(line => line.includes(expected)));

  const ok = started && blocks.length > 0 && idle.length === 0 && monitorOk &&
    missingLogs.length === 0;
  await page.close();

  const lines = [];
  lines.push(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  lines.push(`   ${verdict.trim()}`);
  if (blocks.length)
    lines.push('   items: ' + blocks.map(b => `${b.name}=${b.items}`).join(' '));
  else lines.push('   no diagnostics snapshot — the graph never reached the scheduler');
  if (idle.length) lines.push(`   produced nothing: ${idle.join(', ')}`);
  if (missingLogs.length)
    lines.push(`   never printed: ${missingLogs.map(s => JSON.stringify(s)).join(', ')}`);
  if (!monitorOk)
    lines.push(`   diagnostics headline mismatch: ${JSON.stringify(monitor)}, ` +
      `pool=${pool}, initialExpectedPool=${initialExpectedPool}, ` +
      `expectedPool=${test.expectedPool ?? 'any corrected tier'}`);
  if (!ok && logs.length) lines.push('   logs: ' + logs.slice(-4).join('\n         '));
  return { ok, lines };
}

const caseResults = new Array(CASES.length);
let nextCase = 0;
async function caseWorker() {
  while (nextCase < CASES.length) {
    const i = nextCase++;
    caseResults[i] = await runCase(CASES[i]);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, caseWorker));

let allOk = true;
for (const result of caseResults) {
  allOk = allOk && result.ok;
  console.log(result.lines.join('\n'));
}

// Exercise the editor-to-runner file handoff as an iframe, then assert the
// value observed by a Probe Signal after the WASM scheduler has consumed the
// one sample selected by File Source. The offset is deliberately a sample
// index: for cf32 it must advance by 8 bytes, not 3 bytes.
{
  const test = {
    name: 'File Source starts a local file at its sample offset',
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
    recordingPath: OFFSET_LOCAL_PATH,
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

// Exercise the HTTP backend, through the block that uses it: GR World Recording
// derives the descriptor path from its recording key. The test server refuses
// requests without Range, so this cannot accidentally pass by downloading the
// complete recording.
{
  const test = {
    name: 'GR World Recording streams a hosted recording with bounded HTTP ranges',
    grc: 'test/fixtures/gr_world_recording_offset.grc',
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
  await suppressEditorWelcome(page);
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

// SigMF Source: the recording's own metadata reaching the flowgraph as stream
// tags. This is what the block exists for -- reading the samples is the same
// BrowserFileSource every other file-reading block uses -- so it is asserted
// through what a Tag Debug prints rather than through item counts, which cannot
// see a tag at all. The Offset of 2 is deliberate: tag offsets are pass-relative,
// so the capture at sample 0 is dropped and the annotation at sample 5 lands on
// sample 3.
{
  const test = {
    name: 'SigMF Source turns captures and annotations into stream tags',
    grc: 'test/fixtures/sigmf_source_tags.grc',
  };
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));

  const grc = readFileSync(join(ROOT, test.grc), 'utf8');
  const meta = JSON.stringify({
    global: {
      'core:datatype': 'cf32_le',
      'core:version': '1.0.0',
      'core:sample_rate': 250000,
    },
    captures: [
      { 'core:sample_start': 0, 'core:frequency': 100000000 },
      { 'core:sample_start': 4, 'core:frequency': 101000000 },
    ],
    annotations: [
      { 'core:sample_start': 5, 'core:sample_count': 2, 'core:label': 'burst' },
    ],
  });

  await page.goto(`http://localhost:${PORT}/__recording_test__`,
                  { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(({ grc, recordingBase64, recordingPath, meta }) => {
    const binary = atob(recordingBase64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    window.__grTakeRecordingFiles = token => token === 'sigmf-test'
      ? [{ kind: 'local', path: recordingPath, file: new Blob([bytes]), meta }]
      : [];
    const frame = document.createElement('iframe');
    frame.id = 'runner';
    frame.src = '/runner/build/runner.html?recordingToken=sigmf-test#' +
      encodeURIComponent(grc);
    document.body.appendChild(frame);
  }, {
    grc,
    recordingBase64: OFFSET_RECORDING_BASE64,
    recordingPath: SIGMF_LOCAL_PATH,
    meta,
  });

  let verdict = '(no #result)';
  try {
    await page.waitForFunction(() => {
      const frame = document.getElementById('runner');
      const result = frame?.contentDocument?.getElementById('result');
      return result && result.dataset.status !== 'pending';
    }, { timeout: 60000, polling: 200 });
    verdict = await page.evaluate(() =>
      document.getElementById('runner').contentDocument.getElementById('result').textContent);
    // Tag Debug prints on its own schedule, so wait for the last tag rather
    // than racing it. Polled here rather than in the page: the lines arrive as
    // console messages from the runner frame, which only this side sees.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline &&
           !logs.some(line => line.includes('sigmf:annotation')))
      await new Promise(resolve => setTimeout(resolve, 100));
  } catch { /* report the captured state below */ }

  const printed = logs.join('\n');
  const tagLines = printed.split('\n').filter(line => /Key:/.test(line));
  const tagAt = (offset, key) => tagLines.some(line =>
    new RegExp(`Offset:\\s*${offset}\\s`).test(line) &&
    new RegExp(`Key:\\s*${key}(\\s|$)`).test(line));
  // The capture at sample 0 is before the Offset and must not appear at all; the
  // one at sample 4 must, shifted to sample 2, and the annotation at sample 5 to
  // sample 3. rx_freq/rx_rate are the conventional names other GNU Radio blocks
  // look for; the dictionaries carry everything else the recording said.
  const checks = {
    'rx_freq at the shifted capture': tagAt(2, 'rx_freq'),
    'rx_rate at the shifted capture': tagAt(2, 'rx_rate'),
    'sigmf:capture at the shifted capture': tagAt(2, 'sigmf:capture'),
    'sigmf:annotation at the shifted annotation': tagAt(3, 'sigmf:annotation'),
    'the annotation carries its label': /burst/.test(printed),
    'the pre-Offset capture is dropped':
      tagLines.filter(line => /Key:\s*rx_freq/.test(line))
        .every(line => /Offset:\s*2\s/.test(line)),
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  const ok = verdict.includes('RUNNER_PASS') && failed.length === 0;
  allOk = allOk && ok;
  console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${test.name}  (${test.grc})`);
  console.log(`   ${verdict.trim()}`);
  console.log(`   tag checks: ${Object.keys(checks).length - failed.length}/` +
              `${Object.keys(checks).length} passed`);
  if (failed.length) console.log(`   failed: ${failed.join(', ')}`);
  if (!ok) console.log('   tag output: ' +
    printed.split('\n').filter(line => /Offset:|rx_|sigmf:/.test(line)).slice(0, 20)
      .join('\n                '));
  await page.close();
}

await browser.close();
server.close();
console.log(`\n=== ${allOk ? 'ALL SMOKE TESTS PASS' : 'SMOKE TESTS FAILED'} ===`);
process.exit(allOk ? 0 : 1);
