import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const b = await puppeteer.launch({executablePath: exe, headless:true, args:['--no-sandbox','--disable-gpu']});
const p = await b.newPage(); await p.setViewport({width:1200,height:720});
await p.goto('http://localhost:8090/editor/dist/index.html',{waitUntil:'load',timeout:30000});
await new Promise(r=>setTimeout(r,700));
// menu items
const box = await p.evaluate(()=>{ const t=document.querySelector('#nodes .blk text.title'); const r=t.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; });
await p.mouse.click(box.x, box.y, {button:'right'});
await new Promise(r=>setTimeout(r,150));
const items = await p.evaluate(()=>[...document.querySelectorAll('.ctxmenu .ctxitem')].map(d=>d.textContent));
console.log('MENU:', JSON.stringify(items));
// rotate the block CW and check ports moved to top/bottom
await p.evaluate(()=>[...document.querySelectorAll('.ctxmenu .ctxitem')].find(x=>x.textContent==='Rotate Clockwise').click());
await new Promise(r=>setTimeout(r,150));
const arrows = await p.evaluate(()=>document.querySelectorAll('#wires path[marker-end]').length);
console.log('wires with arrowheads:', arrows);
await p.screenshot({path: process.argv[2]});
await b.close(); process.exit(0);
