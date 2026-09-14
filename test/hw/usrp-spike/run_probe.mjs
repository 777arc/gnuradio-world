// Drive the spike page in real Chrome and collect its gate lines.
import puppeteer from 'puppeteer-core';
import { findChrome } from '../chrome.mjs';
const PROFILE = '/home/marc/gnuradio-world/test/hw/.profile';
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: false, userDataDir: PROFILE,
  args: ['--no-sandbox'], defaultViewport: null,
});
const page = await browser.newPage();
page.on('console', m => console.log('  [console]', m.text()));
page.on('pageerror', e => console.log('  [pageerror]', e.message));
await page.goto('http://localhost:8093/usrp_hw.html',
                { waitUntil: 'domcontentloaded' });
await page.waitForFunction('document.getElementById("run") && !document.getElementById("run").disabled',
                           { timeout: 120000 }).catch(() => console.log('  (wasm never became ready)'));
console.log('--- wasm ready, starting probe ---');
await page.click('#run');
const TIMEOUT = Number(process.argv[2] ?? 90000);
await page.waitForFunction('document.getElementById("result").textContent !== ""',
                           { timeout: TIMEOUT })
  .catch(() => console.log(`  (no verdict within ${TIMEOUT}ms - probe did not finish)`));
const lines = await page.evaluate(() => globalThis.__probeLines ?? []);
const verdict = await page.evaluate(() => document.getElementById('result').textContent);
console.log('--- probe lines ---');
for (const l of lines) console.log('  ' + l);
console.log('--- verdict:', verdict || '(none)', '---');
const ticks = await page.evaluate(() => { try { return Module._probe_tick(); } catch { return -1; } });
console.log('--- main-thread ticks at end:', ticks, '---');
await browser.close();
