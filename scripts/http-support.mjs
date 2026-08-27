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
  // sitemap.xml, which Pages serves as XML and a crawler expects as XML.
  '.xml': 'application/xml; charset=utf-8',
};

export function contentType(path) {
  return MIME[extname(path)] || 'application/octet-stream';
}

// COOP + COEP are what SharedArrayBuffer and Emscripten's pthreads require.
// CORP is `cross-origin` so another site can frame the embedded editor
// (?embed=1 -- see docs/editor-ui.md): a host page that is itself cross-origin
// isolated sends COEP: require-corp, and such a page may only frame a document
// whose CORP admits it. Everything served here is public static content, so
// there is nothing for the stricter value to protect. Keep this in step with the
// _headers block in scripts/assemble-site.mjs, which is the deployed copy.
export function setIsolationHeaders(response) {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}
