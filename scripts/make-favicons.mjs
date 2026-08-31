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
// HAND-DRAWN FRAMES. A favicon's 16px frame is the one a browser tab actually
// shows, and it is the one downscaling serves worst: the mark's 48px grid is
// not divisible by 3, so a 2px border lands on 0.67px and greys out. Drop a
// PNG of exactly NxN at editor/public/favicon-<N>.png and this script embeds it
// verbatim instead of rendering that size from the SVG - the usual practice of
// pixel-fitting the small frame by hand. The other sizes keep coming from the
// SVG, so the mark stays one drawing with one hand-tuned exception.
//
// It sits beside favicon.svg rather than in a build-inputs directory of its own
// so that everything hand-authored about the mark is in one place. The cost is
// that Vite copies it to dist/ and serves it unreferenced, which is cheaper
// than a directory nobody remembers.
//
// Usage:
//   node scripts/make-favicons.mjs             rewrite the files in editor/public/
//   node scripts/make-favicons.mjs --eject 16  write the SVG's own 16px render to
//                                              editor/public/favicon-16.png as a
//                                              starting point to edit, then stop
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

  const icoSizes = [16, 32, 48];

  // --eject <size>: hand this size's current render to the user to edit.
  const ejectAt = process.argv.indexOf('--eject');
  if (ejectAt !== -1) {
    const size = Number(process.argv[ejectAt + 1]);
    if (!icoSizes.includes(size)) {
      console.error(`--eject needs one of ${icoSizes.join(', ')}; got ${process.argv[ejectAt + 1] ?? '(nothing)'}`);
      process.exitCode = 1;
    } else {
      const at = join(PUBLIC, `favicon-${size}.png`);
      writeFileSync(at, await render(size));
      console.log(`wrote ${at}\nEdit it, keep it ${size}x${size} RGBA, then re-run this script without --eject.`);
    }
  } else {
    const apple = await render(180, OPAQUE_BG);
    writeFileSync(join(PUBLIC, 'apple-touch-icon.png'), apple);

    const pngs = [];
    const from = [];
    for (const size of icoSizes) {
      const override = overrideFor(size);
      pngs.push(override ?? await render(size));
      from.push(override ? `${size} px (hand-drawn)` : `${size} px`);
    }
    writeFileSync(join(PUBLIC, 'favicon.ico'), buildIco(icoSizes, pngs));
    console.log(`favicon.ico: ${from.join(', ')}   apple-touch-icon.png: 180 px`);
  }
} finally {
  await browser.close();
}

// A hand-drawn frame, if one is sitting beside the SVG. Checked rather than
// trusted: an ICONDIRENTRY declares the dimensions separately from the PNG it
// points at, so a mis-sized override would produce an .ico that parses and
// renders wrong, which is the hardest kind of wrong to notice.
function overrideFor(size) {
  const at = join(PUBLIC, `favicon-${size}.png`);
  if (!existsSync(at)) return null;
  const png = readFileSync(at);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(magic))
    throw new Error(`${at} is not a PNG (a .ico or .bmp renamed to .png will not do)`);
  // IHDR is required to be the first chunk: 8 byte signature, 4 length, 4 type.
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (w !== size || h !== size)
    throw new Error(`${at} is ${w}x${h}, must be exactly ${size}x${size}`);
  return png;
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
