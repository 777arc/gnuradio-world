import { readFile } from 'node:fs/promises';

const read = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8');

export const [
  mainSource,
  bootstrapSource,
  blockDefsSource,
  blockLibrarySource,
  validationSource,
  recordingCatalogSource,
  exampleCatalogSource,
  debugPanelSource,
  htmlSource,
  cssSource,
] = await Promise.all([
  read('../src/main.ts'),
  read('../src/bootstrap.ts'),
  read('../src/block-defs.ts'),
  read('../src/block-library.ts'),
  read('../src/validation.ts'),
  read('../src/recording-catalog.ts'),
  read('../src/example-catalog.ts'),
  read('../src/debug-panel.ts'),
  read('../index.html'),
  read('../src/editor.css'),
]);

// Static browser-wiring tests use this aggregate so moving a declaration among
// focused editor modules does not invalidate an otherwise unchanged contract.
export const editorSource = [
  mainSource,
  bootstrapSource,
  blockDefsSource,
  blockLibrarySource,
  validationSource,
  recordingCatalogSource,
  exampleCatalogSource,
  debugPanelSource,
].join('\n');

export const markupSource = `${htmlSource}\n${cssSource}`;
