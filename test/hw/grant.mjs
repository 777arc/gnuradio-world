// One-time WebUSB grant for the hardware harness.
//
//   node test/hw/grant.mjs
//
// Opens a real Chrome window (WSLg) on the harness page and waits for you to
// press "Grant device access" and pick the dongle. WebUSB permission is stored
// per profile, so once this succeeds every later run of
// test/hw/rtlsdr_hw.mjs reuses test/hw/.profile and needs no chooser.
//
// This exists because CDP's DeviceAccess domain, which is the documented way to
// automate the chooser, produces no prompt event in this environment -- neither
// headless nor headful. Granting by hand once sidesteps it entirely.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('../..', import.meta.url).pathname;
const PROFILE = join(ROOT, 'test/hw/.profile');
const PAGE = 'http://localhost:8090/test/hw/rtlsdr_hw.html';

function findChrome() {
  const full = join(ROOT, 'chrome-for-testing', 'chrome');
  if (!existsSync(full)) return null;
  for (const version of readdirSync(full).sort().reverse()) {
    const candidate = join(full, version, 'chrome-linux64', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const executablePath = findChrome();
if (!executablePath) {
  console.error('Install Chrome first:\n' +
    '  npx @puppeteer/browsers install chrome@stable --path ./chrome-for-testing');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: false,
  userDataDir: PROFILE,
  args: ['--no-sandbox'],
  defaultViewport: null,
});
const page = (await browser.pages())[0] ?? await browser.newPage();
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

const at = process.argv.indexOf('--minutes');
const MINUTES = at >= 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : 15;

console.log('A Chrome window should be open on your desktop.');
console.log('Click "Grant device access", pick the RTL-SDR, and press Connect.');
console.log(`Waiting up to ${MINUTES} minutes (--minutes N to change)…`);
console.log('Also worth noting: whether a chooser dialog appears AT ALL is the ' +
            'answer we need. If none does, say so and we stop here.');

const deadline = Date.now() + MINUTES * 60000;
let granted = [];
let announced = 0;
while (Date.now() < deadline) {
  granted = await page.evaluate(async () => {
    if (!navigator.usb) return null;
    return (await navigator.usb.getDevices())
      .map(d => `${d.productName ?? '(unnamed)'} serial=${d.serialNumber ?? '(none)'}`);
  }).catch(() => []);
  if (granted && granted.length) break;
  const waited = Math.floor((Date.now() - (deadline - MINUTES * 60000)) / 60000);
  if (waited > announced) { announced = waited; console.log(`  …${waited} min`); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}

if (granted && granted.length) {
  console.log(`\nGRANTED: ${granted.join(', ')}`);
  console.log(`Stored in ${PROFILE} — hardware runs will reuse it.`);
} else {
  console.log('\nNO GRANT: no device is shared with this origin.');
  console.log('If no chooser dialog appeared at all, the WebUSB chooser does not ' +
              'work in this environment and this route is a dead end.');
}
await browser.close();
process.exit(granted && granted.length ? 0 : 1);
