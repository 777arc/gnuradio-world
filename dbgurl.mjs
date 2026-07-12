import puppeteer from 'puppeteer-core';
import { readdirSync, existsSync } from 'node:fs';
const base = new URL('./chrome-headless-shell/', import.meta.url).pathname;
const exe = readdirSync(base).map(d=>`${base}${d}/chrome-headless-shell-linux64/chrome-headless-shell`).find(existsSync);
setTimeout(()=>{ console.log('HARD_STOP'); process.exit(0); }, 26000);
const b = await puppeteer.launch({executablePath: exe, headless:true, args:['--no-sandbox','--disable-gpu','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p = await b.newPage(); await p.setViewport({width:900,height:640});
p.on('pageerror',e=>console.log('[E]',e.message.slice(0,180)));
try { await p.goto(process.argv[2],{waitUntil:'load',timeout:20000}); } catch(e){ console.log('goto:',e.message); }
await new Promise(r=>setTimeout(r,16000));
try { console.log('RESULT:', await p.evaluate(()=>document.getElementById('result')?.textContent)); } catch(e){ console.log('eval:',e.message); }
if (process.argv[3]) { try { await p.screenshot({path:process.argv[3]}); } catch(e){} }
await b.close(); process.exit(0);
