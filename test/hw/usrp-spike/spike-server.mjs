// Minimal COOP/COEP static server for the USRP spike only.
// The repo server's dev allowlist (scripts/http-support.mjs) deliberately names
// each harness page, and a throwaway spike has no business editing that list --
// so it gets its own port instead, and leaves the 8090 server alone.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const port = Number(process.argv[2] || 8093);
const root = new URL('.', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript',
                '.wasm': 'application/wasm', '.data': 'application/octet-stream' };

http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = normalize(join(root, path === '/' ? 'usrp_hw.html' : path));
  if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end('forbidden'); }
  try {
    await stat(file);
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', body.length);
    res.writeHead(200); res.end(body);
  } catch { res.writeHead(404); res.end('not found: ' + path); }
}).listen(port, '0.0.0.0', () => console.log(`spike server on http://localhost:${port}/`));
