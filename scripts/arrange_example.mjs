#!/usr/bin/env node
// Auto-arrange example flowgraphs the way docs/flowgraph-files.md requires
// before one is committed: load it in the *editor*, run Edit ▸ Auto-Arrange
// Blocks, and write back what the editor's own Save produces.
//
// Doing it through the editor rather than rewriting coordinates here is the
// point. Auto-arrange is the only thing that knows a block's drawn size, and
// Save is the only thing that emits the canonical .grc — same key order, same
// scalar quoting, plus the GUI Layout singleton every flowgraph carries. The
// result is byte-identical to what a human doing this by hand would commit.
//
// Save is lossy for a flowgraph adapted from upstream GNU Radio: it drops
// `import` blocks, GRC's affinity/alias/maxoutbuf/minoutbuf, `gui_hint` and
// most of the options block. That is fine for a flowgraph authored here and
// destructive for one carried in from upstream — for those, take the
// states.coordinate/states.rotation out of the result and merge them into the
// original by hand instead of using this. See docs/flowgraph-files.md.
//
// Needs `node server.mjs 8090 "$PWD"` already running and the editor built
// (cd editor && npm run build).
//
// Usage: node scripts/arrange_example.mjs <example.grc>... [--port=8090]
// Exits non-zero if any file could not be arranged.
import { existsSync, writeFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { launchBrowser } from './browser-test-support.mjs';

const args = process.argv.slice(2);
const portArg = args.findIndex(a => a.startsWith('--port='));
const port = portArg >= 0 ? args.splice(portArg, 1)[0].slice('--port='.length) : '8090';
if (!args.length) {
  console.error('usage: node scripts/arrange_example.mjs <example.grc>... [--port=8090]\n' +
                '       paths are relative to example_flowgraphs/');
  process.exit(2);
}

const exampleRoot = new URL('../example_flowgraphs/', import.meta.url).pathname;
const rootPrefix = exampleRoot.endsWith(sep) ? exampleRoot : exampleRoot + sep;
const targets = args.map(arg => {
  const relative = arg.replace(/^example_flowgraphs[/\\]/, '');
  const path = resolve(exampleRoot, relative);
  if (!path.startsWith(rootPrefix)) {
    console.error(`example path escapes example_flowgraphs: ${arg}`); process.exit(2);
  }
  if (!existsSync(path)) { console.error(`no such example: ${path}`); process.exit(2); }
  return { path, relative: relative.replace(/\\/g, '/'), name: basename(path) };
});

const browser = await launchBrowser(new URL('..', import.meta.url).pathname);
let failed = 0;
try {
  for (const target of targets) {
    // A page each. #example= only changes the fragment, and a same-document
    // hash change does not reload, so reusing one page leaves the previous
    // flowgraph on the canvas and every file after the first gets saved with
    // the wrong contents — silently, since a .grc is a .grc.
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1400, height: 900 });
      page.on('pageerror', e => console.log('PAGEERROR', e.message));
      const link = target.relative.replace(/\.grc$/, '');
      await page.goto(`http://localhost:${port}/#example=${encodeURIComponent(link)}`,
        { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 3500));
      // Auto-arrange packs blocks by their drawn size, and a block's height
      // comes from measured text — a Note's wrapped line count above all. Those
      // metrics change when the web fonts land, so arranging before then gives
      // a layout that shifts by a line the next time round. Waiting makes the
      // output reproducible instead of depending on a warm font cache.
      await page.evaluate(() => document.fonts.ready);

      const placed = await page.evaluate(() => document.querySelectorAll('#nodes > *').length);
      if (!placed) throw new Error('nothing on the canvas');

      const arranged = await page.evaluate(() => {
        const menu = [...document.querySelectorAll('button,div,span')]
          .find(e => e.children.length === 0 && (e.textContent || '').trim() === 'Edit');
        if (!menu) return 'no Edit menu';
        menu.click();
        const item = [...document.querySelectorAll('*')].find(
          e => e.children.length === 0 &&
               (e.textContent || '').trim() === 'Auto-Arrange Blocks');
        if (!item) return 'no Auto-Arrange Blocks item';
        item.click();
        return 'ok';
      });
      if (arranged !== 'ok') throw new Error(arranged);
      await new Promise(r => setTimeout(r, 1200));

      // Save hands the .grc to the browser as a Blob on a download anchor.
      // Capture both: the Blob is the text to write, and the anchor's filename
      // is what the editor believes it is saving — the flowgraph currently on
      // the canvas, which is the identity this has to check before overwriting.
      const saved = await page.evaluate(() => {
        let text = null, filename = null;
        const OriginalBlob = window.Blob;
        const originalClick = HTMLAnchorElement.prototype.click;
        window.Blob = function (parts, options) {
          text = parts[0]; return new OriginalBlob(parts, options);
        };
        HTMLAnchorElement.prototype.click = function () { filename = this.download; };
        try {
          const save = [...document.querySelectorAll('button')].find(
            b => (b.title || '').includes('Save') || (b.textContent || '').trim() === '💾');
          if (save) save.click();
        } finally {
          window.Blob = OriginalBlob;
          HTMLAnchorElement.prototype.click = originalClick;
        }
        return { text, filename };
      });
      if (!saved.text) throw new Error('Save produced nothing');

      // The guard. Without it, any way of ending up with a stale canvas — a
      // load that quietly failed, a slow example that needed longer than the
      // wait above, a future change to the #example= path — overwrites this
      // file with a different flowgraph and says "arranged".
      if (saved.filename && saved.filename !== target.name)
        throw new Error(`canvas holds ${saved.filename}, refusing to write ${target.name}`);

      const title = (saved.text.match(/^\s+title:\s*(.+?)\s*$/m) || [])[1] || '(untitled)';
      writeFileSync(target.path, saved.text);
      console.log(`arranged ${target.relative} — ${placed} blocks, ${title}`);
    } catch (err) {
      console.log(`FAILED  ${target.relative}: ${err.message}`);
      failed += 1;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (failed) console.log(`RESULT: ARRANGE_FAIL (${failed} of ${targets.length})`);
else console.log(`RESULT: ARRANGE_PASS (${targets.length})`);
process.exit(failed ? 1 : 0);
