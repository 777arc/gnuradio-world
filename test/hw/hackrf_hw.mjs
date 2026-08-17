// Receive-only hardware checks for runner/src/hackrf_worker.js. Not part of CI.
// Start `node server.mjs 8090 "$PWD"`, grant once with
// `node test/hw/grant.mjs --hackrf`, then run this file.

import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { INSTALL_HINT, findChrome } from './chrome.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const PROFILE = join(ROOT, 'test/hw/.profile');
const PAGE = 'http://localhost:8090/test/hw/hackrf_hw.html';
const executablePath = findChrome();
if (!executablePath) throw new Error(INSTALL_HINT);

const args = process.argv.slice(2);
const at = name => args.indexOf(`--${name}`);
const number = (name, fallback) => at(name) >= 0 ? Number(args[at(name) + 1]) : fallback;
const CENTER = number('freq', 100.1e6);
const RATES = args.includes('--all-rates')
  ? [2e6, 8e6, 10e6, 20e6]
  : [number('rate', 10e6)];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '  [OK]  ' : '  [FAIL]'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ++failures;
};

const browser = await puppeteer.launch({
  executablePath, headless: false, userDataDir: PROFILE,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
page.on('pageerror', error => console.log('  PAGEERROR', error.message));

try {
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  const devices = await page.evaluate(async () =>
    (await navigator.usb.getDevices()).filter(device =>
      device.vendorId === 0x1d50 && device.productId === 0x6089).map(device => ({
        name: device.productName, serial: device.serialNumber,
      })));
  check(devices.length > 0, 'a HackRF is shared with this origin', JSON.stringify(devices));
  if (!devices.length) throw new Error('run node test/hw/grant.mjs --hackrf first');

  for (const rate of RATES) {
    await page.evaluate((sampleRate, centerFreq) =>
      window.__start({ sampleRate, centerFreq }), rate, CENTER);
    await sleep(2500);
    let stats = await page.evaluate(() => window.__stats());
    const running = stats.status === 1 && !stats.error;
    check(running, `RX reaches RUNNING at ${rate / 1e6} MS/s`,
      stats.error || `state ${stats.status}`);
    check(running && stats.capturedPairs > 0, 'RX samples arrive',
      `${stats.capturedPairs.toLocaleString()} IQ pairs`);
    check(running && stats.nonzeroBytes > 0, 'received IQ is not an all-zero buffer',
      `${stats.nonzeroBytes.toLocaleString()} nonzero inspected bytes`);
    check(running && stats.actualRate === rate, 'sample rate is reported',
      `${stats.actualRate} S/s`);
    if (!running) for (const line of stats.trace) console.log(`    ${line}`);

    if (running) {
      const sequence = await page.evaluate(hz => window.__retune(hz), CENTER + 300000);
      await sleep(600);
      stats = await page.evaluate(() => window.__stats());
      check(!stats.error && stats.acknowledged === sequence, 'live retune is acknowledged',
        `${stats.acknowledged}/${sequence}${stats.error ? `; ${stats.error}` : ''}`);
    }

    await page.evaluate(() => window.__stop());
    await sleep(1500);
  }

  // A second open catches a worker that stopped streaming but failed to
  // release interface 0 or return the transceiver to OFF.
  const reopenRate = RATES[0];
  await page.evaluate((sampleRate, centerFreq) =>
    window.__start({ sampleRate, centerFreq }), reopenRate, CENTER);
  await sleep(1800);
  const reopened = await page.evaluate(() => window.__stats());
  check(reopened.status === 1 && !reopened.error && reopened.capturedPairs > 0,
    'the HackRF reopens after stop', reopened.error ||
      `${reopened.capturedPairs.toLocaleString()} IQ pairs`);
  await page.evaluate(() => window.__stop());
  await sleep(1300);
} finally {
  await browser.close();
}

console.log(failures ? `\nHackRF HARDWARE: ${failures} FAILED` : '\nHackRF HARDWARE: ALL PASS');
process.exit(failures ? 1 : 0);
