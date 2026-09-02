#!/usr/bin/env node
// Assemble the static site to deploy to Cloudflare Pages.
//
// Produces ./site containing only what the browser actually loads at runtime,
// plus the Cloudflare control files (_headers, _redirects) and the flowgraph
// manifest that server.mjs serves dynamically in dev.
//
// Excluded on purpose:
//   - sysroot, gr  -> compile/link inputs, never served
//   - runner/build CMake/ninja/autogen/.a/.rsp scratch
//
// Usage:  node scripts/assemble-site.mjs [outDir]   (default ./site)
import { readdir, readFile, stat, rm, mkdir, cp } from 'node:fs/promises';
import { join, extname, dirname, relative, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';
import { findExampleFlowgraphs } from './example-flowgraphs.mjs';
import { assertSafeOutputDirectory } from './http-support.mjs';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const ROOT = resolve(SCRIPT_DIR, '..');
const OUT = resolve(process.argv[2] || join(process.cwd(), 'site'));

// runner/build files the browser needs (everything else there is build scratch).
// .py and .json are here for runner/build/pyodide/: the Embedded Python Block's
// shim is real Python fetched at runtime, listed by a generated manifest.json.
// The same walk carries runner/build/js/ -- the repo JavaScript blocks, fetched
// by id at run time (docs/js-blocks.md) -- and runner/build/js_runtime.js, which
// the editor reads to validate a descriptor with the runner's own code.
const RUNTIME_EXT = new Set(['.html', '.js', '.mjs', '.wasm', '.svg', '.css', '.data',
                             '.mem', '.py', '.json']);
const SKIP_DIR = name => name === 'CMakeFiles' || name.endsWith('_autogen');

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

// --- Version-lock the runner build -----------------------------------------
// runner.js, runner.wasm and the category side modules are one indivisible
// build: emcc bakes the EM_ASM string addresses of that link into runner.js's
// ASM_CONSTS table, and a side module's imports only resolve against the main
// module it was linked next to. None of the names carry a version, so a browser
// holding a runner.js from the previous deploy while fetching this deploy's
// runner.wasm crashes in main() with "ASM_CONSTS[code] is not a function" (the
// script is small enough to be reused from the in-memory cache; the 19.5 MB wasm
// is not, so it comes off the network).
//
// Fix: hash the whole runner build and put that stamp in every URL the page
// asks for. runner.html itself is always fetched fresh — the editor appends a
// unique recordingToken — so it is the trustworthy carrier: its <script> srcs
// get ?v=<stamp>, and runner.html's locateFile hook puts the same stamp on
// runner.wasm and the side modules. A deploy moves all of them at once, so
// artifacts from two builds can no longer meet.
async function stampRunnerBuild(destDir, srcFiles) {
  const hash = createHash('sha256');
  for (const f of [...srcFiles].sort()) {
    hash.update(f.split('/').pop() + '\0');
    hash.update(await readFile(f));
  }
  const stamp = hash.digest('hex').slice(0, 12);

  const htmlPath = join(destDir, 'runner.html');
  const html = await readFile(htmlPath, 'utf8');
  const stamped = [];
  let out = html.replace(/(<script[^>]*\ssrc=")([^"?]+\.js)(")/g, (_, pre, src, post) => {
    stamped.push(src);
    return `${pre}${src}?v=${stamp}${post}`;
  });
  // What this guards is not *how many* scripts the page loads -- that was the
  // original check, and every script added to runner.html since has broken this
  // step -- but that every one of them is a file of this build, and so is
  // covered by the hash above. A script from anywhere else would carry a version
  // that says nothing about it, which is worse than not stamping it at all.
  if (!stamped.length)
    throw new Error('runner.html: no external scripts to stamp -- the version lock would be inert');
  for (const src of stamped) {
    if (/^(?:[a-z]+:)?\/\//i.test(src) || src.startsWith('/'))
      throw new Error(`runner.html: <script src="${src}"> is not part of the runner build, ` +
                      'so the build stamp cannot version-lock it');
    await stat(join(destDir, src)).catch(() => {
      throw new Error(`runner.html: <script src="${src}"> was stamped but is not in the ` +
                      'copied runner build -- it would 404 with a ?v= on it');
    });
  }
  if (!out.includes('</head>'))
    throw new Error('runner.html: no </head> to insert the build stamp before');
  out = out.replace('</head>',
    `  <script>window.__grBuildStamp = ${JSON.stringify(stamp)};</script>\n  </head>`);
  if (!html.includes('window.__grBuildStamp'))
    throw new Error('runner.html: locateFile hook is gone — the stamp would not reach runner.wasm');
  await writeFile(htmlPath, out);
  return stamp;
}

async function main() {
  assertSafeOutputDirectory(OUT, ROOT);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 1. Editor UI (Vite build, base path /) -- the editor *is* the site root,
  //    so its index.html/assets/blocks.json land directly in OUT.
  const editorDist = join(ROOT, 'editor', 'dist');
  await stat(editorDist).catch(() => { throw new Error('missing editor/dist -- run `npm run build` in editor first'); });
  await cp(editorDist, OUT, { recursive: true });

  // 2. Runner runtime files (runner.wasm + side modules + qtloader, no scratch).
  const runnerBuild = join(ROOT, 'runner', 'build');
  const runnerFiles = await walkRuntimeFiles(runnerBuild);
  for (const f of runnerFiles) await copyInto(f, ROOT, OUT);
  const stamp = await stampRunnerBuild(join(OUT, 'runner', 'build'), runnerFiles);
  console.log(`runner/build: copied ${runnerFiles.length} runtime files, build stamp ${stamp}`);

  // 3. Example flowgraphs + manifest (matches GET /example_flowgraphs).
  const fgDir = join(ROOT, 'example_flowgraphs');
  const grcFiles = await findExampleFlowgraphs(fgDir);
  await mkdir(join(OUT, 'example_flowgraphs'), { recursive: true });
  for (const f of grcFiles) {
    const destination = join(OUT, 'example_flowgraphs', f);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(fgDir, f), destination);
  }
  await writeFile(join(OUT, 'example_flowgraphs', 'index.json'), JSON.stringify(grcFiles));
  console.log(`example_flowgraphs: ${grcFiles.length} .grc`);

  // 3b. Pyodide, if it has been fetched. It is only needed by a flowgraph that
  //     contains a Python Block, and the whole distribution is version-pinned
  //     by deps/fetch-pyodide.sh, so it is copied verbatim -- no stamping, and
  //     `immutable` cache headers below. A tree that never ran the fetch script
  //     deploys without it, and the Python Block then reports that the runtime
  //     is missing instead of the site failing to assemble.
  const pyodideDir = join(ROOT, 'pyodide');
  const pyodideFiles = await readdir(pyodideDir).catch(() => null);
  if (pyodideFiles) {
    await mkdir(join(OUT, 'pyodide'), { recursive: true });
    for (const f of pyodideFiles.filter(f => !f.startsWith('.')))
      await cp(join(pyodideDir, f), join(OUT, 'pyodide', f));
    console.log(`pyodide: ${pyodideFiles.length} files`);
  } else {
    console.log('pyodide: absent (run deps/fetch-pyodide.sh) -- Python Block will not run');
  }

  // 4. The recording view needs no step of its own: it is the editor build's
  //    second entry, so editor/dist/recording/ came along with the copy of
  //    editor/dist in step 1 and lands at /recording/. It uses hash routing, so
  //    every URL the browser asks Pages for is a file that exists there and the
  //    route rides along after the '#'. Path routing would need Pages to answer
  //    arbitrary paths under /recording/ with index.html, which _redirects
  //    cannot do: a wildcard 200-rewrite is served as a 308 redirect, and
  //    dynamic rules are matched before static assets, so it would swallow the
  //    page's own .js and .css requests as well.

  // 5. Cloudflare control files.
  //    _headers: restore the cross-origin isolation server.mjs sets, so
  //    SharedArrayBuffer + Emscripten pthreads work.
  //    The recording view is served under the same policy: it needs nothing
  //    cross-origin except the recording itself, which is fetched in CORS mode
  //    and so satisfies COEP. (This is also why it carries no Pyodide: that
  //    loads off a CDN, which cross-origin isolation forbids.)
  //
  //    CORP is `cross-origin` rather than `same-origin` so another site can frame
  //    the embedded editor (?embed=1 -- see docs/editor-ui.md). Running a
  //    flowgraph there needs SharedArrayBuffer, so the host page has to be
  //    cross-origin isolated itself, and a COEP: require-corp host may only frame
  //    a document whose CORP names it. Nothing served from this origin is private
  //    -- it is a public static site, and the recordings live in a separate
  //    bucket with its own CORS policy -- so what CORP protects here is not worth
  //    the feature. It stays declared rather than dropped because COEP demands an
  //    explicit CORP on anything cross-origin regardless.
  //
  //    The runner assets are also given a cache lifetime, which Pages otherwise
  //    sets to `max-age=0, must-revalidate` -- a conditional request per file per
  //    Run, and the pthread workers re-request runner.js as well (9 requests on a
  //    repeat visit, all 304s). Safe now only because stampRunnerBuild() puts a
  //    content hash in every URL the page asks for: a new build is a new URL, so
  //    nothing can serve yesterday's runner.js to today's runner.wasm.
  //
  //    A day, not `immutable`, on purpose. `_headers` matches paths, not query
  //    strings, so these rules also cover the UNSTAMPED URLs -- which is what
  //    /runner/build/runner.html requests when opened directly instead of through
  //    the editor (no recordingToken -> no stamp -> the locateFile hook is
  //    inert). Freezing those for a year would let that one hand-debugging path
  //    pin a stale runner.js across deploys and reproduce the very crash the
  //    stamp exists to prevent. A day keeps the win and bounds the exposure.
  //
  //    /pyodide/* gets the same day, for the same reason and one more: Pyodide's
  //    own file names carry no version (pyodide.asm.wasm is pyodide.asm.wasm at
  //    every release) and the interpreter resolves them itself, relative to its
  //    indexURL, so there is no URL we could stamp even if we wanted to.
  //    `immutable` here would pin whatever 16 MB a visitor happened to cache
  //    across a version bump of the pin in deps/fetch-pyodide.sh.
  await writeFile(join(OUT, '_headers'),
`/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: cross-origin

/*.wasm
  Content-Type: application/wasm

/runner/build/*.js
  Cache-Control: public, max-age=86400

/runner/build/js/*
  Cache-Control: public, max-age=86400

/runner/build/*.wasm
  Cache-Control: public, max-age=86400

/pyodide/*
  Cache-Control: public, max-age=86400
`);
  //    _redirects: 200-rewrite the bare flowgraph listing path to its static
  //    manifest. Recordings need no rule: their index and objects come from R2.
  //    The editor itself is served from / by Pages' own index.html handling,
  //    and the recording view is served as static files (see above).
  await writeFile(join(OUT, '_redirects'),
`/example_flowgraphs   /example_flowgraphs/index.json   200
/editor/dist/*        /                                301
`);
  //    404.html: without it Pages answers every unmatched path with the site's
  //    root index.html AND a 200, which is both untidy and a trap for any code
  //    that probes for a path to decide whether it exists.
  await writeFile(join(OUT, '404.html'),
`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="robots" content="noindex" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
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
  <p><a href="/examples/">Browse the example flowgraphs</a></p>
</main>
</body>
</html>
`);

  // 6. Asset size manifest for Help > WebAssembly Modules & Debug Info.
  //    That dialog measured each module with a HEAD request and Content-Length,
  //    which server.mjs answers but Pages does not: its HEAD carries no
  //    Content-Length at all, and a browser GET (always Accept-Encoding: br) is
  //    streamed compressed with no length either, so every Size cell was blank
  //    on the deployed site. `Range` is no help -- Pages ignores it and answers
  //    200 with the whole file. Nothing over HTTP can report these, so write
  //    them down here, where both numbers are knowable.
  //
  //    `br` is what the visitor actually downloads. Pages compresses on the fly
  //    at brotli quality 4 -- measured against the deployed site, node's q4 lands
  //    within 0.3% of what Cloudflare returns on every module tried, while q5+
  //    understates it by 5-10% -- so q4 here is the transfer size, not an
  //    estimate of it. It costs about a second for the whole ~30 MB of wasm.
  const BROTLI_Q4 = size => ({ params: {
    [constants.BROTLI_PARAM_QUALITY]: 4,
    [constants.BROTLI_PARAM_SIZE_HINT]: size,
  } });
  const sizes = {};
  const measure = async (file, url) => {
    const buf = await readFile(file);
    sizes[url] = { bytes: buf.length, br: brotliCompressSync(buf, BROTLI_Q4(buf.length)).length };
  };
  for (const f of await walkRuntimeFiles(join(OUT, 'runner', 'build')))
    if (extname(f) === '.wasm') await measure(f, '/' + relative(OUT, f));
  if (await stat(join(OUT, 'blocks.json')).catch(() => null))
    await measure(join(OUT, 'blocks.json'), '/blocks.json');
  await writeFile(join(OUT, 'asset-sizes.json'), JSON.stringify(sizes));
  console.log(`asset-sizes.json: ${Object.keys(sizes).length} entries`);

  console.log(`\nAssembled site -> ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
