// End-to-end browser test for the GNU Radio World Spectrum Analyzer. It drives
// both input types through the built runner, checks numeric plot observation,
// exercises box zoom and zoom history, and verifies that real input has no
// negative frequency half.
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
  await page.waitForFunction(() => {
    try {
      const widgets = JSON.parse(window.__grReadPlotData?.('', 32) || '{}').widgets || [];
      return widgets.length === 2 && widgets.every(widget =>
        Number.isFinite(widget.detection?.threshold) && widget.detected_signals?.length > 0);
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
  check([complex, real].every(widget => widget?.detection?.threshold_source === 'automatic' &&
    widget.detection.required_samples === 10000 &&
    widget.detection.estimator === 'corrected_lower_tail' &&
    widget.detection.estimator_percentile === 20 &&
    Number.isFinite(widget.detection.noise_floor) && widget.detection.margin_db === 6),
  'both analyzers learn a corrected lower-tail noise floor from 10,000 bins plus 6 dB');
  check(complex?.detected_signals?.some(signal =>
    Math.abs(signal.peak_frequency - 12000) < 30 && signal.occupied_bandwidth_99 > 0),
  'automatic detection measures the complex carrier and its 99% bandwidth');
  check(real?.detected_signals?.some(signal =>
    Math.abs(signal.peak_frequency - 9375) < 30 && signal.occupied_bandwidth_99 > 0),
  'automatic detection measures the real carrier and its 99% bandwidth');
  check([complex, real].every(widget => widget?.detected_signals?.every(signal =>
    Number.isInteger(signal.id) && Number.isFinite(signal.center_frequency) &&
    Number.isFinite(signal.peak_frequency) && Number.isFinite(signal.peak_level) &&
    Number.isFinite(signal.occupied_bandwidth_99))),
  'numeric plot observation exposes every signal annotation as raw numbers');

  await page.evaluate(() => {
    const first = document.querySelector('.gr-spectrum-analyzer');
    const threshold = first?.querySelector('input[aria-label="Threshold"]');
    if (threshold) {
      threshold.value = '-20';
      threshold.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  plots = await page.evaluate(() => JSON.parse(window.__grReadPlotData('', 32)));
  const manuallyThresholded = plots.widgets.find(widget => widget.name === 'complex_analyzer');
  check(manuallyThresholded?.detection?.threshold === -20 &&
    manuallyThresholded.detection.threshold_source === 'manual',
  'the running GUI can override the automatic detection threshold');

  const toolbarState = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('.gr-spectrum-analyzer button')]
      .map(button => button.textContent),
    cursors: [...document.querySelectorAll('canvas.gr-spectrum-analyzer-plot')]
      .map(canvas => getComputedStyle(canvas).cursor),
  }));
  const removedControls = ['Peak Search', 'Track Peak', 'Marker', 'Detect'];
  check(removedControls.every(label => !toolbarState.buttons.includes(label)) &&
    !toolbarState.buttons.some(label => label.startsWith('OBW ')),
  'peak, marker, OBW, and detector toggle buttons are absent');
  check(toolbarState.cursors.every(cursor => cursor === 'zoom-in') &&
    plots.widgets.every(widget => widget.detection?.enabled === true),
  'automatic detection is always on and box zoom is the default cursor mode');

  const initialComplexAxes = {
    x: { ...manuallyThresholded.x_axis }, y: { ...manuallyThresholded.y_axis },
  };
  const zoomBox = await page.evaluate(() => {
    const canvas = document.querySelector(
      '.gr-spectrum-analyzer[data-block-name="complex_analyzer"] canvas');
    const bounds = canvas.getBoundingClientRect();
    const plot = { left: bounds.left + 62, right: bounds.right - 14,
      top: bounds.top + 16, bottom: bounds.bottom - 34 };
    return {
      x1: plot.left + (plot.right - plot.left) * 0.25,
      y1: plot.top + (plot.bottom - plot.top) * 0.2,
      x2: plot.left + (plot.right - plot.left) * 0.75,
      y2: plot.top + (plot.bottom - plot.top) * 0.7,
      centerX: (plot.left + plot.right) / 2,
      centerY: (plot.top + plot.bottom) / 2,
    };
  });
  await page.mouse.move(zoomBox.x1, zoomBox.y1);
  await page.mouse.down();
  await page.mouse.move(zoomBox.x2, zoomBox.y2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const widgets = JSON.parse(window.__grReadPlotData?.('', 32) || '{}').widgets || [];
    return widgets.find(widget => widget.name === 'complex_analyzer')?.zoom_depth === 1;
  });
  plots = await page.evaluate(() => JSON.parse(window.__grReadPlotData('', 32)));
  const zoomed = plots.widgets.find(widget => widget.name === 'complex_analyzer');
  const initialXSpan = initialComplexAxes.x.max - initialComplexAxes.x.min;
  const initialYSpan = initialComplexAxes.y.max - initialComplexAxes.y.min;
  check(zoomed.zoom_depth === 1 &&
    Math.abs((zoomed.x_axis.max - zoomed.x_axis.min) / initialXSpan - 0.5) < 0.03 &&
    Math.abs((zoomed.y_axis.max - zoomed.y_axis.min) / initialYSpan - 0.5) < 0.03,
  'left-drag zooms the selected frequency and level rectangle');
  await page.mouse.click(zoomBox.centerX, zoomBox.centerY, { button: 'right' });
  await page.waitForFunction(() => {
    const widgets = JSON.parse(window.__grReadPlotData?.('', 32) || '{}').widgets || [];
    return widgets.find(widget => widget.name === 'complex_analyzer')?.zoom_depth === 0;
  });
  plots = await page.evaluate(() => JSON.parse(window.__grReadPlotData('', 32)));
  const restored = plots.widgets.find(widget => widget.name === 'complex_analyzer');
  check(restored.x_axis.min === initialComplexAxes.x.min &&
    restored.x_axis.max === initialComplexAxes.x.max &&
    restored.y_axis.min === initialComplexAxes.y.min &&
    restored.y_axis.max === initialComplexAxes.y.max,
  'right-click restores exactly one saved zoom level');
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
