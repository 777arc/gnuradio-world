#!/usr/bin/env node
// Assemble the static site to deploy to Cloudflare Pages.
//
// Produces ./site containing only what the browser actually loads at runtime,
// plus the Cloudflare control files (_headers, _redirects) and the JSON
// manifests that wasm/server.mjs serves dynamically in dev.
//
// Excluded on purpose:
//   - wasm/sysroot, wasm/gr  -> compile/link inputs, never served
//   - runner/build CMake/ninja/autogen/.a/.rsp scratch
//   - example_recordings/*.sigmf-data larger than Cloudflare's 25 MiB/file cap
//     (those get an R2 bucket later; the manifest simply omits them)
//
// Usage:  node wasm/scripts/assemble-site.mjs [outDir]   (default ./site)
import { readdir, readFile, stat, rm, mkdir, cp } from 'node:fs/promises';
import { join, extname, dirname, relative } from 'node:path';
import { writeFile } from 'node:fs/promises';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const WASM = join(SCRIPT_DIR, '..');            // wasm/
const OUT = process.argv[2] || join(process.cwd(), 'site');

// Cloudflare Pages rejects any single file >= 25 MiB.
const MAX_FILE = 25 * 1024 * 1024;

// runner/build files the browser needs (everything else there is build scratch).
const RUNTIME_EXT = new Set(['.html', '.js', '.mjs', '.wasm', '.svg', '.css', '.data', '.mem']);
const SKIP_DIR = name => name === 'CMakeFiles' || name.endsWith('_autogen');

// --- SigMF sample-count helper, mirrored from server.mjs so the static
//     recordings manifest is byte-identical to the dev server's response. ---
function sigmfBytesPerSample(datatype) {
  const match = typeof datatype === 'string'
    ? /^([rc])[fiu](\d+)(?:_(?:le|be))?$/i.exec(datatype)
    : null;
  if (!match) return null;
  const bitsPerComponent = Number(match[2]);
  const components = match[1].toLowerCase() === 'c' ? 2 : 1;
  const bytes = components * bitsPerComponent / 8;
  return Number.isInteger(bytes) && bytes > 0 ? bytes : null;
}

async function walkRuntimeFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR(entry.name)) continue;
      out.push(...await walkRuntimeFiles(p));
    } else if (RUNTIME_EXT.has(extname(entry.name)) && extname(entry.name) !== '.rsp') {
      out.push(p);
    }
  }
  return out;
}

async function copyInto(srcFile, srcRoot, destRoot) {
  const dest = join(destRoot, relative(srcRoot, srcFile));
  await mkdir(dirname(dest), { recursive: true });
  await cp(srcFile, dest);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 1. Editor UI (Vite build, base path /editor/dist/).
  const editorDist = join(WASM, 'editor', 'dist');
  await stat(editorDist).catch(() => { throw new Error('missing wasm/editor/dist -- run `npm run build` in wasm/editor first'); });
  await cp(editorDist, join(OUT, 'editor', 'dist'), { recursive: true });

  // 2. Runner runtime files (runner.wasm + side modules + qtloader, no scratch).
  const runnerBuild = join(WASM, 'runner', 'build');
  const runnerFiles = await walkRuntimeFiles(runnerBuild);
  for (const f of runnerFiles) await copyInto(f, WASM, OUT);
  console.log(`runner/build: copied ${runnerFiles.length} runtime files`);

  // 3. Example flowgraphs + manifest (matches GET /example_flowgraphs).
  const fgDir = join(WASM, 'example_flowgraphs');
  const grcFiles = (await readdir(fgDir)).filter(f => f.endsWith('.grc')).sort();
  await mkdir(join(OUT, 'example_flowgraphs'), { recursive: true });
  for (const f of grcFiles) await cp(join(fgDir, f), join(OUT, 'example_flowgraphs', f));
  await writeFile(join(OUT, 'example_flowgraphs', 'index.json'), JSON.stringify(grcFiles));
  console.log(`example_flowgraphs: ${grcFiles.length} .grc`);

  // 4. Example recordings + manifest (matches GET /example_recordings), size-gated.
  const recDir = join(WASM, 'example_recordings');
  const recFiles = new Set(await readdir(recDir).catch(() => []));
  const bases = [...recFiles]
    .filter(f => f.endsWith('.sigmf-meta'))
    .map(f => f.slice(0, -'.sigmf-meta'.length))
    .filter(b => recFiles.has(b + '.sigmf-data'))
    .sort((a, b) => a.localeCompare(b));

  const manifest = [];
  let skipped = 0;
  await mkdir(join(OUT, 'example_recordings'), { recursive: true });
  for (const name of bases) {
    const dataFile = name + '.sigmf-data';
    const metaFile = name + '.sigmf-meta';
    const dataStat = await stat(join(recDir, dataFile));
    if (dataStat.size >= MAX_FILE) {            // too big for Cloudflare -> omit
      skipped++;
      continue;
    }
    const metadata = JSON.parse(await readFile(join(recDir, metaFile), 'utf8'));
    const g = metadata && typeof metadata.global === 'object' ? metadata.global : {};
    const datatype = typeof g['core:datatype'] === 'string' ? g['core:datatype'] : null;
    const sampleRate = typeof g['core:sample_rate'] === 'number' ? g['core:sample_rate'] : null;
    const author = typeof g['core:author'] === 'string' ? g['core:author'] : null;
    const bps = sigmfBytesPerSample(datatype);
    const sampleCount = bps && dataStat.size % bps === 0 ? dataStat.size / bps : null;
    manifest.push({
      name, dataFile, metaFile, datatype, sampleRate, author, sampleCount,
      byteLength: dataStat.size,
      downloadUrl: '/example_recordings/' + encodeURIComponent(dataFile),
    });
    await cp(join(recDir, dataFile), join(OUT, 'example_recordings', dataFile));
    await cp(join(recDir, metaFile), join(OUT, 'example_recordings', metaFile));
  }
  await writeFile(join(OUT, 'example_recordings', 'index.json'), JSON.stringify(manifest));
  console.log(`example_recordings: ${manifest.length} included, ${skipped} omitted (>25 MiB, need R2)`);

  // 5. Cloudflare control files.
  //    _headers: restore the cross-origin isolation server.mjs sets, so
  //    SharedArrayBuffer + Emscripten pthreads work.
  await writeFile(join(OUT, '_headers'),
`/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin

/*.wasm
  Content-Type: application/wasm
`);
  //    _redirects: root -> editor, and 200-rewrite the bare listing paths to
  //    their static manifests so the unmodified client's fetch() still works.
  await writeFile(join(OUT, '_redirects'),
`/example_flowgraphs   /example_flowgraphs/index.json   200
/example_recordings   /example_recordings/index.json   200
/   /editor/dist/   302
`);

  console.log(`\nAssembled site -> ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
