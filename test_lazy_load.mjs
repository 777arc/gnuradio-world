// Self-contained end-to-end test for on-demand category side-module loading.
// Serves wasm/ with COOP/COEP, opens the runner with a flowgraph that uses a
// DEFERRED block (digital_binary_slicer_fb), and verifies: the runner boots,
// digital.wasm is fetched + dlopen'd, the block registers and the graph runs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const ROOT = normalize(new URL('.', import.meta.url).pathname);
const PORT = 8095;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.wasm':'application/wasm', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml' };

const fetched = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('.wasm')) fetched.push(p);
    if (p.endsWith('/')) p += 'index.html';
    const fp = normalize(join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    const body = await readFile(fp);
    res.setHeader('Content-Type', MIME[extname(fp)] || 'application/octet-stream');
    res.writeHead(200); res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, r));

const fg = {
  blocks: [
    { name:'src', id:'analog_sig_source_x', params:{ type:'float', samp_rate:32000, waveform:'cos', frequency:1000, amplitude:1.0 } },
    { name:'thr', id:'blocks_throttle', params:{ type:'float', samp_rate:32000 } },
    { name:'slice', id:'digital_binary_slicer_fb', params:{} },
    { name:'snk', id:'blocks_null_sink', params:{ type:'byte' } },
  ],
  connections: [ ['src',0,'thr',0], ['thr',0,'slice',0], ['slice',0,'snk',0] ],
};
const url = `http://localhost:${PORT}/runner/build/runner.html#` + encodeURIComponent(JSON.stringify(fg));

const base = join(ROOT, 'chrome-headless-shell');
const exe = existsSync(base)
  ? readdirSync(base).map(d => `${base}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync)
  : null;

const browser = await puppeteer.launch({ executablePath: exe, headless: true,
  args: ['--no-sandbox','--disable-gpu','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const logs = [];
try {
  const page = await browser.newPage();
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  let done = false;
  try {
    await page.waitForFunction(
      () => { const d = document.getElementById('result'); return d && d.dataset.status !== 'pending'; },
      { timeout: 40000, polling: 200 });
    done = true;
  } catch {}
  const { status, text } = await page.evaluate(() => {
    const d = document.getElementById('result');
    return { status: d ? d.dataset.status : 'missing', text: d ? d.textContent : '' };
  });
  const mods = await page.evaluate(() => window.__grModules || null);
  console.log('RESULT_STATUS:', status);
  console.log('RESULT_TEXT:', text);
  console.log('MODULES:', JSON.stringify(mods));
  console.log('WASM_FETCHED:', JSON.stringify([...new Set(fetched)]));
  console.log('PAGE_LOGS_TAIL:');
  console.log(logs.slice(-30).join('\n'));
  await browser.close();
  process.exit(text.includes('RUNNER_PASS') ? 0 : 1);
} catch (e) {
  console.log('HARNESS_ERROR:', e.message);
  console.log(logs.slice(-30).join('\n'));
  await browser.close();
  process.exit(2);
}
