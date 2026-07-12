import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const b = await puppeteer.launch({executablePath: exe, headless:true, args:['--no-sandbox','--disable-gpu']});
const p = await b.newPage(); await p.setViewport({width:1200,height:720});
await p.goto('http://localhost:8090/editor/dist/index.html',{waitUntil:'load',timeout:30000});
await new Promise(r=>setTimeout(r,700));
const box = await p.evaluate(()=>{ const t=document.querySelector('#nodes .blk text.title'); const r=t.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; });
await p.mouse.click(box.x, box.y, {button:'right'});
await new Promise(r=>setTimeout(r,150));
await p.evaluate(()=>[...document.querySelectorAll('.ctxmenu .ctxitem')].find(x=>x.textContent==='Properties').click());
await new Promise(r=>setTimeout(r,200));
const dlg = await p.evaluate(()=>{ const d=document.querySelector('.modal.props'); if(!d) return null;
  return { head: d.querySelector('.dlghead').textContent, rows: d.querySelectorAll('.dlgrow').length,
           labels: [...d.querySelectorAll('.dlgrow label')].map(l=>l.textContent) }; });
console.log('DIALOG:', JSON.stringify(dlg));
await p.screenshot({path: process.argv[2]});
// change Frequency to 5000 and click OK
await p.evaluate(()=>{ const rows=[...document.querySelectorAll('.modal.props .dlgrow')];
  const fr = rows.find(r=>/frequency/i.test(r.querySelector('label').textContent)); const inp=fr.querySelector('input');
  inp.value='5000'; inp.dispatchEvent(new Event('input',{bubbles:true})); });
await p.evaluate(()=>[...document.querySelectorAll('.modal.props .dlgfoot button')].find(b=>b.textContent==='OK').click());
await new Promise(r=>setTimeout(r,150));
const applied = await p.evaluate(()=>{ // read the block's freq param row text on canvas
  const t=[...document.querySelectorAll('#nodes .blk text.param')].map(x=>x.textContent).find(s=>/Frequency/i.test(s)); 
  return { canvasFreq:t, dialogClosed: !document.querySelector('.modal.props') }; });
console.log('AFTER_OK:', JSON.stringify(applied));
await b.close(); process.exit(0);
