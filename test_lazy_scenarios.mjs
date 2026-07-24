// Multi-scenario verification of on-demand category loading.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const ROOT = normalize(new URL('.', import.meta.url).pathname);
const PORT = 8096;
const MIME = { '.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.svg':'image/svg+xml' };
let fetched = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  try {
    let p = decodeURIComponent(new URL(req.url,'http://x').pathname);
    if (p.endsWith('.wasm')) fetched.push(p.split('/').pop());
    if (p.endsWith('/')) p += 'index.html';
    const fp = normalize(join(ROOT,p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const b = await readFile(fp);
    res.setHeader('Content-Type', MIME[extname(fp)]||'application/octet-stream');
    res.writeHead(200); res.end(b);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, r));

const base = join(ROOT,'chrome-headless-shell');
const exe = readdirSync(base).map(d => `${base}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);

const scenarios = [
  { name: 'core-only (no deferred block)',
    fg: { blocks:[
      { name:'src', id:'analog_sig_source_x', params:{ type:'float', samp_rate:32000, waveform:'cos', frequency:1000, amplitude:1.0 } },
      { name:'thr', id:'blocks_throttle', params:{ type:'float', samp_rate:32000 } },
      { name:'snk', id:'blocks_null_sink', params:{ type:'float' } } ],
      connections:[['src',0,'thr',0],['thr',0,'snk',0]] },
    expectFetch: [] },
  { name: 'vocoder (deferred)',
    fg: { blocks:[
      { name:'src', id:'blocks_null_source', params:{ type:'short' } },
      { name:'enc', id:'vocoder_alaw_encode_sb', params:{} },
      { name:'snk', id:'blocks_null_sink', params:{ type:'byte' } } ],
      connections:[['src',0,'enc',0],['enc',0,'snk',0]] },
    expectFetch: ['vocoder.wasm'] },
];

const browser = await puppeteer.launch({ executablePath: exe, headless: true,
  args: ['--no-sandbox','--disable-gpu','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
let allOk = true;
for (const sc of scenarios) {
  fetched = [];
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  const url = `http://localhost:${PORT}/runner/build/runner.html#` + encodeURIComponent(JSON.stringify(sc.fg));
  await page.goto(url, { waitUntil:'load', timeout:30000 });
  try { await page.waitForFunction(() => { const d=document.getElementById('result'); return d && d.dataset.status!=='pending'; }, { timeout:40000, polling:200 }); } catch {}
  const { status, text } = await page.evaluate(() => { const d=document.getElementById('result'); return { status:d?d.dataset.status:'missing', text:d?d.textContent:'' }; });
  const sideFetched = [...new Set(fetched)].filter(f => f !== 'runner.wasm');
  const pass = text.includes('RUNNER_PASS');
  const fetchOk = JSON.stringify(sideFetched.sort()) === JSON.stringify([...sc.expectFetch].sort());
  const ok = pass && fetchOk;
  allOk = allOk && ok;
  console.log(`\n[${ok?'OK':'FAIL'}] ${sc.name}`);
  console.log(`   status=${status} run=${pass} sideFetched=${JSON.stringify(sideFetched)} expected=${JSON.stringify(sc.expectFetch)}`);
  if (!pass) console.log('   text:', text, '\n  ', logs.slice(-4).join('\n   '));
  await page.close();
}
await browser.close();
console.log(`\n=== ${allOk ? 'ALL SCENARIOS PASS' : 'SOME FAILED'} ===`);
process.exit(allOk ? 0 : 1);
