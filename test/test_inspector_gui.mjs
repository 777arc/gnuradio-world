// End-to-end browser test for gr-inspector's Qt GUI Sink rebuild. It loads the
// real example through the editor, checks the live Qwt curve, then drives the
// canvas-only Manual checkbox and band drag and verifies the native map_out
// messages that reach Message Debug.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import {
  contentType,
  dismissUnpacedRunWarning,
  dismissWelcomePopup,
  launchBrowser,
  setIsolationHeaders,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8113);
for (const [path, hint] of [
  ['editor/dist/index.html', 'run `npm run build` in editor/'],
  ['runner/build/runner.js', 'build the runner'],
]) {
  if (!await stat(join(ROOT, path)).catch(() => null)) {
    console.log(`SKIP: missing ${path} -- ${hint}`);
    process.exit(0);
  }
}

const server = http.createServer(async (request, response) => {
  setIsolationHeaders(response);
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    if (pathname === '/example_flowgraphs' || pathname === '/example_flowgraphs/') {
      response.setHeader('Content-Type', 'application/json');
      response.writeHead(200);
      return response.end('[]');
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const direct = normalize(join(ROOT, pathname));
    if (!direct.startsWith(ROOT)) {
      response.writeHead(403);
      return response.end();
    }
    const filename = await stat(direct).then(value => value.isFile()).catch(() => false)
      ? direct : normalize(join(ROOT, 'editor', 'dist', pathname));
    const body = await readFile(filename);
    response.setHeader('Content-Type', contentType(filename));
    response.writeHead(200);
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise(resolve => server.listen(PORT, resolve));

const failures = [];
const check = (condition, message, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(message);
};

const mapPattern = /#\(#\[(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\]\)/g;
const mapsIn = text => [...text.matchAll(mapPattern)].map(match => ({
  center: Number(match[1]),
  bandwidth: Number(match[2]),
}));

const browser = await launchBrowser(ROOT);
try {
  const page = await browser.newPage();
  await dismissUnpacedRunWarning(page);
  await dismissWelcomePopup(page);
  await page.setViewport({ width:1200, height:800 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(
    `http://localhost:${PORT}/#example=gr-inspector/signal_detector`,
    { waitUntil:'networkidle2', timeout:60000 },
  );
  await page.waitForFunction(() => document.querySelectorAll('#nodes > *').length === 11,
    { timeout:30000, polling:100 });
  const run = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')]
      .find(button => (button.textContent || '').trim() === '▶'));
  if (!run.asElement()) throw new Error('Run button not found');
  await run.asElement().click();
  await page.waitForSelector('#runFrame', { timeout:30000 });

  let runnerFrame;
  const frameDeadline = Date.now() + 30000;
  while (!runnerFrame && Date.now() < frameDeadline) {
    runnerFrame = page.frames().find(frame => /runner\.html/.test(frame.url()));
    if (!runnerFrame) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!runnerFrame) throw new Error('runner iframe did not appear');
  await runnerFrame.waitForFunction(() =>
    document.getElementById('result')?.dataset.status === 'pass',
  { timeout:60000, polling:200 });
  await runnerFrame.waitForFunction(() => {
    try {
      return JSON.parse(window.__grReadPlotData?.('', 64) || '{}').widgets
        ?.some(widget => widget.curves?.some(curve => curve.points >= 1024));
    } catch { return false; }
  }, { timeout:30000, polling:200 });

  const plots = await runnerFrame.evaluate(() =>
    JSON.parse(window.__grReadPlotData?.('', 64) || '{}'));
  const plot = plots.widgets?.find(widget =>
    widget.curves?.some(curve => curve.points >= 1024));
  const curve = plot?.curves?.find(candidate => candidate.points >= 1024);
  check(Boolean(plot && curve), 'Inspector GUI exposes its live Qwt spectrum');
  check(Math.abs((curve?.peak?.x ?? Infinity) - 8000) < 100,
    'spectrum peak is at the example tone frequency', `${curve?.peak?.x} Hz`);

  const paneText = () => page.$eval('#log', element => element.textContent || '');
  const waitForMaps = async (minimum, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    let maps = [];
    do {
      maps = mapsIn(await paneText());
      if (maps.length >= minimum) return maps;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return maps;
  };

  let maps = await waitForMaps(1, 5000);
  check(maps.some(map => Math.abs(map.center - 8000) < 100 && map.bandwidth < 1000),
    'automatic detector map passes through map_out');

  const frameRect = await page.$eval('#runFrame', frame =>
    frame.getBoundingClientRect().toJSON());
  const automaticCount = maps.length;
  await page.mouse.click(frameRect.x + 18, frameRect.y + 18);
  maps = await waitForMaps(automaticCount + 1);
  const selected = maps[automaticCount];
  check(Boolean(selected && Math.abs(selected.center) < 100 && selected.bandwidth > 10000),
    'enabling Manual publishes the initial visible band',
    selected ? `${selected.center} Hz, ${selected.bandwidth} Hz wide` : 'no map');

  const dragX = frameRect.x + frameRect.width / 2;
  const dragY = frameRect.y + frameRect.height * 0.52;
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX - 100, dragY, { steps:10 });
  await page.mouse.up();
  maps = await waitForMaps(automaticCount + 2);
  const dragged = maps[automaticCount + 1];
  check(Boolean(dragged && selected &&
                Math.abs(dragged.center - selected.center) > 1000 &&
                Math.abs(dragged.bandwidth - selected.bandwidth) < 10),
    'dragging the manual band publishes its new center and preserves bandwidth',
    dragged ? `${dragged.center} Hz, ${dragged.bandwidth} Hz wide` : 'no map');

  await page.mouse.click(frameRect.x + 18, frameRect.y + 18);
  maps = await waitForMaps(automaticCount + 3);
  const resumed = maps[automaticCount + 2];
  check(Boolean(resumed && Math.abs(resumed.center - 8000) < 100 && resumed.bandwidth < 1000),
    'disabling Manual republishes the latest automatic detector map',
    resumed ? `${resumed.center} Hz, ${resumed.bandwidth} Hz wide` : 'no map');
  check(errors.length === 0, 'browser reported no page errors', errors.join('; '));
} catch (error) {
  check(false, 'Inspector GUI browser test completed', error.message);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(failures.length ? 'INSPECTOR_GUI_FAIL' : 'INSPECTOR_GUI_PASS');
process.exit(failures.length ? 1 : 0);
