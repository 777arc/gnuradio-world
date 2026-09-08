#!/usr/bin/env node
// Browser acceptance test for the actual hosted ADS-B recording example. This
// intentionally stays out of the default suite: it streams a large public IQ
// recording and therefore depends on network availability. Run it after a map
// or ADS-B decoder change with: node test/test_adsb_map.mjs
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
  ['runner/build/adsb_map.js', 'build the runner after adding ADS-B Map'],
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
  console.error(`ADS-B map test needs the repository server on port ${PORT}: ` +
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
      (element.textContent || '').includes('ADS-B from a Recording'));
    for (let parent = leaf?.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    return leaf?.closest('.ex-row')?.querySelector('.ex-item') || leaf;
  });
  if (!entry.asElement()) throw new Error('ADS-B recording example is not listed');
  await entry.asElement().click();
  await new Promise(resolve => setTimeout(resolve, 1800));

  const canvasBlockCount = await page.evaluate(() => document.querySelectorAll('#nodes > *').length);
  check(canvasBlockCount === 15,
    'adsb_recording.grc loads with the new map block', String(canvasBlockCount));
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
  await runner.waitForFunction(() => {
    try {
      const map = JSON.parse(globalThis.__grReadPlotData?.('aircraft_map', 32) || '{}')
        .widgets?.[0];
      return map?.aircraft_total >= 1 && map.aircraft.some(aircraft =>
        aircraft.icao === 'A02C40' || aircraft.icao === 'AD44BC');
    } catch { return false; }
  }, { timeout: 45000, polling: 250 });

  const observed = await runner.evaluate(() => {
    const plot = JSON.parse(globalThis.__grReadPlotData('aircraft_map', 32)).widgets[0];
    const root = document.querySelector('.gr-adsb-map[data-block-name="aircraft_map"]');
    const rows = [...root.querySelectorAll('.gr-adsb-aircraft-row')]
      .map(row => row.textContent.replace(/\s+/g, ' ').trim());
    const status = root.querySelector('.gr-adsb-map-status')?.textContent || '';
    const mapCanvas = root.querySelector('.maplibregl-canvas');
    const mapStyle = document.querySelector('link[data-gr-adsb-maplibre-style]');
    const capture = globalThis.__grGuiObservation.capturePlan('aircraft_map');
    const layout = globalThis.__grGuiLayout?.widgets?.find(widget => widget.name === 'aircraft_map');
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
  const a02c40 = observed.plot.aircraft.find(aircraft => aircraft.icao === 'A02C40');
  const ad44bc = observed.plot.aircraft.find(aircraft => aircraft.icao === 'AD44BC');
  check(observed.plot.kind === 'map' && observed.plot.aircraft_total >= 1,
    'semantic observation reports the ADS-B map and a decoded recording aircraft');
  if (a02c40) check((a02c40.altitude_ft == null ||
    (a02c40.altitude_ft >= 15000 && a02c40.altitude_ft <= 16000)) &&
    a02c40.speed_kt >= 340 && a02c40.speed_kt <= 345 &&
    a02c40.course_true >= 123 && a02c40.course_true <= 125 &&
    a02c40.vertical_rate_ft_min >= -2100 && a02c40.vertical_rate_ft_min <= -1900 &&
    a02c40.df === 17,
  'A02C40 shows the recording\'s available altitude, speed, true course, descent, and DF',
  JSON.stringify(a02c40));
  if (ad44bc) check((ad44bc.altitude_ft == null ||
    (ad44bc.altitude_ft >= 11000 && ad44bc.altitude_ft <= 12000)) &&
    ad44bc.speed_kt >= 299 && ad44bc.speed_kt <= 304 &&
    ad44bc.course_true >= 225 && ad44bc.course_true <= 229 &&
    ad44bc.vertical_rate_ft_min >= 2200 && ad44bc.vertical_rate_ft_min <= 2800 &&
    ad44bc.df === 17,
  'AD44BC shows the recording\'s speed, converted true course, climb rate, and DF',
  JSON.stringify(ad44bc));
  check([a02c40, ad44bc].some(Boolean),
    'the recording produced one of its known aircraft records');
  check(observed.plot.aircraft.every(aircraft =>
    observed.rows.some(row => row.includes(aircraft.icao))),
  'the visible aircraft list contains every observed decoder record', JSON.stringify(observed.rows));
  check(observed.mapReady && observed.mapStyleReady && observed.captureLayers >= 2,
    'MapLibre CSS, map, and drawable aircraft overlay are live and captureable');
  check(observed.layoutAligned, 'the browser map is aligned to its GUI Layout tile');
  check(new RegExp(`${observed.plot.positioned_aircraft} positioned / ${observed.plot.aircraft_total} tracked`)
    .test(observed.status), 'status distinguishes positioned and unpositioned aircraft', observed.status);

  const selectedAircraft = a02c40 || ad44bc;
  await runner.click(`.gr-adsb-aircraft-row[data-icao="${selectedAircraft.icao}"]`);
  const selection = await runner.evaluate(() => ({
    details: document.querySelector('.gr-adsb-aircraft-details')?.textContent || '',
    selected: JSON.parse(globalThis.__grReadPlotData('aircraft_map', 32))
      .widgets[0].selected_icao,
  }));
  check(selection.selected === selectedAircraft.icao &&
    selection.details.includes(selectedAircraft.icao) &&
    selection.details.includes(`${Math.round(selectedAircraft.speed_kt)} kt`) &&
    selection.details.includes(`${Math.round(selectedAircraft.course_true)}° true`),
  `selecting ${selectedAircraft.icao} opens the correct detail card`, selection.details);
  if (process.env.ADSB_MAP_SCREENSHOT) {
    const mapElement = await runner.$('.gr-adsb-map[data-block-name="aircraft_map"]');
    await mapElement.screenshot({ path: process.env.ADSB_MAP_SCREENSHOT });
    console.log(`wrote ${process.env.ADSB_MAP_SCREENSHOT}`);
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

console.log(failures.length ? `ADS-B_MAP_FAIL (${failures.length})` : 'ADS-B_MAP_PASS');
process.exit(failures.length ? 1 : 0);
