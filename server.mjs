#!/usr/bin/env node
// Static dev server for the GNU Radio WASM port.
// Sets COOP/COEP so the page is cross-origin isolated -> SharedArrayBuffer +
// Emscripten pthreads work (needed by the thread-per-block scheduler).
// Usage: node wasm/server.mjs [port] [rootDir]
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';

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
};

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

async function listExampleRecordings() {
  const dir = join(root, 'example_recordings');
  const files = await readdir(dir);
  const fileSet = new Set(files);
  const bases = files
    .filter(file => file.endsWith('.sigmf-meta'))
    .map(file => file.slice(0, -'.sigmf-meta'.length))
    .filter(base => fileSet.has(base + '.sigmf-data'))
    .sort((a, b) => a.localeCompare(b));

  const recordings = await Promise.all(bases.map(async name => {
    const dataFile = name + '.sigmf-data';
    const metaFile = name + '.sigmf-meta';
    try {
      const [metadataText, dataStat] = await Promise.all([
        readFile(join(dir, metaFile), 'utf8'),
        stat(join(dir, dataFile)),
      ]);
      const metadata = JSON.parse(metadataText);
      const global = metadata && typeof metadata.global === 'object' ? metadata.global : {};
      const datatype = typeof global['core:datatype'] === 'string' ? global['core:datatype'] : null;
      const sampleRate = typeof global['core:sample_rate'] === 'number' ? global['core:sample_rate'] : null;
      const author = typeof global['core:author'] === 'string' ? global['core:author'] : null;
      const bytesPerSample = sigmfBytesPerSample(datatype);
      const sampleCount = bytesPerSample && dataStat.size % bytesPerSample === 0
        ? dataStat.size / bytesPerSample
        : null;
      return {
        name,
        dataFile,
        metaFile,
        datatype,
        sampleRate,
        author,
        sampleCount,
        byteLength: dataStat.size,
        downloadUrl: '/example_recordings/' + encodeURIComponent(dataFile),
      };
    } catch {
      // A malformed/unreadable metadata document is not a usable SigMF recording.
      return null;
    }
  }));
  return recordings.filter(recording => recording !== null);
}

const server = http.createServer(async (req, res) => {
  // Cross-origin isolation headers on every response.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // Directory listing for the example flowgraphs, so the editor can discover
    // whatever .grc files live in wasm/example_flowgraphs/ without a manifest.
    if (urlPath === '/example_flowgraphs' || urlPath === '/example_flowgraphs/') {
      const dir = join(root, 'example_flowgraphs');
      const files = (await readdir(dir)).filter(f => f.endsWith('.grc')).sort();
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify(files));
    }
    // Only expose complete, parseable SigMF recording pairs. Sample count is
    // calculated without loading the (potentially large) data file.
    if (urlPath === '/example_recordings' || urlPath === '/example_recordings/') {
      let recordings = [];
      try { recordings = await listExampleRecordings(); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify(recordings));
    }
    // Stream recording data rather than passing it through readFile(). This
    // keeps server memory flat and lets the editor report download progress
    // from Content-Length.
    if (urlPath.startsWith('/example_recordings/') && urlPath.endsWith('.sigmf-data')) {
      const requested = urlPath.slice('/example_recordings/'.length);
      const recordings = await listExampleRecordings();
      const recording = recordings.find(item => item.dataFile === requested);
      if (!recording) {
        res.writeHead(404);
        return res.end('recording not found');
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', recording.byteLength);
      const safeName = recording.dataFile.replace(/[^\x20-\x7e]|["\\]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.writeHead(200);
      if (req.method === 'HEAD') return res.end();
      await pipeline(createReadStream(join(root, 'example_recordings', recording.dataFile)), res);
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
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
