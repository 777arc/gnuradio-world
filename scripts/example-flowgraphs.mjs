import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Return repository-relative, URL-ready paths for every example below `root`.
// Keeping the walk in one place makes the development listing and the static
// deployment manifest byte-for-byte consistent.
export async function findExampleFlowgraphs(root, parts = []) {
  const files = [];
  for (const entry of await readdir(join(root, ...parts), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...await findExampleFlowgraphs(root, [...parts, entry.name]));
    } else if (entry.isFile() && entry.name.endsWith('.grc')) {
      files.push([...parts, entry.name].join('/'));
    }
  }
  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
