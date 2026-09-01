// End-to-end browser test for the GNU Radio World Spectrum Analyzer. It drives
// both input types through the built runner, checks numeric plot observation,
// exercises the peak/OBW controls, and verifies that real input has no negative
// frequency half.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import {
  contentType,
  launchBrowser,
  setIsolationHeaders,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8110);
if (!await stat(join(ROOT, 'runner/build/runner.js')).catch(() => null)) {
  console.log('SKIP: missing built runner');
  process.exit(0);
}

const server = http.createServer(async (request, response) => {
  setIsolationHeaders(response);
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filename = normalize(join(ROOT, pathname));
    if (!filename.startsWith(ROOT)) { response.writeHead(403); return response.end(); }
    const body = await readFile(filename);
    response.setHeader('Content-Type', contentType(filename));
    response.writeHead(200);
    response.end(body);
  } catch { response.writeHead(404); response.end('not found'); }
});
await new Promise(resolve => server.listen(PORT, resolve));

const browser = await launchBrowser(ROOT);
const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const grc = await readFile(join(ROOT, 'test/fixtures/wasm_spectrum_analyzer.grc'), 'utf8');
  await page.goto(`http://localhost:${PORT}/runner/build/runner.html#${encodeURIComponent(grc)}`,
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() =>
    document.getElementById('result')?.dataset.status === 'pass',
  { timeout: 60000, polling: 200 });
  await page.waitForFunction(() => {
    const raw = window.__grReadPlotData?.('', 32);
    try {
      const widgets = JSON.parse(raw || '{}').widgets || [];
      return widgets.length === 2 && widgets.every(widget => widget.curves?.[0]?.points > 0);
    } catch { return false; }
  }, { timeout: 30000, polling: 200 });

  let plots = await page.evaluate(() => JSON.parse(window.__grReadPlotData('', 32)));
  check(plots.widgets.length === 2, 'both complex and float analyzers report plot data');
  const complex = plots.widgets.find(widget => widget.name === 'complex_analyzer');
  const real = plots.widgets.find(widget => widget.name === 'real_analyzer');
  check(complex?.x_axis?.min < 0 && complex?.x_axis?.max > 0,
    'complex input displays the two-sided spectrum');
  check(real?.x_axis?.min >= 0 && real?.x_axis?.max === 48000,
    'float input displays only 0 through Nyquist');
  check(Math.abs(complex?.curves?.[0]?.peak?.x - 12000) < 30,
    `complex peak is at 12 kHz (${complex?.curves?.[0]?.peak?.x})`);
  check(Math.abs(real?.curves?.[0]?.peak?.x - 9375) < 30,
    `float peak is at 9.375 kHz (${real?.curves?.[0]?.peak?.x})`);
  check(Math.abs(complex?.curves?.[0]?.peak?.y + 6.0206) < 0.4,
    `complex 0.5-amplitude carrier is about -6.02 dBFS (${complex?.curves?.[0]?.peak?.y})`);
  check(Math.abs(real?.curves?.[0]?.peak?.y + 12.0412) < 0.5,
    `real 0.25-amplitude sinusoid is about -12.04 dBFS (${real?.curves?.[0]?.peak?.y})`);

  await page.evaluate(() => {
    for (const root of document.querySelectorAll('.gr-spectrum-analyzer')) {
      [...root.querySelectorAll('button')]
        .find(button => button.textContent === 'Peak Search')?.click();
      [...root.querySelectorAll('button')]
        .find(button => button.textContent.startsWith('OBW '))?.click();
    }
  });
  await new Promise(resolve => setTimeout(resolve, 250));
  plots = await page.evaluate(() => JSON.parse(window.__grReadPlotData('', 32)));
  check(plots.widgets.every(widget => widget.marker && widget.occupied_bandwidth?.width > 0),
    'peak search and occupied-bandwidth controls produce measurements');
  check(plots.widgets.every(widget => widget.occupied_bandwidth.width < 1000),
    'a bin-centered tone has a narrow 99% occupied bandwidth');
  const canvases = await page.evaluate(() => [...document.querySelectorAll(
    'canvas.gr-spectrum-analyzer-plot')].map(canvas => ({
      width: canvas.width, height: canvas.height, visible: canvas.offsetParent !== null,
    })));
  check(canvases.length === 2 && canvases.every(canvas =>
    canvas.visible && canvas.width > 100 && canvas.height > 100),
  'both browser-native analyzer canvases are visible and sized');

  // The overlay carries no geometry of its own: it is positioned from the
  // runner's widget report (publish_gui_layout() in runner.cpp), so a renderer
  // that drifts off its QWidget placeholder -- or a report that stops arriving
  // -- shows up as a mismatch here rather than as a plot in the wrong place.
  const aligned = async () => page.evaluate(() => {
    const widgets = window.__grGuiLayout?.widgets || [];
    return [...document.querySelectorAll('section.gr-spectrum-analyzer')].map(root => {
      const rect = root.getBoundingClientRect();
      const placed = widgets.find(widget => widget.name === root.dataset.blockName);
      if (!placed) return { name: root.dataset.blockName, drift: Infinity };
      return {
        name: root.dataset.blockName,
        drift: Math.max(
          Math.abs(rect.x - placed.rect.x), Math.abs(rect.y - placed.rect.y),
          Math.abs(rect.width - placed.rect.width),
          Math.abs(rect.height - placed.rect.height)),
      };
    });
  });
  const placedNow = await aligned();
  check(placedNow.length === 2 && placedNow.every(entry => entry.drift <= 1),
    `each analyzer sits on its QWidget placeholder (${
      placedNow.map(entry => `${entry.name}:${entry.drift}px`).join(', ')})`);

  // And follows a resize. The wait is deliberately longer than the 3 Hz backstop
  // sweep, so this asserts the report path re-places the overlay at all -- not
  // how quickly. The event filter's latency is not asserted here because pinning
  // it would mean a sub-333 ms deadline, which is exactly the kind of timing
  // assertion that goes flaky on a loaded CI box.
  await page.setViewport({ width: 820, height: 620 });
  await new Promise(resolve => setTimeout(resolve, 600));
  const placedAfterResize = await aligned();
  check(placedAfterResize.length === 2 && placedAfterResize.every(entry => entry.drift <= 1),
    `each analyzer follows a window resize (${
      placedAfterResize.map(entry => `${entry.name}:${entry.drift}px`).join(', ')})`);
  const observation = await page.evaluate(() => {
    const plan = window.__grGuiObservation?.capturePlan('');
    return plan ? {
      widgets: plan.widgets.map(widget => ({ name: widget.name, id: widget.id })),
      layers: plan.layers.map(layer => ({
        provider: layer.provider, widget: layer.widget || '',
        width: layer.source.width, height: layer.source.height,
      })),
    } : null;
  });
  check(observation?.widgets.filter(widget =>
    widget.id === 'wasm_spectrum_analyzer_sink').length === 2,
  'the shared GUI observation service discovers both native widgets');
  check(observation?.layers.filter(layer =>
    layer.provider === 'spectrum-analyzer' && layer.width > 100 && layer.height > 100).length === 2,
  'both native plots register drawable capture layers');
  check(errors.length === 0, `the page reported no errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

if (failures.length) process.exit(1);
console.log('SPECTRUM_ANALYZER_PASS');
