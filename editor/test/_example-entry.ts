// Bundle entry for example-flowgraphs.test.mjs: re-exports the editor modules
// the test needs so esbuild can hand it one importable file.
export { evaluate, buildScope, serializeForRunner } from '../src/expr';
export { parseGrc } from '../src/grc';
// ... and the effective block schemas, so the test can check that a file's
// parameter *ids* are ones the editor will actually keep.
export { installGeneratedBlocks } from '../src/block-library';
export { RUNNABLE } from '../src/block-defs';
