// Real-hardware checks for runner/src/plutosdr_worker.js. Not part of CI.
// Start `node server.mjs 8090 "$PWD"`, grant once with
// `node test/hw/grant.mjs --pluto`, then run this file.

import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { INSTALL_HINT, findChrome } from './chrome.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const PROFILE = join(ROOT, 'test/hw/.profile');
const PAGE = 'http://localhost:8090/test/hw/plutosdr_hw.html';
const executablePath = findChrome();
if (!executablePath) throw new Error(INSTALL_HINT);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitForStart = async page => {
  try {
    await page.waitForFunction(() => [1, 2].includes(window.__stats().status),
      { timeout: 15000, polling: 100 });
  } catch {
    // Preserve INITIAL in the returned diagnostics when a host USB transport
    // accepts the outbound command but never delivers IIOD's response.
  }
  return page.evaluate(() => window.__stats());
};
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
      device.vendorId === 0x0456 && device.productId === 0xb673).map(device => ({
        name: device.productName, serial: device.serialNumber,
      })));
  check(devices.length > 0, 'a PlutoSDR is shared with this origin',
    JSON.stringify(devices));
  if (!devices.length) throw new Error('run node test/hw/grant.mjs --pluto first');

  await page.evaluate(() => window.__start({ direction: 'rx' }));
  let stats = await waitForStart(page);
  const rxRunning = stats.status === 1 && !stats.error;
  check(rxRunning, 'RX worker reaches RUNNING', stats.error || `state ${stats.status}`);
  if (rxRunning) {
    await sleep(2000);
    stats = await page.evaluate(() => window.__stats());
  }
  check(rxRunning && stats.captured > 0, 'RX samples arrive',
    `${stats.captured} complex samples`);
  check(rxRunning && stats.actualRate > 0, 'RX sample rate is reported',
    `${stats.actualRate} S/s`);
  if (!rxRunning || !stats.captured || !stats.actualRate)
    for (const message of stats.messages.filter(message => message.type === 'trace'))
      console.log(`    ${message.text}`);
  if (rxRunning) {
    const sequence = await page.evaluate(() => window.__retune(2401000000));
    await sleep(500);
    stats = await page.evaluate(() => window.__stats());
    check(stats.acknowledged === sequence, 'live RX retune is acknowledged',
      `${stats.acknowledged}/${sequence}`);
    const rateSequence = await page.evaluate(() => window.__setSampleRate(5000000));
    await sleep(1000);
    stats = await page.evaluate(() => window.__stats());
    check(stats.acknowledged === rateSequence && stats.actualRate === 5000000,
      'live RX sample-rate change is acknowledged',
      `${stats.actualRate} S/s, command ${stats.acknowledged}/${rateSequence}`);
  } else {
    console.log('  [SKIP] live RX retune — RX did not start');
  }
  await page.evaluate(() => window.__stop());
  await sleep(3800);

  if (rxRunning) {
    // This test unit is 1R1T. Dual mode must fail as a capability check, not
    // start with a corrupt two-channel interleave.
    await page.evaluate(() => window.__start({ direction: 'rx', channels: 2 }));
    stats = await waitForStart(page);
    check(/only 1 RX channel/i.test(stats.error), 'unsupported dual RX is rejected',
      stats.error);
    await page.evaluate(() => window.__stop());
    await sleep(500);

    // Exact zero IQ at maximum attenuation exercises WRITEBUF safely.
    await page.evaluate(() => window.__start({ direction: 'tx' }));
    stats = await waitForStart(page);
    const txRunning = stats.status === 1 && !stats.error;
    check(txRunning, 'TX worker reaches RUNNING', stats.error || `state ${stats.status}`);
    if (txRunning) {
      await sleep(2500);
      stats = await page.evaluate(() => window.__stats());
    }
    const progress = stats.messages.find(message =>
      message.type === 'progress' && Number(message.bytes) > 0);
    check(txRunning && !!progress, 'zero-IQ TX buffers reach the Pluto',
      progress ? `${progress.bytes} bytes` : 'no progress message');
    await page.evaluate(() => window.__stop());
    await sleep(3800);
  } else {
    console.log('  [SKIP] dual RX and TX — the host USB transport did not start RX');
  }
} finally {
  await browser.close();
}

console.log(failures ? `\nPlutoSDR HARDWARE: ${failures} FAILED`
  : '\nPlutoSDR HARDWARE: ALL PASS');
process.exit(failures ? 1 : 0);
