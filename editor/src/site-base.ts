// The one place that knows where this build is mounted. vite.config.ts's
// `base` defaults to '/' (the editor is the site root on Cloudflare Pages and
// under server.mjs), but a standalone deploy under a subpath -- `vite build
// --base=/gnuradio/` -- changes it. Vite rewrites the assets it manages
// itself (bundled JS/CSS, the favicon, index.html's own script tags) for
// that automatically; everything this app fetches or navigates to *at
// runtime* by a hand-written absolute path -- the runner iframe, blocks.json,
// example_flowgraphs, the JS/Python block runtimes -- has to go through this
// helper instead, or it silently 404s under any base but '/'.
//
// import.meta.env.BASE_URL is always Vite's configured base, always with a
// trailing slash (both the default '/' and a custom one are one already).
//
// Several modules that call this at their own top level (block-defs.ts,
// epy.ts, js-block.ts, recording-catalog.ts...) are also bundled standalone
// with plain esbuild for the Node test suite (editor/test/bundle-module.mjs)
// and gen_example_pages.mjs, where there is no Vite and import.meta.env is
// undefined. `?.` makes that resolve to the same '/' those constants were
// hard-coded to before, rather than throwing at import time and taking the
// whole suite down with it.
export function siteUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  return base + path.replace(/^\//, '');
}
