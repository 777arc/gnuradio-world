// Real-hardware checks for runner/src/sdrplay_worker.js against an SDRplay
// RSP1A/RSP1B/RSP1. Not part of CI. The checks themselves live in
// sdrplay_hw.html (`__runSuite`), because the way this radio actually gets
// tested is by hand from Windows Chrome:
//
//   - an RSP has no USB serial number, so Chrome persists no WebUSB grant for
//     it; every browser session prompts, and grant.mjs cannot pre-authorise it;
//   - usbipd-win breaks transfers on any endpoint of a non-zero alternate
//     setting (dorssel/usbipd-win#530), and the RSP's bulk endpoint is on
//     alternate 3, so the device cannot be forwarded into WSL at all -- native
//     libusb inside WSL fails the same way WebUSB does;
//   - Windows Chrome cannot be driven from WSL, since its DevTools port is on
//     Windows' loopback.
//
// So: start `node server.mjs 8090 "$PWD"`, bind the RSP to WinUSB on Windows
// (Zadig), open http://localhost:8090/test/hw/sdrplay_hw.html in Chrome on
// Windows, click Grant, then a mode button. The page renders the report and
// POSTs each line to the dev server, which appends it to
// test/hw/.reports/<name>.log for whoever is working in WSL.
//
// This driver is the same suite under puppeteer for a Linux desktop where the
// RSP is plugged straight in:
//
//   node test/hw/sdrplay_hw.mjs [--mode basic|rates|bands|gain|notch] [--freq 100.1e6] [--gain 40]

import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { INSTALL_HINT, findChrome } from './chrome.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const PROFILE = join(ROOT, 'test/hw/.profile');
const PAGE = 'http://localhost:8090/test/hw/sdrplay_hw.html';
const executablePath = findChrome();
if (!executablePath) throw new Error(INSTALL_HINT);

const args = process.argv.slice(2);
const at = name => args.indexOf(`--${name}`);
const value = (name, fallback) => at(name) >= 0 ? args[at(name) + 1] : fallback;
const MODE = value('mode', 'basic');
const opts = {
  freq: Number(value('freq', 100.1e6)),
  gain: Number(value('gain', 40)),
  rate: Number(value('rate', 2e6)),
  name: `sdrplay-${MODE}`,
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const browser = await puppeteer.launch({
  executablePath, headless: false, userDataDir: PROFILE,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
page.on('pageerror', error => console.log('  PAGEERROR', error.message));
let result = { failures: 1, lines: [] };
try {
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  const shared = () => page.evaluate(async () =>
    (await navigator.usb.getDevices()).filter(device => device.vendorId === 0x1df7).length);
  if (!await shared()) {
    await page.bringToFront();
    const minutes = Number(value('minutes', 10));
    console.log('  A Chrome window is open: click "Grant device access" and pick the RSP.');
    console.log(`  (an RSP has no serial number, so the grant lasts only this session; waiting up to ${minutes} min)`);
    const deadline = Date.now() + minutes * 60000;
    while (Date.now() < deadline && !await shared().catch(() => 0)) await sleep(1000);
  }
  result = await page.evaluate((mode, o) => window.__runSuite(mode, o), MODE, opts);
  for (const line of result.lines) console.log(line);
} finally {
  await browser.close();
}
process.exit(result.failures ? 1 : 0);
