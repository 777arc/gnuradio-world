import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const b = await puppeteer.launch({executablePath: exe, headless:true, args:['--no-sandbox','--disable-gpu']});
const p = await b.newPage(); await p.setViewport({width:1200,height:720});
await p.goto('http://localhost:8090/editor/dist/index.html',{waitUntil:'load',timeout:30000});
await new Promise(r=>setTimeout(r,800));
// find a param <text> element inside the first block, record block transform, drag from the text
const before = await p.evaluate(()=>document.querySelector('#nodes .blk').getAttribute('transform'));
const box = await p.evaluate(()=>{ const t=document.querySelector('#nodes .blk text.param'); const r=t.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2, txt:t.textContent}; });
await p.mouse.move(box.x, box.y); await p.mouse.down();
await p.mouse.move(box.x+120, box.y+80, {steps:8}); await p.mouse.up();
const after = await p.evaluate(()=>document.querySelector('#nodes .blk').getAttribute('transform'));
// also check nothing got text-selected
const sel = await p.evaluate(()=>String(window.getSelection()));
console.log('DRAGGED_FROM_PARAM_TEXT:', JSON.stringify(box.txt));
console.log('before:', before, '| after:', after, '| moved:', before!==after);
console.log('selection empty:', sel==='');
await b.close(); process.exit(0);
