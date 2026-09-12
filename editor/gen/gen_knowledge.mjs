// Build Graham's knowledge index: editor/public/knowledge.json, the corpus its
// search_docs tool and per-message reference seeding retrieve from.
//
// Usage: node editor/gen/gen_knowledge.mjs   (from anywhere; after gen_blocklib)
//
// Everything in it already lives in the tree or its build outputs, chunked into
// pieces small enough to hand a model whole:
//
//   block     every runnable block's GRC documentation and doxygen prose, out of
//             blocks.json -- the same text describe_block returns, but findable
//             by what a block *does* rather than only by its id
//   wiki      the GNU Radio wiki's page per block, from the committed snapshot
//             under blocks/wiki/ (scripts/fetch-wiki-block-docs.mjs); optional,
//             skipped with a note when the snapshot is absent
//   docs      the user-facing parts of docs/: the runtime rules a flowgraph has
//             to follow here, split at headings
//   example   one chunk per example flowgraph: its title, description, author,
//             and the blocks it uses, so "an example that does X" is answerable
//
// Generated, not committed, like blocks.json: `npm run blocks` in editor/ runs
// it after the palette generator, and the editor's build checks it exists.
// The retrieval itself is in editor/src/ai/knowledge.ts, which reads this file
// lazily on Graham's first Send.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bundleModule } from '../test/bundle-module.mjs';
import { findExampleFlowgraphs } from '../../scripts/example-flowgraphs.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = join(ROOT, 'editor', 'public', 'knowledge.json');
// The wiki pages again, one file per block plus a manifest of which blocks
// have one, for the Properties dialog's Wiki Docs tab: a reader opening one
// block's dialog should not download the whole index to see its page.
const WIKI_OUT = join(ROOT, 'editor', 'public', 'wiki');

/**
 * Chunk size, in characters. A retrieved chunk is handed to the model whole,
 * and a few of them ride on every round of a turn, so they are kept to about
 * a page; a longer section is split at paragraph boundaries into numbered
 * parts that read_doc can reassemble.
 */
export const CHUNK_CHARS = 2400;
export const MIN_CHUNK_CHARS = 80;

/** The docs whose content is about *using* the runtime rather than building it. */
const USER_DOCS = [
  'flowgraph-files.md', 'js-blocks.md', 'schedulers.md', 'audio.md',
  'recording-viewer.md', 'rtlsdr.md', 'plutosdr.md', 'hackrf.md', 'signalhound.md',
  'grwire.md', 'challenges.md', 'gui-layout.md', 'embedded-python.md',
  'rtl433-decoders.md', 'diagnostics.md',
];

const { parseGrc } = await bundleModule('../src/grc.ts');
const catalog = await bundleModule('../src/example-catalog.ts');

/** Split text at paragraph boundaries into pieces of at most CHUNK_CHARS. */
export function splitText(text, limit = CHUNK_CHARS) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (clean.length <= limit) return clean ? [clean] : [];
  const pieces = [];
  let current = '';
  for (const paragraph of clean.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) { current = candidate; continue; }
    if (current) pieces.push(current);
    if (paragraph.length <= limit) { current = paragraph; continue; }
    // One paragraph past the limit on its own: cut it at sentence ends.
    current = '';
    let run = '';
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      const next = run ? `${run} ${sentence}` : sentence;
      if (next.length <= limit) { run = next; continue; }
      if (run) pieces.push(run);
      run = sentence.length <= limit ? sentence : sentence.slice(0, limit);
    }
    current = run;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Markdown split at its headings, each section titled by its heading path. */
export function splitMarkdownSections(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  const path = [];
  let body = [];
  let inFence = false;
  const flush = () => {
    const text = body.join('\n').trim();
    // The heading path below the document's own title, which the caller names.
    if (text) sections.push({ heading: path.slice(1).filter(Boolean).join(' › '), anchor: anchorOf(path.at(-1) || ''), text });
    body = [];
  };
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const heading = !inFence && /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      path.length = Math.max(0, level - 1);
      path[level - 1] = heading[2].replace(/`/g, '').trim();
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

export function anchorOf(heading) {
  return String(heading).toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-');
}

const chunks = [];
const add = (source, ref, title, text, extra = {}) => {
  const parts = splitText(text);
  parts.forEach((part, index) => {
    if (part.length < MIN_CHUNK_CHARS && parts.length === 1 && source !== 'example') return;
    chunks.push({
      id: parts.length > 1 ? `${source}:${ref}#${index + 1}` : `${source}:${ref}`,
      source, ref, title, part: parts.length > 1 ? index + 1 : undefined,
      parts: parts.length > 1 ? parts.length : undefined, text: part, ...extra,
    });
  });
};

// ---- blocks --------------------------------------------------------------------

const libraryPath = join(ROOT, 'editor', 'public', 'blocks.json');
if (!existsSync(libraryPath)) {
  console.error('editor/public/blocks.json is missing: run gen_blocklib.py first (npm run blocks)');
  process.exit(1);
}
const library = JSON.parse(await readFile(libraryPath, 'utf8'));
const runnable = (library.blocks || []).filter(block => block.runnable);
const labelById = new Map(runnable.map(block => [block.id, block.label]));
let blockCount = 0;
for (const block of runnable) {
  const category = Array.isArray(block.category) ? block.category.join(' / ') : String(block.category || '');
  const params = (block.params || []).filter(param => param.id)
    .map(param => `${param.label || param.id} (${param.id})`).join(', ');
  const text = [
    `${block.label} — block id ${block.id}. Category: ${category}.`,
    params ? `Parameters: ${params}.` : '',
    block.documentation ? `\n${block.documentation.trim()}` : '',
    block.api_documentation ? `\n${block.api_documentation.trim()}` : '',
  ].filter(Boolean).join('\n');
  if (!block.documentation && !block.api_documentation) continue;
  add('block', block.id, `${block.label} (${block.id})`, text, { block: block.id });
  blockCount++;
}

// ---- wiki ------------------------------------------------------------------------

const wikiDir = join(ROOT, 'blocks', 'wiki');
let wikiCount = 0;
const wikiIds = [];
await rm(WIKI_OUT, { recursive: true, force: true });
await mkdir(WIKI_OUT, { recursive: true });
if (existsSync(wikiDir)) {
  for (const file of (await readdir(wikiDir)).filter(name => name.endsWith('.md')).sort()) {
    const raw = await readFile(join(wikiDir, file), 'utf8');
    const meta = Object.fromEntries([...raw.matchAll(/^<!--\s*(\w+):\s*(.*?)\s*-->$/gm)].map(m => [m[1], m[2]]));
    const blockId = meta.block || file.replace(/\.md$/, '');
    const body = raw.replace(/^<!--.*-->\n?/gm, '').trim();
    if (!body) continue;
    await writeFile(join(WIKI_OUT, `${blockId}.md`), raw);
    wikiIds.push(blockId);
    const label = labelById.get(blockId) || meta.title || blockId;
    const sections = splitMarkdownSections(body);
    if (sections.length <= 1) {
      add('wiki', blockId, `${label} — GNU Radio wiki`, body, { block: blockId, url: meta.source });
    } else {
      for (const section of sections) {
        add('wiki', `${blockId}#${section.anchor || 'top'}`,
          `${label} — GNU Radio wiki${section.heading ? ` › ${section.heading}` : ''}`,
          section.text, { block: blockId, url: meta.source });
      }
    }
    wikiCount++;
  }
} else {
  console.log('blocks/wiki/ is absent -- no wiki pages indexed (scripts/fetch-wiki-block-docs.mjs creates it)');
}
await writeFile(join(WIKI_OUT, 'index.json'), JSON.stringify(wikiIds));

// ---- docs -------------------------------------------------------------------------

let docCount = 0;
for (const name of USER_DOCS) {
  const path = join(ROOT, 'docs', name);
  if (!existsSync(path)) { console.log(`docs/${name} is absent; skipped`); continue; }
  const markdown = await readFile(path, 'utf8');
  const docTitle = /^#\s+(.*)$/m.exec(markdown)?.[1]?.trim() || name;
  for (const section of splitMarkdownSections(markdown)) {
    add('docs', `${name}#${section.anchor || 'top'}`,
      `${docTitle}${section.heading ? ` › ${section.heading}` : ''}`, section.text,
      { url: `https://github.com/777arc/gnuradio-world/blob/main/docs/${name}` });
  }
  docCount++;
}

// ---- examples ----------------------------------------------------------------------

const examplesRoot = join(ROOT, 'example_flowgraphs');
const examples = await findExampleFlowgraphs(examplesRoot);
let exampleCount = 0;
for (const file of examples) {
  let doc;
  try { doc = parseGrc(await readFile(join(examplesRoot, file), 'utf8')); }
  catch (error) { console.log(`${file}: ${error}`); continue; }
  const summary = catalog.summarizeExampleFlowgraph(file, doc);
  const blocks = [...new Set((doc.blocks || []).map(block => String(block?.id || ''))
    .filter(id => id && id !== 'options' && id !== 'variable'))];
  const labels = blocks.map(id => labelById.get(id) || id);
  const text = [
    `Example flowgraph "${summary.title}" (${file}).`,
    summary.description ? summary.description : '',
    summary.author ? `Author: ${summary.author}.` : '',
    `${summary.blockCount} blocks, ${summary.connectionCount} connections.`,
    labels.length ? `Blocks used: ${labels.join(', ')}.` : '',
    blocks.length ? `Block ids: ${blocks.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  add('example', file.replace(/\.grc$/, ''), `Example: ${summary.title}`, text,
    { url: `https://gnuradioworld.com/#example=${file.replace(/\.grc$/, '')}` });
  exampleCount++;
}

const bytes = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
await writeFile(OUT, JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  counts: { block: blockCount, wiki: wikiCount, docs: docCount, example: exampleCount, chunks: chunks.length },
  chunks,
}));
console.log(`wrote ${chunks.length} chunks (${(bytes / 1024).toFixed(0)} KB of text) to editor/public/knowledge.json: ` +
  `${blockCount} blocks, ${wikiCount} wiki pages, ${docCount} docs, ${exampleCount} examples`);
