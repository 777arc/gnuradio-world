#!/usr/bin/env node
// Static dev server for the GNU Radio WASM port.
// Sets COOP/COEP so the page is cross-origin isolated -> SharedArrayBuffer +
// Emscripten pthreads work (needed by the thread-per-block scheduler).
// Usage: node server.mjs [port] [absoluteRootDir]
import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.argv[2] || 8080);
const root = normalize(process.argv[3] || new URL('.', import.meta.url).pathname);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.grc': 'application/x-yaml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.data': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  // the rest are only reached by the recording view's assets
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

async function isFile(path) {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // Cross-origin isolation headers on every response, the recording view's
  // included: it fetches the recording in CORS mode, which satisfies COEP.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  try {
    // The recording view needs no special case: it is the editor build's second
    // entry, so /recording/ resolves to editor/dist/recording/index.html through
    // the same fallback the editor itself uses, and its route lives after the
    // '#' where the server never sees it.
    // Directory listing for the example flowgraphs, so the editor can discover
    // whatever .grc files live in example_flowgraphs/ without a manifest.
    if (urlPath === '/example_flowgraphs' || urlPath === '/example_flowgraphs/') {
      const dir = join(root, 'example_flowgraphs');
      const files = (await readdir(dir)).filter(f => f.endsWith('.grc')).sort();
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify(files));
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const direct = normalize(join(root, urlPath));
    if (!direct.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
    // The editor is served at the site root, matching the deployed layout
    // (assemble-site.mjs copies editor/dist to the top of the site). Anything
    // that isn't a file under the repository root resolves against editor/dist/, which
    // is where index.html, assets/ and blocks.json live.
    const filePath = await isFile(direct)
      ? direct
      : normalize(join(root, 'editor', 'dist', urlPath));
    res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
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

server.listen(port, '0.0.0.0', () => {
  console.log(`gnuradio-wasm dev server: http://localhost:${port}/  (root=${root})`);
});
