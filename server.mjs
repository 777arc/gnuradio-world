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

// The IQEngine client (git submodule), served under /iqengine/ so that
// "open in IQEngine" links from the recordings tab work in dev exactly as they
// do on the deployed site. Build it with:
//   cd iqengine/client && npm ci && npm run build -- --base=/iqengine/
const IQENGINE_PREFIX = '/iqengine';
const IQENGINE_ROOT = normalize(join(root, '..', 'iqengine', 'client', 'build'));

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
  // the rest are only reached by the IQEngine client's assets
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

// Single "bytes=start-end" range only; that is all a browser sends for a
// download or an IQEngine block fetch. Returns null when there is nothing to
// honour (no header, or a form we do not implement -- callers then send the
// whole file, which is always a valid answer).
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start, end;
  if (rawStart === '') {
    if (rawEnd === '') return null;
    start = Math.max(0, size - Number(rawEnd));   // suffix range: last N bytes
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

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
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // Cross-origin isolation headers on every response, IQEngine's included: its
  // spectrogram view fetches the recording in CORS mode, which satisfies COEP.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  try {
    // The IQEngine client is a single-page app: unknown paths under it (its
    // own routes, e.g. /iqengine/view/url/...) fall back to its index.html.
    if (urlPath === IQENGINE_PREFIX || urlPath.startsWith(IQENGINE_PREFIX + '/')) {
      const rest = urlPath.slice(IQENGINE_PREFIX.length).replace(/^\/+/, '');
      const asset = normalize(join(IQENGINE_ROOT, rest));
      const filePath = asset.startsWith(IQENGINE_ROOT) && await isFile(asset)
        ? asset
        : join(IQENGINE_ROOT, 'index.html');
      if (!await isFile(filePath)) {
        res.writeHead(404);
        return res.end('IQEngine is not built: cd iqengine/client && npm ci && npm run build -- --base=/iqengine/');
      }
      res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
      const body = await readFile(filePath);
      res.setHeader('Content-Length', body.length);
      res.writeHead(200);
      return res.end(body);
    }
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
      const dataPath = join(root, 'example_recordings', recording.dataFile);
      res.setHeader('Content-Type', 'application/octet-stream');
      // IQEngine reads a recording in blocks, so byte ranges have to work here
      // the same way they do on R2; without this every FFT it draws would drag
      // down the whole file.
      res.setHeader('Accept-Ranges', 'bytes');
      const range = parseRange(req.headers.range, recording.byteLength);
      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${recording.byteLength}`);
        res.writeHead(416);
        return res.end();
      }
      const safeName = recording.dataFile.replace(/[^\x20-\x7e]|["\\]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      if (range) {
        res.setHeader('Content-Length', range.end - range.start + 1);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${recording.byteLength}`);
        res.writeHead(206);
        if (req.method === 'HEAD') return res.end();
        await pipeline(createReadStream(dataPath, { start: range.start, end: range.end }), res);
        return;
      }
      res.setHeader('Content-Length', recording.byteLength);
      res.writeHead(200);
      if (req.method === 'HEAD') return res.end();
      await pipeline(createReadStream(dataPath), res);
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const direct = normalize(join(root, urlPath));
    if (!direct.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
    // The editor is served at the site root, matching the deployed layout
    // (assemble-site.mjs copies editor/dist to the top of the site). Anything
    // that isn't a file under wasm/ resolves against wasm/editor/dist/, which
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
