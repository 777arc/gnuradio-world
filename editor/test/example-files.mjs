import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { findExampleFlowgraphs } from '../../scripts/example-flowgraphs.mjs';

export const exampleRoot = fileURLToPath(new URL('../../example_flowgraphs/', import.meta.url));
export const exampleFiles = await findExampleFlowgraphs(exampleRoot);
export const exampleFilePath = file => join(exampleRoot, ...file.split('/'));
