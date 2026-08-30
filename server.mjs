#!/usr/bin/env node
// Static dev server for the GNU Radio WASM port.
// Sets COOP/COEP so the page is cross-origin isolated -> SharedArrayBuffer +
// Emscripten pthreads work (needed by the thread-per-block scheduler).
// Usage: node server.mjs [port] [absoluteRootDir] [bindHost]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { findExampleFlowgraphs } from './scripts/example-flowgraphs.mjs';
import {
  contentType,
  decodeUrlPath,
  devServerRepoAssetAllowed,
  pathIsWithin,
  setIsolationHeaders,
} from './scripts/http-support.mjs';

const port = Number(process.argv[2] || 8080);
const root = resolve(normalize(process.argv[3] || new URL('.', import.meta.url).pathname));
const bindHost = process.argv[4] || '127.0.0.1';

async function isFile(path) {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

const server = http.createServer(async (req, res) => {
  // Cross-origin isolation headers on every response, the recording view's
  // included: it fetches the recording in CORS mode, which satisfies COEP.
  setIsolationHeaders(res);
  const urlPath = decodeUrlPath(req.url);
  if (urlPath === null) {
    res.writeHead(400);
    return res.end('bad request');
  }
  // no-store everywhere, so an edit-reload loop never serves yesterday's build.
  // Pyodide is the exception: 16 MB of a pinned upstream release that no local
  // build can change, and re-downloading it on every Run of a flowgraph with a
  // Python Block makes the block unusable to develop against.
  res.setHeader('Cache-Control',
    urlPath.startsWith('/pyodide/') ? 'public, max-age=86400' : 'no-store');

  try {
    // The recording view needs no special case: it is the editor build's second
    // entry, so /recording/ resolves to editor/dist/recording/index.html through
    // the same fallback the editor itself uses, and its route lives after the
    // '#' where the server never sees it.
    // Recursive listing for the example flowgraphs, so the editor can discover
    // .grc files anywhere below example_flowgraphs/ without a manifest.
    if (urlPath === '/example_flowgraphs' || urlPath === '/example_flowgraphs/') {
      const dir = join(root, 'example_flowgraphs');
      const files = await findExampleFlowgraphs(dir);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify(files));
    }
    // A directory is served by its index.html with or without the trailing
    // slash. Pages 308-redirects the slashless form; matching that here is what
    // keeps /examples/analog/fm-loopback -- the generated example pages, linked
    // with a slash and typed without one -- from 404ing only in development.
    const candidates = urlPath.endsWith('/')
      ? [urlPath + 'index.html']
      : [urlPath, urlPath + '/index.html'];
    // The editor is served at the site root, matching the deployed layout.
    // Only explicitly public runtime artifacts are read from the repository;
    // source, local configuration and .git are never part of the document root.
    const distRoot = join(root, 'editor', 'dist');
    const bases = devServerRepoAssetAllowed(urlPath) ? [root, distRoot] : [distRoot];
    let filePath = null;
    for (const candidate of candidates) {
      for (const base of bases) {
        const resolved = normalize(join(base, candidate));
        if (!pathIsWithin(base, resolved)) { res.writeHead(403); return res.end('forbidden'); }
        filePath ??= await isFile(resolved) ? resolved : null;
      }
      if (filePath) break;
    }
    // Nothing matched: fall through with the plain editor/dist path so the read
    // below fails and the 404 handler answers, as it always has.
    filePath ||= normalize(join(root, 'editor', 'dist', candidates[0]));
    res.setHeader('Content-Type', contentType(filePath));
    // HEAD (used by the editor's debug dialog to read wasm sizes): stat only,
    // report Content-Length, send no body.
    if (req.method === 'HEAD') {
      const s = await stat(filePath);
      res.setHeader('Content-Length', s.size);
      res.writeHead(200);
      return res.end();
    }
    const body = await readFile(filePath);
    res.setHeader('Content-Length', body.length);
    res.writeHead(200);
    res.end(body);
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(404);
    res.end('not found: ' + req.url);
  }
});

server.listen(port, bindHost, () => {
  console.log(`gnuradio-wasm dev server: http://${bindHost}:${port}/  (root=${root})`);
});
