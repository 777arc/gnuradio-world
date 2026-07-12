import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
const hardStop = setTimeout(()=>{ console.log('HARD_STOP'); process.exit(0); }, 30000);
const b = await puppeteer.launch({executablePath: exe, headless:true, args:['--no-sandbox','--disable-gpu','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p = await b.newPage();
p.on('console',m=>console.log('[c]',m.text().slice(0,180)));
p.on('pageerror',e=>console.log('[E]',e.message.slice(0,180)));
try { await p.goto('http://localhost:8090/runner/build/runner.html',{waitUntil:'load',timeout:20000}); } catch(e){ console.log('goto:',e.message); }
await new Promise(r=>setTimeout(r,18000));
try { const res = await p.evaluate(()=>document.getElementById('result')?.textContent); console.log('RESULT:', res); } catch(e){ console.log('eval err', e.message); }
clearTimeout(hardStop); await b.close(); process.exit(0);
