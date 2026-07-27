import { defineConfig } from 'vite';
// Base path '/' -- the editor is the site root, both under the COOP/COEP dev
// server (wasm/server.mjs) and on Cloudflare Pages.
export default defineConfig({
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin',
                        'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
