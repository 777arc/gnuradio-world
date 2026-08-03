#!/usr/bin/env node
// Reliable browser runner for the GNU Radio WASM phases. Drives Windows Chrome
// (via WSL) with Puppeteer, waits for the page's #result div to leave "pending"
// (real time — Web Workers do real-time CPU work, unlike --virtual-time-budget),
// then prints the RESULT line and optionally saves a screenshot.
//
// Usage: node scripts/run.mjs <url-path> [pass-token] [port] [timeoutMs] [screenshot.png]
import { launchBrowser } from './browser-test-support.mjs';

const [urlPath, token = 'PASS', port = '8090', timeoutMs = '30000', shot] = process.argv.slice(2);
// Full CDP lets us wait on real time for Web Worker computation.
const browser = await launchBrowser(new URL('..', import.meta.url).pathname);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 640 });
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await page.goto(`http://localhost:${port}${urlPath}`, { waitUntil: 'load', timeout: 30000 });

  let status = 'pending', text = '';
  try {
    await page.waitForFunction(
      () => { const d = document.getElementById('result'); return d && d.dataset.status !== 'pending'; },
      { timeout: Number(timeoutMs), polling: 200 });
  } catch { /* fall through to whatever is there */ }
  ({ status, text } = await page.evaluate(() => {
    const d = document.getElementById('result');
    return { status: d ? d.dataset.status : 'missing', text: d ? d.textContent : '' };
  }));

  if (shot) { await page.screenshot({ path: shot }); }
  console.log('RUN', urlPath, '->', text || '(no #result)');
  if (logs.length) console.log('--- page logs (tail) ---\n' + logs.slice(-25).join('\n'));
  await browser.close();
  process.exit(text.includes(token) ? 0 : 1);
} catch (e) {
  console.error('RUN error:', e.message);
  await browser.close();
  process.exit(3);
}
