import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const b = await puppeteer.launch({executablePath: exe, headless: true, args:['--no-sandbox','--disable-gpu']});
const p = await b.newPage();
p.on('console', m => console.log('[console]', m.text().slice(0,200)));
p.on('pageerror', e => console.log('[pageerror]', e.message.slice(0,200)));
p.on('requestfailed', r => console.log('[reqfail]', r.url().split('/').pop(), r.failure()?.errorText));
p.on('response', r => { if (r.status()>=400) console.log('[http]', r.status(), r.url().split('/').pop()); });
await p.goto('http://localhost:8090/phase5/index.html', {waitUntil:'load', timeout:30000});
await new Promise(r=>setTimeout(r, 15000));
const info = await p.evaluate(()=>({
  result: document.getElementById('result')?.textContent,
  hasModule: typeof Module, deps: (typeof Module==='object'? Module.getPreloadedPackage : undefined)!==undefined,
  status: document.getElementById('log')?.textContent?.slice(-400)
}));
console.log('RESULT:', info.result, '| typeof Module:', info.hasModule);
console.log('LOG tail:', JSON.stringify(info.status));
await b.close();
