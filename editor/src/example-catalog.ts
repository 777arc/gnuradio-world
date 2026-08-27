export interface ExampleDirectory {
  name: string;
  directories: Map<string, ExampleDirectory>;
  files: string[];
}

export interface ExampleFlowgraphSummary {
  path: string;
  id: string | null;
  title: string;
  author: string | null;
  copyright: string | null;
  description: string | null;
  fileFormat: string | number | null;
  grcVersion: string | number | null;
  blockCount: number;
  connectionCount: number;
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

const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const optionalScalar = (value: unknown): string | number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return optionalText(value);
};

/** Native Options metadata plus structural counts used by both catalogs. */
export function summarizeExampleFlowgraph(path: string, flowgraph: any): ExampleFlowgraphSummary {
  const params = flowgraph?.options?.parameters || {};
  const metadata = flowgraph?.metadata || {};
  const id = optionalText(params.id);
  return {
    path,
    id,
    title: optionalText(params.title) ?? id ?? exampleFileName(path).replace(/\.grc$/, ''),
    author: optionalText(params.author),
    copyright: optionalText(params.copyright),
    description: optionalText(params.description) ?? optionalText(params.comment),
    fileFormat: optionalScalar(metadata.file_format),
    grcVersion: optionalScalar(metadata.grc_version),
    blockCount: Array.isArray(flowgraph?.blocks) ? flowgraph.blocks.length : 0,
    connectionCount: Array.isArray(flowgraph?.connections) ? flowgraph.connections.length : 0,
  };
}

export function encodeExamplePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function exampleUrl(file: string, href = location.href): string {
  const base = href.split('#')[0].split('?')[0];
  return `${base}#example=${encodeURIComponent(file.replace(/\.grc$/, ''))}`;
}

// ---- the static page generated for each example -----------------------------
// Every example also exists as a real document under /examples/, generated at
// build time by editor/gen/gen_example_pages.mjs. That page is what a search
// engine can index: the fragment above is not a URL a crawler can distinguish
// from the bare editor, so without it the 79 examples are invisible to search.
//
// The slug hyphenates, because a search engine splits words on a hyphen and
// joins them across an underscore -- `fm_loopback` reads as one token,
// `fm-loopback` as two. The .grc keeps its own name; this mapping is the only
// place the two spellings meet, which is why both the generator and the palette
// call it rather than each building the path themselves.
export function exampleSlug(segment: string): string {
  return segment.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** 'analog/fm_loopback.grc' -> 'analog/fm-loopback' */
export function examplePageSlug(path: string): string {
  return normalizeExamplePath(path).replace(/\.grc$/, '').split('/').map(exampleSlug).join('/');
}

/** 'analog/fm_loopback.grc' -> '/examples/analog/fm-loopback/' */
export function examplePageUrl(path: string): string {
  return `/examples/${examplePageSlug(path)}/`;
}

/** The category page an example belongs to, or the hub for a top-level one. */
export function exampleCategoryUrl(path: string): string {
  const parts = examplePageSlug(path).split('/');
  parts.pop();
  return parts.length ? `/examples/${parts.join('/')}/` : '/examples/';
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
