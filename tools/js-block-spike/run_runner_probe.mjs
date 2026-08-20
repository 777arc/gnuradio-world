// Drives the real runner with tools/js-block-spike/js_spike_probe.grc and waits
// for the probe's JS_SPIKE line. Uses the repository server already on :8090.
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../../scripts/browser-test-support.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const PORT = process.argv[2] || '8090';
const grc = readFileSync(ROOT + 'tools/js-block-spike/js_spike_probe.grc', 'utf8');

const browser = await launchBrowser(ROOT);
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(m.text()));
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
await page.goto(`http://localhost:${PORT}/runner/build/runner.html#${encodeURIComponent(grc)}`,
                { waitUntil: 'load', timeout: 30000 });
try {
  await page.waitForFunction(
    () => { const d = document.getElementById('result'); return d && d.dataset.status !== 'pending'; },
    { timeout: 60000, polling: 200 });
} catch {}
const verdict = await page.evaluate(() => document.getElementById('result')?.textContent || '(none)');
console.log('runner verdict:', verdict.trim());

const deadline = Date.now() + 30000;
while (Date.now() < deadline && !logs.some(l => l.includes('JS_SPIKE'))) {
  await new Promise(r => setTimeout(r, 250));
}
const line = logs.find(l => l.includes('JS_SPIKE'));
const stats = await page.evaluate(() => window.__grstats || null);
if (stats) {
  for (const b of JSON.parse(stats).blocks) console.log(`  block ${b.name}: items=${b.items}`);
}
console.log(line ? '\n' + line : '\nno JS_SPIKE line; page logs:\n' + logs.slice(-25).join('\n'));
await browser.close();
process.exit(line && line.includes('JS_SPIKE_RUNNER_PASS') ? 0 : 1);
