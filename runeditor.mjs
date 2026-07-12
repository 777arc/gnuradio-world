import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const b = await puppeteer.launch({executablePath: exe, headless:true, args:['--no-sandbox','--disable-gpu','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p = await b.newPage(); await p.setViewport({width:1200,height:760});
p.on('pageerror',e=>console.log('[E]',e.message.slice(0,140)));
await p.goto('http://localhost:8090/editor/dist/index.html',{waitUntil:'load',timeout:30000});
await new Promise(r=>setTimeout(r,1000));
await p.click('#btnRun');                       // <-- the editor's Run button
console.log('clicked Run; waiting for runner to build+render…');
await new Promise(r=>setTimeout(r,16000));      // runner: load 26MB wasm + run + 2.5s draw
// look inside the run overlay iframe for the runner RESULT
const frames = p.frames();
for (const f of frames) {
  try { const res = await f.evaluate(()=>document.getElementById('result')?.textContent); if (res) console.log('RUNNER:', res); } catch {}
}
await p.screenshot({path: process.argv[2]});
await b.close();
