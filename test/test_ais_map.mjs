#!/usr/bin/env node
// Browser acceptance test for the hosted AIS recording example with its map.
// Like test_adsb_map.mjs it stays out of the default suite: it streams a large
// public IQ recording and so depends on network availability. Run it after a
// map or gr-ais change with: node test/test_ais_map.mjs
import { stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import {
  dismissUnpacedRunWarning,
  launchBrowser,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || 8090);
for (const [path, hint] of [
  ['editor/dist/index.html', 'build the editor'],
  ['runner/build/runner.js', 'build the runner'],
  ['runner/build/ais_map.js', 'build the runner after adding AIS Map'],
]) {
  if (!await stat(join(ROOT, path)).catch(() => null)) {
    console.log(`SKIP: missing ${path} -- ${hint}`);
    process.exit(0);
  }
}
try {
  const response = await fetch(`http://localhost:${PORT}/`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(`AIS map test needs the repository server on port ${PORT}: ` +
    `node server.mjs ${PORT} "$PWD" (${error.message})`);
  process.exit(2);
}

const failures = [];
const check = (condition, message, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}${!condition && detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(message);
};

const browser = await launchBrowser(ROOT);
let page;
try {
  page = await browser.newPage();
  await dismissUnpacedRunWarning(page);
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${PORT}/?challenges=unlocked`,
    { waitUntil: 'networkidle2', timeout: 60000 });

  const exampleTab = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')]
      .find(button => /Example Flowgraphs/.test(button.textContent || '')));
  await exampleTab.asElement().click();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const entry = await page.evaluateHandle(() => {
    const leaf = [...document.querySelectorAll('div')].find(element =>
      element.children.length === 0 &&
      (element.textContent || '').trim() === 'AIS Receiver');
    for (let parent = leaf?.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    return leaf?.closest('.ex-row')?.querySelector('.ex-item') || leaf;
  });
  if (!entry.asElement()) throw new Error('AIS Receiver example is not listed');
  await entry.asElement().click();
  await new Promise(resolve => setTimeout(resolve, 1800));

  const canvasBlockCount = await page.evaluate(() => document.querySelectorAll('#nodes > *').length);
  check(canvasBlockCount === 21,
    'ais_receiver.grc loads with the map block', String(canvasBlockCount));
  const run = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')]
      .find(button => (button.textContent || '').trim() === '▶'));
  await run.asElement().click();

  await page.waitForFunction(() => [...document.querySelectorAll('iframe')]
    .some(frame => /runner\.html/.test(frame.src)), { timeout: 30000 });
  const runner = page.frames().find(frame => /runner\.html/.test(frame.url()));
  if (!runner) throw new Error('runner iframe did not appear');
  await runner.waitForFunction(() =>
    document.getElementById('result')?.dataset.status === 'pass',
  { timeout: 60000, polling: 200 });
  // The recording's first reports are Thames-estuary class A vessels; wait
  // for a couple of them to be positioned, on either channel.
  await runner.waitForFunction(() => {
    try {
      const map = JSON.parse(globalThis.__grReadPlotData?.('vessel_map', 64) || '{}')
        .widgets?.[0];
      return map?.positioned_vessels >= 2;
    } catch { return false; }
  }, { timeout: 90000, polling: 250 });

  const observed = await runner.evaluate(() => {
    const plot = JSON.parse(globalThis.__grReadPlotData('vessel_map', 64)).widgets[0];
    const root = document.querySelector('.gr-ais-map[data-block-name="vessel_map"]');
    const rows = [...root.querySelectorAll('.gr-ais-vessel-row')]
      .map(row => row.textContent.replace(/\s+/g, ' ').trim());
    const status = root.querySelector('.gr-ais-map-status')?.textContent || '';
    const mapCanvas = root.querySelector('.maplibregl-canvas');
    const mapStyle = document.querySelector(
      'link[data-gr-ais-maplibre-style], link[data-gr-adsb-maplibre-style]');
    const capture = globalThis.__grGuiObservation.capturePlan('vessel_map');
    const layout = globalThis.__grGuiLayout?.widgets?.find(widget => widget.name === 'vessel_map');
    const rect = root.getBoundingClientRect();
    return {
      plot, rows, status,
      mapReady: !!mapCanvas && mapCanvas.width > 0 && mapCanvas.height > 0,
      mapStyleReady: !!mapStyle?.sheet,
      captureLayers: capture.layers.length,
      layoutAligned: !!layout?.rect && Math.abs(rect.x - layout.rect.x) < 2 &&
        Math.abs(rect.y - layout.rect.y) < 2 &&
        Math.abs(rect.width - layout.rect.width) < 2 &&
        Math.abs(rect.height - layout.rect.height) < 2,
    };
  });
  check(observed.plot.kind === 'map' && observed.plot.vessel_total >= 2,
    'semantic observation reports the AIS map and decoded vessels');
  const positioned = observed.plot.vessels.filter(vessel =>
    Number.isFinite(vessel.latitude) && Number.isFinite(vessel.longitude));
  check(positioned.every(vessel =>
    vessel.latitude > 51.2 && vessel.latitude < 51.7 &&
    vessel.longitude > -0.2 && vessel.longitude < 1.2),
  'every positioned vessel lies on the Thames estuary the recording was made over',
  JSON.stringify(positioned.map(vessel => [vessel.mmsi, vessel.latitude, vessel.longitude])));
  check(positioned.every(vessel => /^\d{9}$/.test(vessel.mmsi) &&
    (vessel.kind === 'A' || vessel.kind === 'B' || vessel.kind === 'base' || vessel.kind === 'aton')),
  'vessels carry nine-digit MMSIs and a station class', JSON.stringify(positioned.map(v => [v.mmsi, v.kind])));
  check(observed.plot.messages_decoded >= observed.plot.vessel_total &&
    observed.plot.messages_rejected === 0,
  'every packet the deframer passed decoded as an AIS message',
  `${observed.plot.messages_decoded} decoded, ${observed.plot.messages_rejected} rejected`);
  check(observed.plot.vessels.every(vessel =>
    observed.rows.some(row => row.includes(vessel.mmsi) || (vessel.name && row.includes(vessel.name)))),
  'the visible vessel list contains every observed record', JSON.stringify(observed.rows));
  check(observed.mapReady && observed.mapStyleReady && observed.captureLayers >= 2,
    'MapLibre CSS, map, and drawable vessel overlay are live and captureable');
  check(observed.layoutAligned, 'the browser map is aligned to its GUI Layout tile');
  check(new RegExp(`${observed.plot.positioned_vessels} positioned / ${observed.plot.vessel_total} tracked`)
    .test(observed.status), 'status distinguishes positioned and unpositioned vessels', observed.status);

  const selectedVessel = positioned[0];
  await runner.click(`.gr-ais-vessel-row[data-mmsi="${selectedVessel.mmsi}"]`);
  const selection = await runner.evaluate(() => ({
    details: document.querySelector('.gr-ais-vessel-details')?.textContent || '',
    selected: JSON.parse(globalThis.__grReadPlotData('vessel_map', 64))
      .widgets[0].selected_mmsi,
  }));
  check(selection.selected === selectedVessel.mmsi &&
    selection.details.includes(selectedVessel.mmsi) &&
    selection.details.includes(selectedVessel.latitude.toFixed(5)),
  `selecting ${selectedVessel.mmsi} opens the correct detail card`, selection.details);
  if (process.env.AIS_MAP_SCREENSHOT) {
    const mapElement = await runner.$('.gr-ais-map[data-block-name="vessel_map"]');
    await mapElement.screenshot({ path: process.env.AIS_MAP_SCREENSHOT });
    console.log(`wrote ${process.env.AIS_MAP_SCREENSHOT}`);
  }
  check(errors.length === 0, 'the example produced no uncaught browser errors', errors.join('; '));
} catch (error) {
  failures.push(error.message);
  console.error('FAIL', error);
  if (page) {
    const diagnostic = await page.evaluate(() => ({
      log: document.getElementById('log')?.textContent || '',
      frames: [...document.querySelectorAll('iframe')].map(frame => frame.src),
      dialogs: [...document.querySelectorAll('[role="dialog"], dialog')]
        .map(dialog => dialog.textContent?.trim()).filter(Boolean),
    })).catch(() => null);
    if (diagnostic) console.error('browser state', JSON.stringify(diagnostic, null, 2));
  }
} finally {
  await browser.close();
}

console.log(failures.length ? `AIS_MAP_FAIL (${failures.length})` : 'AIS_MAP_PASS');
process.exit(failures.length ? 1 : 0);
