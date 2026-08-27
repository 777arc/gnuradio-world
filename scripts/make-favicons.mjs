#!/usr/bin/env node
// Rasterise editor/public/favicon.svg into the icon files a browser or crawler
// asks for by name and cannot get from the SVG:
//
//   favicon.ico        - what every legacy client, and anything that probes
//                        /favicon.ico blindly, requests. Google's favicon
//                        crawler is happy with the SVG, but the bare path was
//                        a 404 before this existed.
//   apple-touch-icon.png - iOS home screen and Safari, neither of which reads
//                        an SVG icon. Full bleed on the mark's own background:
//                        iOS applies its own corner mask, so the SVG's rounded
//                        rect would be clipped twice.
//
// Rasterising happens in the same headless Chrome the browser tests drive, so
// the icons are exactly what a browser draws from the SVG - no second renderer
// to disagree with it. The .ico embeds PNGs (the Vista-era form every browser
// in use reads) rather than BMPs, so no palette or mask encoding is needed.
//
// Usage: node scripts/make-favicons.mjs      (rewrites the files in editor/public/)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from './browser-test-support.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'editor', 'public');
const svg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');
const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

// The mark's own background, for the icon that may not be transparent.
const OPAQUE_BG = '#181b26';

const browser = await launchBrowser(ROOT);
try {
  const page = await browser.newPage();
  const render = async (size, background) => {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;background:${background || 'transparent'}}` +
      `img{display:block;width:${size}px;height:${size}px}</style>` +
      `<img src="${dataUri}">`, { waitUntil: 'load' });
    // omitBackground only reaches through a transparent page background; with
    // one set it is ignored, which is what apple-touch-icon.png wants.
    return page.screenshot({ type: 'png', omitBackground: !background });
  };

  const apple = await render(180, OPAQUE_BG);
  writeFileSync(join(PUBLIC, 'apple-touch-icon.png'), apple);

  const icoSizes = [16, 32, 48];
  const pngs = [];
  for (const size of icoSizes) pngs.push(await render(size));
  writeFileSync(join(PUBLIC, 'favicon.ico'), buildIco(icoSizes, pngs));
  console.log(`favicon.ico: ${icoSizes.join(', ')} px   apple-touch-icon.png: 180 px`);
} finally {
  await browser.close();
}

// ICONDIR + one ICONDIRENTRY per image, then the PNG payloads. A dimension of
// 256 is stored as 0; nothing here is that large, but the rule is the format's.
function buildIco(sizes, pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const entries = Buffer.alloc(16 * sizes.length);
  let offset = header.length + entries.length;
  sizes.forEach((size, i) => {
    const at = i * 16;
    entries.writeUInt8(size % 256, at);      // width
    entries.writeUInt8(size % 256, at + 1);  // height
    entries.writeUInt8(0, at + 2);           // palette size: none
    entries.writeUInt8(0, at + 3);           // reserved
    entries.writeUInt16LE(1, at + 4);        // colour planes
    entries.writeUInt16LE(32, at + 6);       // bits per pixel
    entries.writeUInt32LE(pngs[i].length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, entries, ...pngs]);
}
