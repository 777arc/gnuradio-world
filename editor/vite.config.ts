import { defineConfig } from 'vite';
// Base path so the built app can be served under /editor/dist by the COOP/COEP server.
export default defineConfig({
  base: '/editor/dist/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin',
                        'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
