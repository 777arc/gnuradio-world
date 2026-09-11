// One-time WebUSB grant for the USRP B2xx spike, mirroring test/hw/grant.mjs.
// Folding this into grant.mjs as `--usrp-b2xx` is the productionization step;
// kept separate here so the spike touches no existing harness file.
import puppeteer from 'puppeteer-core';
import { INSTALL_HINT, findChrome } from '../chrome.mjs';

const PROFILE = '/home/marc/gnuradio-world/test/hw/.profile';
const PAGE = 'http://localhost:8093/usrp_hw.html';
const executablePath = findChrome();
if (!executablePath) { console.error(INSTALL_HINT); process.exit(1); }

const browser = await puppeteer.launch({
  executablePath, headless: false, userDataDir: PROFILE,
  // WSLg: without an explicit size/position Chrome can map a window that the
  // compositor shows in the taskbar but never actually renders. Forcing X11
  // (both DISPLAY and WAYLAND_DISPLAY are set here) avoids the Wayland path.
  args: [
    '--no-sandbox',
    '--ozone-platform=x11',
    '--window-size=1280,900',
    '--window-position=60,60',
    // A taskbar entry with nothing rendered is the WSLg symptom of GPU
    // compositing failing after the window is already mapped.
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-features=VizDisplayCompositor',
  ],
  defaultViewport: null,
});
const page = await browser.newPage();
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
await page.bringToFront();

const at = process.argv.indexOf('--minutes');
const MINUTES = at >= 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : 20;
console.log('Chrome is open on your desktop.');
console.log('Click "Grant device access" and pick the USRP B210.');
console.log(`Waiting up to ${MINUTES} minutes…`);

const deadline = Date.now() + MINUTES * 60000;
let granted = [];
while (Date.now() < deadline) {
  granted = await page.evaluate(async () => {
    if (!navigator.usb) return null;
    return (await navigator.usb.getDevices()).map(d =>
      `${d.productName ?? '(unnamed)'} vid=${d.vendorId.toString(16)} ` +
      `pid=${d.productId.toString(16)} serial=${d.serialNumber ?? '(none)'}`);
  }).catch(() => []);
  if (granted && granted.length) break;
  await new Promise(r => setTimeout(r, 1000));
}
if (granted && granted.length) console.log(`\nGRANTED: ${granted.join(', ')}`);
else console.log('\nNO GRANT.');
await browser.close();
process.exit(granted && granted.length ? 0 : 1);
