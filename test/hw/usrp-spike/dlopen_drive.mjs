import puppeteer from 'puppeteer-core';
import { findChrome } from '../chrome.mjs';
const exe = findChrome(true);
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new',
  args: ['--no-sandbox','--enable-features=SharedArrayBuffer'] });
const page = await browser.newPage();
page.on('console', m => console.log('[console]', m.text().slice(0,300)));
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0,300)));
await page.goto('http://localhost:8090/runner/build/dlopen_test.html', { waitUntil:'domcontentloaded' });
await new Promise(r => setTimeout(r, 25000));
console.log('RESULT:', await page.evaluate(() => document.getElementById('dlresult').textContent));
await browser.close();
