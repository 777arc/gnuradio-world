// Only the vendored recording view has a stylesheet for these to act on; the
// editor's own CSS lives inline in index.html and never reaches PostCSS.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
