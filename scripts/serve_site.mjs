#!/usr/bin/env node
// Serves an assembled site (scripts/assemble-site.mjs) the way Cloudflare
// Pages serves it, so deploy-only behaviour can be checked without a deploy:
//
//   node scripts/assemble-site.mjs ./site && node scripts/serve_site.mjs ./site
//
// Pages' resolution order, which server.mjs does NOT reproduce:
//   1. static asset wins (a directory serves its index.html)
//   2. otherwise the first matching _redirects rule
//   3. otherwise 404.html, or -- if the site has none -- the root index.html
//      with a 200, which is how a missing page ends up looking like the app
//
// Two deployment bugs came from that third step and from a rewrite whose
// target its own rule matched; both looked perfect under server.mjs. Recording
// files are served from example_recordings (on Pages they come from R2),
// with range support, so an assembled site is fully clickable here.
//
// Usage: node scripts/serve_site.mjs [siteDir] [port]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';

const SITE = normalize(process.argv[2] || join(process.cwd(), 'site'));
const PORT = Number(process.argv[3] || 8098);
const RECORDINGS = join(new URL('..', import.meta.url).pathname, 'example_recordings');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.data': 'application/octet-stream',
};

const rules = (await readFile(join(SITE, '_redirects'), 'utf8').catch(() => ''))
  .split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 3)
  .map(([from, to, status]) => ({ from, to, status: Number(status) }));

const isFile = async path => { try { return (await stat(path)).isFile(); } catch { return false; } };

// A rule matches a path either exactly or, with a trailing splat, by prefix.
function match(rule, path) {
  if (!rule.from.endsWith('*')) return rule.from === path ? rule.to : null;
  const prefix = rule.from.slice(0, -1);
  return path.startsWith(prefix) ? rule.to.replace(':splat', path.slice(prefix.length)) : null;
}

const server = http.createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const send = async (file, status = 200) => {
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    const body = await readFile(file);
    res.setHeader('Content-Length', body.length);
    res.writeHead(status);
    res.end(body);
  };

  // Recordings, with range support, standing in for the R2 bucket.
  if (path.startsWith('/example_recordings/')) {
    const file = join(RECORDINGS, path.slice('/example_recordings/'.length));
    if (!await isFile(file)) { res.writeHead(404); return res.end('recording not found'); }
    const size = (await stat(file)).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      res.writeHead(206);
      if (req.method === 'HEAD') return res.end();
      return pipeline(createReadStream(file, { start, end }), res);
    }
    res.setHeader('Content-Length', size);
    res.writeHead(200);
    if (req.method === 'HEAD') return res.end();
    return pipeline(createReadStream(file), res);
  }

  try {
    // 1. static asset
    const direct = normalize(join(SITE, path));
    if (!direct.startsWith(SITE)) { res.writeHead(403); return res.end('forbidden'); }
    if (await isFile(direct)) return send(direct);
    if (await isFile(join(direct, 'index.html'))) return send(join(direct, 'index.html'));

    // 2. _redirects, first match wins
    for (const rule of rules) {
      const to = match(rule, path);
      if (!to) continue;
      if (rule.status !== 200) {
        res.writeHead(rule.status, { Location: to });
        return res.end();
      }
      // Pages drops a 200-rewrite whose target its own rule matches again --
      // the loop case -- and falls through to the not-found handling below.
      if (match(rule, to)) {
        console.warn(`_redirects: "${rule.from} -> ${to}" is self-matching, Pages ignores it`);
        break;
      }
      const target = normalize(join(SITE, to));
      if (await isFile(target)) return send(target);
      if (await isFile(join(target, 'index.html'))) return send(join(target, 'index.html'));
      console.warn(`_redirects: "${rule.from} -> ${to}" has no such target in the site`);
      break;
    }

    // 3. not found
    if (await isFile(join(SITE, '404.html'))) return send(join(SITE, '404.html'), 404);
    return send(join(SITE, 'index.html'));   // what Pages does without a 404.html
  } catch (error) {
    if (res.headersSent) return res.destroy();
    res.writeHead(500);
    res.end(String(error));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`pages-like server: http://localhost:${PORT}/  (site=${SITE})`);
});
