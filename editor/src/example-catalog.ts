export interface ExampleDirectory {
  name: string;
  directories: Map<string, ExampleDirectory>;
  files: string[];
}

// Preserve shared/bookmarked links from before the root examples were grouped
// into category folders. New links always use the organized paths.
const LEGACY_EXAMPLE_PATHS: Record<string, string> = {
  'PSK_constellation.grc': 'digital/psk_constellation.grc',
  'recording_waterfall_test.grc': 'recordings/recording_waterfall.grc',
};

export function normalizeExamplePath(name: string): string {
  let path = String(name).replace(/\\/g, '/');
  if (!path.endsWith('.grc')) path += '.grc';
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..'))
    throw new Error('invalid example flowgraph path');
  path = parts.join('/');
  return LEGACY_EXAMPLE_PATHS[path] || path;
}

export function exampleFileName(name: string): string {
  return normalizeExamplePath(name).split('/').pop()!;
}

export function encodeExamplePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function exampleUrl(file: string, href = location.href): string {
  const base = href.split('#')[0].split('?')[0];
  return `${base}#example=${encodeURIComponent(file.replace(/\.grc$/, ''))}`;
}

export function buildExampleTree(files: string[]): ExampleDirectory {
  const root: ExampleDirectory = { name: '', directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split('/');
    const basename = parts.pop()!;
    let directory = root;
    for (const name of parts) {
      let child = directory.directories.get(name);
      if (!child) {
        child = { name, directories: new Map(), files: [] };
        directory.directories.set(name, child);
      }
      directory = child;
    }
    directory.files.push([...parts, basename].join('/'));
  }
  return root;
}

export function exampleTreeCount(directory: ExampleDirectory): number {
  let count = directory.files.length;
  for (const child of directory.directories.values()) count += exampleTreeCount(child);
  return count;
}
