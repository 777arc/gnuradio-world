import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  plugins: [react({ include: /src\/recording\/.*\.[jt]sx?$/ })],
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin',
                        'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
