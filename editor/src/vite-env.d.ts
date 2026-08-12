/// <reference types="vite/client" />

// The version manifest editor/gen/gen_versions.mjs collects at build time and
// vite.config.ts serves as a module. Shape checked in versions.ts, which is the
// only consumer.
declare module 'virtual:versions' {
  const manifest: unknown;
  export default manifest;
}
