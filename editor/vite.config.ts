import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error -- plain Node ESM, deliberately not part of the TS program.
import { collectVersions } from './gen/gen_versions.mjs';

// `virtual:versions` -- the stack's version manifest, read out of the pin files
// at build time and frozen into the bundle. A module rather than an asset in
// public/ so it can never be stale or missing: dev and build both go through
// here, and neither needs a generated file checked in. See gen/gen_versions.mjs.
function versionsPlugin(): Plugin {
  const id = 'virtual:versions';
  const resolved = '\0' + id;
  return {
    name: 'gnuradio-world-versions',
    resolveId(source) { return source === id ? resolved : null; },
    load(loadId) {
      if (loadId !== resolved) return null;
      return `export default ${JSON.stringify(collectVersions())};`;
    },
  };
}

// Base path '/' -- the editor is the site root, both under the COOP/COEP dev
// server (server.mjs) and on Cloudflare Pages.
export default defineConfig({
  base: '/',
  resolve: {
    // The recording viewer is vendored from IQEngine, whose sources address each
    // other as '@/...'. Pointing '@' at its own directory keeps those imports
    // byte-identical to upstream, so the two stay diffable. The editor's own
    // sources never use the alias.
    alias: { '@': resolve(__dirname, 'src/recording') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Two pages: the editor at / and the recording view at /recording/.
      input: {
        main: resolve(__dirname, 'index.html'),
        recording: resolve(__dirname, 'recording/index.html'),
      },
    },
  },
  plugins: [react({ include: /src\/recording\/.*\.[jt]sx?$/ }), versionsPlugin()],
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin',
                        'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
