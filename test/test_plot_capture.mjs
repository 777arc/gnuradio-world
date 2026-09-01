// Graham looking at the plots, and reading them as numbers.
//
//   node test/test_plot_capture.mjs [port]
//
// Two observation tools, one path, and no model involved: the browser's fetch is
// replaced with a stub that answers each round with the tool calls this test
// wants made, so the whole real chain runs — the agent loop, the tool dispatch,
// capture.ts against the live iframe, the runner's GUI observation providers,
// and the Qwt plot-data adapter — while the assertions stay deterministic.
//
// What is actually at risk here, and what each assertion is for:
//
//  * The picture is real. Qt for WebAssembly contributes a canvas inside an
//    open shadow root, while browser-native renderers contribute overlay layers;
//    it is easy to ship a capture that silently returns a blank rectangle.
//    So: the PNG is decoded again and checked for more than a handful of colors.
//  * The numbers are the plot's. gr_read_plot_data walks Qwt's public plot
//    dictionary; a sink whose curves it cannot reach reports zero of them
//    rather than failing, which would look like a working tool saying nothing.
//  * The image reaches the model. A tool result is a string on this API, so the
//    picture travels in a separate user message. If that message is not built,
//    everything above still passes and Graham sees nothing — so the stub reads
//    its own request bodies back and this checks one carries an image part.
//  * The budget holds. An image is resent on every later round of a turn, so
//    the per-turn cap and the eviction of older images are what stop one
//    conversation costing many times what it should.
//
// Needs a built editor and a built runner.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import {
  contentType,
  launchBrowser,
  setIsolationHeaders,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8107);

for (const [path, hint] of [
  ['editor/dist/index.html', 'run `npm run build` in editor/'],
  ['runner/build/runner.js', 'build the runner'],
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
    if (p.endsWith('/')) p += 'index.html';
    const direct = normalize(join(ROOT, p));
    if (!direct.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const fp = await stat(direct).then(s => s.isFile()).catch(() => false)
      ? direct : normalize(join(ROOT, 'editor', 'dist', p));
    const body = await readFile(fp);
    res.setHeader('Content-Type', contentType(fp));
    res.writeHead(200);
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, r));

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await launchBrowser(ROOT);
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const logs = [];
page.on('console', message => logs.push(message.text().slice(0, 300)));
page.on('pageerror', error => logs.push('PAGEERROR ' + error.message));

// The stub model. Each round answers with the tool calls named in the script
// below; the last one answers with prose, which is what ends the turn. It reads
// the transcript it is sent, both to pick a real widget name for the crop and so
// this test can assert on what actually went up the wire.
await page.evaluateOnNewDocument(() => {
  // Consent is what the first Send waits on, and the onboarding choice is what
  // the dock waits on before it will load a model at all. Both are the same
  // localStorage the dock itself writes once a user has been through them.
  try {
    localStorage.setItem('gnuradio-world.hosted-consent', 'yes');
    localStorage.setItem('gnuradio-world.graham-onboarded', 'yes');
    localStorage.setItem('gnuradio-world.ai-provider', 'hosted');
  } catch { /* opaque */ }

  const requests = [];
  globalThis.__aiRequests = requests;
  let round = 0;

  const call = (index, name, args) => ({
    index, id: `call_${index}_${round}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });

  // A plot the previous round's read_plot_data reported, so the crop is asked
  // for by a name that really exists in this run — and a drawn plot rather than
  // a slider, which is what cropping is for.
  const widgetName = messages => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      try {
        // capture_plots lists the window's widgets too, so match on the field
        // only read_plot_data carries rather than on the first result seen.
        const widgets = JSON.parse(message.content)?.widgets;
        const plot = widgets?.find(widget => widget.kind === 'curves');
        if (plot?.name) return plot.name;
      } catch { /* not this one */ }
    }
    return '';
  };

  const script = messages => {
    switch (round) {
      case 1: return [call(0, 'run_flowgraph', { seconds: 3 })];
      case 2: return [call(0, 'read_plot_data', { points: 8 }),
                      call(1, 'capture_plots', { settle_seconds: 0.5 })];
      case 3: return [call(0, 'capture_plots', { block: widgetName(messages) })];
      // The third capture of the turn is the last one allowed; the fourth has
      // to come back as an error rather than as an image.
      case 4: return [call(0, 'capture_plots', {}), call(1, 'capture_plots', {})];
      default: return null;
    }
  };

  const sse = payloads => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const payload of payloads)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input?.url || '');
    if (!url.includes('/chat/completions')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push(body);
    round++;
    const calls = script(body.messages || []);
    if (!calls)
      return Promise.resolve(sse([{ choices: [{ delta: { content: 'Looked at it.' },
        finish_reason: 'stop' }] }]));
    return Promise.resolve(sse([
      { choices: [{ delta: { tool_calls: calls } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));
  };
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
// The welcome example (PSK Tx with Constellation) is what the editor opens on,
// and its QT GUI sinks are the plots under test.
await page.waitForFunction(() => document.querySelectorAll('#nodes > *').length > 3,
  { timeout: 60000, polling: 300 });

// The dock's open state lives on the app element, not on the dock: clicking the
// toggle when it is already open would close it and never load a model.
await page.evaluate(() => {
  if (document.getElementById('app')?.classList.contains('ai-hidden'))
    document.querySelector('.ai-toggle').click();
});
await page.waitForFunction(() => {
  const send = [...document.querySelectorAll('#aiDock button')]
    .find(button => button.textContent.trim() === 'Send');
  return send && !send.disabled;
}, { timeout: 30000, polling: 200 });

await page.evaluate(() => {
  const box = document.querySelector('.ai-prompt');
  box.value = 'run it and look at the plots';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.ai-compose').requestSubmit();
});

// The turn is over when Stop hides again. A run inside it is real: the flowgraph
// starts, the scheduler runs, and the observation waits on Qt drawing.
await page.waitForFunction(() => {
  const stop = [...document.querySelectorAll('#aiDock button')]
    .find(button => button.textContent.trim() === 'Stop');
  return stop && !stop.hidden;
}, { timeout: 30000, polling: 200 });
await page.waitForFunction(() => {
  const stop = [...document.querySelectorAll('#aiDock button')]
    .find(button => button.textContent.trim() === 'Stop');
  return !stop || stop.hidden;
}, { timeout: 240000, polling: 500 });

const results = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.ai-tool')].map(row => ({
    label: row.querySelector('summary')?.textContent?.trim() || '',
    result: row.querySelector('pre.ai-tool-result')?.textContent || '',
    error: !!row.querySelector('pre.ai-tool-result.error'),
    images: [...row.querySelectorAll('img.ai-tool-image')].map(image => ({
      src: image.src, width: image.naturalWidth, height: image.naturalHeight,
    })),
  }));
  return rows;
});

// The run report is where a model decides whether the counters answered the
// question, so it is where the two observation tools have to be named.
const runRow = results.find(row => row.label.includes('run_flowgraph'));
check(!!runRow && /plotting:.*read_plot_data.*capture_plots/.test(runRow.result),
  'the run report names the plots this run put on screen and how to observe them');

const plotRow = results.find(row => row.label.includes('read_plot_data'));
check(!!plotRow && !plotRow.error, 'read_plot_data answered');
let plots = null;
try { plots = JSON.parse(plotRow.result); } catch { /* reported below */ }
const widgets = plots?.widgets || [];
check(widgets.length > 0, `read_plot_data reported ${widgets.length} GUI widget(s)`);
console.log('    widgets: ' + widgets.map(widget =>
  `${widget.name} (${widget.id}, ${widget.kind})`).join(', '));
const curved = widgets.filter(widget => widget.kind === 'curves');
check(curved.length > 0, 'at least one widget reported curves rather than nothing');
const curve = curved[0]?.curves?.[0];
check(!!curve && curve.points > 0 && Array.isArray(curve.samples) && curve.samples.length > 0,
  `a trace carries points and samples (${curve?.points} points, ` +
  `${curve?.samples?.length} sampled)`);
check(!!curve?.peak && Number.isFinite(curve.peak.x) && Number.isFinite(curve.peak.y),
  'a trace reports where its peak is');
check(typeof curved[0]?.x_axis?.title === 'string' && curved[0].x_axis.title.length > 0,
  `the x axis is named as the plot names it ("${curved[0]?.x_axis?.title}")`);

const captures = results.filter(row => row.label.includes('capture_plots'));
check(captures.length === 4, `capture_plots was called ${captures.length} times`);
const shots = captures.flatMap(row => row.images);
check(shots.length === 3,
  `${shots.length} screenshots were produced; the fourth must have been refused`);
check(captures.at(-1)?.error === true && /screenshots this turn/.test(captures.at(-1)?.result || ''),
  'the fourth capture in one turn is refused by the image budget');

const [full, cropped] = shots;
check(!!full && full.src.startsWith('data:image/png;base64,') && full.width > 100,
  `the window capture is a ${full?.width}x${full?.height} PNG`);
check(!!cropped && cropped.width > 0 && cropped.width < full.width,
  `cropping to one widget produced a smaller image (${cropped?.width}x${cropped?.height} ` +
  `against ${full?.width}x${full?.height})`);

// A blank readback is the failure this whole path is most likely to have: it
// looks like a working screenshot everywhere except in the pixels.
const colors = await page.evaluate(async src => {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve; image.onerror = reject; image.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  const data = canvas.getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const seen = new Set();
  for (let index = 0; index < data.length; index += 4 * 37)
    seen.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
  return seen.size;
}, full?.src || '');
check(colors > 8, `the captured image has real content (${colors} distinct colors sampled)`);

const bytes = Math.round((full.src.length - full.src.indexOf(',') - 1) * 0.75);
check(bytes <= 60_000, `the capture is bounded in size (${(bytes / 1024).toFixed(0)} KB)`);

// The wire. A tool result is a string, so the picture only reaches the model if
// a separate message carries it.
const sent = await page.evaluate(() => globalThis.__aiRequests.map(body => ({
  images: (body.messages || []).flatMap(message =>
    Array.isArray(message.content)
      ? message.content.filter(part => part.type === 'image_url') : []).length,
  evicted: JSON.stringify(body.messages || [])
    .split('no longer in this conversation').length - 1,
  tools: (body.tools || []).map(entry => entry.function.name),
})));
check(sent.some(request => request.images > 0),
  'a request carried the screenshot to the model as an image part');
check(sent.at(-1).images === 2,
  `the last request carried ${sent.at(-1).images} images, the two most recent`);
check(sent.at(-1).evicted === 1,
  'the older screenshot was replaced by a line of text rather than resent');
check(sent[0].tools.includes('capture_plots') && sent[0].tools.includes('read_plot_data'),
  'both observation tools were offered to the model');

if (failures.length) {
  console.log('\n--- page logs (tail) ---\n' + logs.slice(-25).join('\n'));
  console.log(`\nPLOT_CAPTURE_FAIL: ${failures.length} check(s) failed`);
} else {
  console.log('\nPLOT_CAPTURE_PASS');
}
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
