import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// react-plotly.js pulls in plotly's prebuilt dist, so this one package is the
// whole ~4.7 MB of it.
const PLOTLY = /node_modules\/plotly\.js\//;

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
      output: {
        // Plotly is ~4.7 MB, more than the rest of the recording view put
        // together, and only its Time/Frequency/IQ tabs draw with it. Those
        // import it lazily, but that alone does not defer the download: rollup
        // otherwise merges plotly into a chunk the entry needs, so the page
        // pulled all of it before drawing anything.
        manualChunks(id) {
          // Plotly's dist is CommonJS, so the interop helpers end up in its
          // chunk -- and since every other CJS dependency shares those helpers,
          // the entry then has to import that chunk, all 4.7 MB of it. Giving
          // the helpers a chunk of their own breaks that tie.
          if (id.includes('commonjsHelpers')) return 'commonjs-helpers';
          if (PLOTLY.test(id)) return 'plotly';
        },
      },
    },
  },
  plugins: [react({ include: /src\/recording\/.*\.[jt]sx?$/ })],
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin',
                        'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
