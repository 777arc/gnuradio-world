import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const b = await puppeteer.launch({executablePath: exe, headless:true, args:['--no-sandbox','--disable-gpu']});
const p = await b.newPage(); await p.setViewport({width:1200,height:720});
await p.goto('http://localhost:8090/editor/dist/index.html',{waitUntil:'load',timeout:30000});
await new Promise(r=>setTimeout(r,800));
// right-click the first block's title
const box = await p.evaluate(()=>{ const t=document.querySelector('#nodes .blk text.title'); const r=t.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; });
await p.mouse.click(box.x, box.y, {button:'right'});
await new Promise(r=>setTimeout(r,200));
const items = await p.evaluate(()=>[...document.querySelectorAll('.ctxmenu .ctxitem')].map(d=>d.textContent));
console.log('MENU_ITEMS:', JSON.stringify(items));
await p.screenshot({path: process.argv[2]});
// click "Disable"
await p.evaluate(()=>{ const d=[...document.querySelectorAll('.ctxmenu .ctxitem')].find(x=>x.textContent==='Disable'); d && d.click(); });
await new Promise(r=>setTimeout(r,150));
const disabled = await p.evaluate(()=>!!document.querySelector('#nodes .blk.disabled'));
const menuGone = await p.evaluate(()=>!document.querySelector('.ctxmenu'));
console.log('block disabled after click:', disabled, '| menu closed:', menuGone);
await b.close(); process.exit(0);
