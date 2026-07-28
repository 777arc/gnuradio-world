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

// Recordings too big for Pages are served from Cloudflare R2 instead. Set this
// to the bucket's public base URL (e.g. https://recordings.gnuradio-wasm.dev or
// the r2.dev dev URL) via the CI env. When unset (local assemble), oversized
// recordings are omitted from the manifest, exactly as before. The R2 bucket
// must send CORS headers for this site's origin -- the app fetches the data
// file cross-origin in CORS mode, and the site is cross-origin-isolated.
const R2_BASE = (process.env.RECORDINGS_R2_BASE || '').replace(/\/+$/, '');

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

// Size of an R2-hosted recording, via a HEAD request. Used when the .sigmf-data
// file isn't in the checkout (it's gitignored and lives only on R2), so the
// manifest can still report a byte length. Returns null if unreachable/missing.
async function r2ContentLength(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const len = res.headers.get('content-length');
    return len == null ? null : Number(len);
  } catch {
    return null;
  }
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 1. Editor UI (Vite build, base path /) -- the editor *is* the site root,
  //    so its index.html/assets/blocks.json land directly in OUT.
  const editorDist = join(WASM, 'editor', 'dist');
  await stat(editorDist).catch(() => { throw new Error('missing wasm/editor/dist -- run `npm run build` in wasm/editor first'); });
  await cp(editorDist, OUT, { recursive: true });

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
  // A recording is defined by its (committed) .sigmf-meta. The .sigmf-data may
  // be present locally (dev) or absent (CI, where it's gitignored and lives on
  // R2). Pairing is resolved per-recording in the loop below.
  const bases = [...recFiles]
    .filter(f => f.endsWith('.sigmf-meta'))
    .map(f => f.slice(0, -'.sigmf-meta'.length))
    .sort((a, b) => a.localeCompare(b));

  const manifest = [];
  let skipped = 0;
  await mkdir(join(OUT, 'example_recordings'), { recursive: true });
  for (const name of bases) {
    const dataFile = name + '.sigmf-data';
    const metaFile = name + '.sigmf-meta';
    const localData = recFiles.has(dataFile);
    const r2Url = R2_BASE + '/' + encodeURIComponent(dataFile);

    // Resolve where the data comes from and its byte length. Local files under
    // the Pages 25 MiB limit ship with the site; anything larger, and anything
    // not in the checkout, is served from R2 (size via HEAD).
    let byteLength, fromR2;
    if (localData) {
      byteLength = (await stat(join(recDir, dataFile))).size;
      fromR2 = byteLength >= MAX_FILE;
      if (fromR2 && !R2_BASE) { skipped++; continue; }   // too big, no R2 -> omit
    } else {
      if (!R2_BASE) { skipped++; continue; }             // no local data, no R2 -> omit
      fromR2 = true;
      byteLength = await r2ContentLength(r2Url);
      if (byteLength == null) {                          // not uploaded/unreachable
        console.warn(`  ! ${dataFile}: not found on R2, omitting`);
        skipped++;
        continue;
      }
    }

    const metadata = JSON.parse(await readFile(join(recDir, metaFile), 'utf8'));
    const g = metadata && typeof metadata.global === 'object' ? metadata.global : {};
    const datatype = typeof g['core:datatype'] === 'string' ? g['core:datatype'] : null;
    const sampleRate = typeof g['core:sample_rate'] === 'number' ? g['core:sample_rate'] : null;
    const author = typeof g['core:author'] === 'string' ? g['core:author'] : null;
    const bps = sigmfBytesPerSample(datatype);
    const sampleCount = bps && byteLength % bps === 0 ? byteLength / bps : null;
    // R2-hosted files use their absolute cross-origin URL; Pages-hosted files
    // are fetched same-origin.
    manifest.push({
      name, dataFile, metaFile, datatype, sampleRate, author, sampleCount,
      byteLength,
      downloadUrl: fromR2 ? r2Url : '/example_recordings/' + encodeURIComponent(dataFile),
    });
    // Only copy the (large) data file to the site when it's served from Pages;
    // R2-hosted ones live in the bucket. The tiny .sigmf-meta is always copied
    // so the deployed site stays self-describing.
    if (!fromR2)
      await cp(join(recDir, dataFile), join(OUT, 'example_recordings', dataFile));
    await cp(join(recDir, metaFile), join(OUT, 'example_recordings', metaFile));
  }
  await writeFile(join(OUT, 'example_recordings', 'index.json'), JSON.stringify(manifest));
  const r2Note = R2_BASE ? ` (R2: ${R2_BASE})` : '';
  console.log(`example_recordings: ${manifest.length} included, ${skipped} omitted (>25 MiB, need R2)${r2Note}`);

  // 5. IQEngine client (git submodule), served from /iqengine/ so the
  //    "open in IQEngine" links on the recordings tab resolve same-origin.
  //    Built with --base=/iqengine/ (see the deploy workflow), which is also
  //    what its router uses as its basename.
  const iqengineBuild = join(WASM, '..', 'iqengine', 'client', 'build');
  const haveIQEngine = await stat(iqengineBuild).then(() => true).catch(() => false);
  if (haveIQEngine) {
    await cp(iqengineBuild, join(OUT, 'iqengine'), { recursive: true });
    // SPA fallback for its client-side routes, as a copy OUTSIDE /iqengine/.
    // Pages drops a 200-rewrite whose target its own rule matches (a loop), so
    // "/iqengine/* -> /iqengine/index.html" silently falls through to the site
    // root instead -- which is what a deep IQEngine URL used to land on. The
    // page itself references its assets by absolute path, so it works from
    // wherever it is served.
    await cp(join(iqengineBuild, 'index.html'), join(OUT, 'iqengine-spa.html'));
    console.log('iqengine: copied client build');
  } else {
    console.warn('iqengine: no client build found, "open in IQEngine" links will 404 ' +
      '(cd iqengine/client && npm ci && npm run build -- --base=/iqengine/)');
  }

  // 6. Cloudflare control files.
  //    _headers: restore the cross-origin isolation server.mjs sets, so
  //    SharedArrayBuffer + Emscripten pthreads work.
  //    IQEngine is served under the same policy: its spectrogram view needs
  //    nothing cross-origin except the recording itself, which is fetched in
  //    CORS mode and so satisfies COEP. (The one casualty is its Pyodide
  //    <script> from a CDN, i.e. the python-snippet and siggen features, which
  //    this site does not use.)
  await writeFile(join(OUT, '_headers'),
`/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin

/*.wasm
  Content-Type: application/wasm
`);
  //    _redirects: 200-rewrite the bare listing paths to their static
  //    manifests so the unmodified client's fetch() still works. The editor
  //    itself is served from / by Pages' own index.html handling, so no root
  //    redirect is needed. IQEngine is a single-page app, so any path under it
  //    that is not a real file has to land on its index.html; static assets
  //    match before _redirects is consulted, so its own JS/CSS still load.
  //    That fallback must live outside /iqengine/ (see above), and dynamic
  //    rules go last, after the static ones.
  await writeFile(join(OUT, '_redirects'),
`/example_flowgraphs   /example_flowgraphs/index.json   200
/example_recordings   /example_recordings/index.json   200
/editor/dist/*        /                                301
/iqengine/*           /iqengine-spa.html               200
`);
  //    404.html: without it Pages answers every unmatched path with the site's
  //    root index.html AND a 200. That is not merely untidy -- IQEngine probes
  //    /api/config, /api/plugins/ and friends to discover whether it has a
  //    backend, and a 200 full of HTML reads as "yes, and here is your config",
  //    which crashes it. A real 404 is what its no-backend path expects.
  await writeFile(join(OUT, '404.html'),
`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Not found — GNU Radio World</title>
<style>
  html,body { margin:0; height:100%; font-family:system-ui,Arial,sans-serif;
              color:#e6e9f0; background:#1e2230; }
  main { height:100%; display:flex; flex-direction:column; align-items:center;
         justify-content:center; gap:12px; }
  a { color:#8fb6ff; }
</style>
</head>
<body>
<main>
  <h1>404</h1>
  <p>Nothing here.</p>
  <p><a href="/">Open the flowgraph editor</a></p>
</main>
</body>
</html>
`);

  console.log(`\nAssembled site -> ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
