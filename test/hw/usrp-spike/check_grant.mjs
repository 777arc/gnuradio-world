import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome } from '../chrome.mjs';
const PROFILE = '/home/marc/gnuradio-world/test/hw/.profile';
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: false, userDataDir: PROFILE,
  args: ['--no-sandbox'], defaultViewport: null,
});
const page = await browser.newPage();
await page.goto('http://localhost:8093/usrp_hw.html',
                { waitUntil: 'domcontentloaded' });
const devs = await page.evaluate(async () =>
  (await navigator.usb.getDevices()).map(d =>
    `${d.productName} vid=${d.vendorId.toString(16)} pid=${d.productId.toString(16)} serial=${d.serialNumber}`));
console.log('AUTHORIZED:', JSON.stringify(devs, null, 2));
await browser.close();
