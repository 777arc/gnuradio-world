#!/usr/bin/env node
// Render editor/public/og-image.png: the 1200x630 card Google, Slack, Discord,
// X and every other unfurler shows for gnuradioworld.com.
//
// Drawn as a page in the same headless Chrome the browser tests drive, rather
// than composited in an image library, so the card is edited as HTML and CSS
// and uses the real brand assets: the dark-background wordmark over the blurred
// flowgraph the click-to-load gate already uses as its backdrop. Both are
// inlined as data URIs, so this needs no server running.
//
// Usage: node scripts/make-og-image.mjs   (rewrites editor/public/og-image.png)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from './browser-test-support.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'editor', 'public');
const dataUri = (file, type) =>
  `data:${type};base64,` + readFileSync(join(PUBLIC, file)).toString('base64');

const logo = dataUri('gnuradio_world_logo_dark.svg', 'image/svg+xml');
const backdrop = dataUri('blurry_flowgraph.png', 'image/png');

// Keep the wording in step with the <meta name="description"> in editor/index.html:
// an unfurl that promises something different from the search result is worse
// than no unfurl at all.
const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; }
  body {
    position: relative; overflow: hidden;
    background: linear-gradient(#181b26, #202536);
    font-family: "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif;
    color: #e9ecf4;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  /* The flowgraph reads as texture, not as content: blurred, dimmed to a
     whisper, and veiled again in the middle so the wordmark sits on quiet
     ground. Anything stronger turns the card to noise at thumbnail size. */
  .backdrop {
    position: absolute; inset: 0; background: url('${backdrop}') center / cover no-repeat;
    filter: blur(5px); opacity: .085;
  }
  .veil {
    position: absolute; inset: 0;
    background: radial-gradient(closest-side at 50% 55%,
                                rgba(20,23,33,.92), rgba(20,23,33,0) 78%);
  }
  .card { position: relative; width: 1080px; text-align: center; }
  img { width: 620px; display: block; margin: 0 auto; }
  .rule { display: flex; justify-content: center; gap: 8px; margin: 26px 0 22px; }
  .rule i { display: block; width: 146px; height: 3px; background: #ff6905; }
  .rule i + i { background: #3399ff; }
  h1 { margin: 0; font-size: 36px; font-weight: 700; letter-spacing: -.2px; }
  p  { margin: 18px 0 0; font-size: 25px; color: #96b2e0; }
  .host { margin-top: 42px; font-size: 25px; color: #8c94a8; }
</style>
<div class="backdrop"></div><div class="veil"></div>
<div class="card">
  <img src="${logo}" alt="">
  <div class="rule"><i></i><i></i></div>
  <h1>Build and run GNU Radio flowgraphs in your browser</h1>
  <p>No install &middot; WebAssembly &middot; RTL-SDR, PlutoSDR &amp; HackRF over WebUSB</p>
  <div class="host">gnuradioworld.com</div>
</div>`;

const browser = await launchBrowser(ROOT);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: join(PUBLIC, 'og-image.png'), type: 'png' });
  console.log('og-image.png: 1200x630');
} finally {
  await browser.close();
}
