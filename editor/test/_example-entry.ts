// Bundle entry for example-flowgraphs.test.mjs: re-exports the editor modules
// the test needs so esbuild can hand it one importable file.
export { evaluate, buildScope, serializeForRunner } from '../src/expr';
export { parseGrc } from '../src/grc';
