import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const b = await puppeteer.launch({executablePath: exe, headless:true, args:['--no-sandbox','--disable-gpu']});
const p = await b.newPage(); await p.setViewport({width:1200,height:760});
await p.goto('http://localhost:8090/editor/dist/index.html',{waitUntil:'load',timeout:30000});
await new Promise(r=>setTimeout(r,700));
const cats = await p.evaluate(()=>[...document.querySelectorAll('#palette .cat-row')].map(r=>r.textContent.replace(/[▸▾]/,'').trim()));
console.log('TOP CATS:', JSON.stringify(cats.slice(0,14)));
// expand "Waveform Generators" by clicking the category that contains it under Core: first expand Core
await p.evaluate(()=>{ const core=[...document.querySelectorAll('#palette .cat-row')].find(r=>/Core$/.test(r.textContent.trim())); core && core.click(); });
await new Promise(r=>setTimeout(r,150));
await p.evaluate(()=>{ const w=[...document.querySelectorAll('#palette .cat-row')].find(r=>/Waveform Generators/.test(r.textContent)); w && w.click(); });
await new Promise(r=>setTimeout(r,150));
await p.screenshot({path: process.argv[2]});
await b.close(); process.exit(0);
