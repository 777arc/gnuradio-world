import { extname } from 'node:path';

const MIME = {
  '.css': 'text/css',
  '.data': 'application/octet-stream',
  '.gif': 'image/gif',
  '.grc': 'application/x-yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.py': 'text/x-python; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  // Pyodide's vendored distribution: python_stdlib.zip and the numpy wheel,
  // both fetched by the interpreter itself rather than by the page.
  '.whl': 'application/zip',
  '.zip': 'application/zip',
};

export function contentType(path) {
  return MIME[extname(path)] || 'application/octet-stream';
}

export function setIsolationHeaders(response) {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
