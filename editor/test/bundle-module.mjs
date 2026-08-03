import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Bundle a browser-side TypeScript module so Node tests can exercise its API. */
export async function bundleModule(relativePath, options = {}) {
  const source = new URL(relativePath, import.meta.url);
  const out = join(tmpdir(), `${basename(relativePath, '.ts')}-test-${process.pid}-${Date.now()}.mjs`);
  await build({
    entryPoints: [source.pathname],
    bundle: true,
    format: 'esm',
    outfile: out,
    logLevel: 'silent',
    ...options,
  });
  return import(pathToFileURL(out));
}
