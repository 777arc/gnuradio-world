#!/usr/bin/env node
// Static dev server for the GNU Radio WASM port.
// Sets COOP/COEP so the page is cross-origin isolated -> SharedArrayBuffer +
// Emscripten pthreads work (needed by the thread-per-block scheduler).
// Usage: node wasm/server.mjs [port] [rootDir]
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.argv[2] || 8080);
const root = normalize(process.argv[3] || new URL('.', import.meta.url).pathname);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.data': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  // Cross-origin isolation headers on every response.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // Directory listing for the example flowgraphs, so the editor can discover
    // whatever .json files live in wasm/example_flowgraphs/ without a manifest.
    if (urlPath === '/example_flowgraphs' || urlPath === '/example_flowgraphs/') {
      const dir = join(root, 'example_flowgraphs');
      const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify(files));
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
    const body = await readFile(filePath);
    res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
    res.writeHead(200);
    res.end(body);
  } catch (e) {
    res.writeHead(404);
    res.end('not found: ' + req.url);
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`gnuradio-wasm dev server: http://localhost:${port}/  (root=${root})`);
});
