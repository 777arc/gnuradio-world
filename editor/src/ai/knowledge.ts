// Graham's knowledge retrieval: the corpus editor/gen/gen_knowledge.mjs builds
// into /knowledge.json, searched in the browser.
//
// The search is BM25 over a lexical index built here on first use, rather than
// an embedding model on either side. This is a static site whose two free
// providers need nothing of the user's, and retrieval had to work under the
// same terms: nothing new leaves the browser, no key is involved, and nothing
// is fetched but the one file. A few thousand chunks index in milliseconds; the
// corpus is technical prose whose vocabulary the model itself writes queries
// in, which is where lexical retrieval is at its best. A dense index can join
// this one later without changing what the tools return.
//
// Two paths read it. `search_docs`/`read_doc` in tools.ts are the model's own
// deliberate lookups; `seedReferences()` runs on the user's message before it
// is sent, so the first round already carries what the message is about.

export interface KnowledgeChunk {
  id: string;
  source: 'block' | 'wiki' | 'docs' | 'example';
  /** What read_doc takes: a block id, `file#anchor`, an example path. */
  ref: string;
  title: string;
  text: string;
  part?: number;
  parts?: number;
  block?: string;
  url?: string;
}

export interface KnowledgeFile {
  generated: string;
  counts: Record<string, number>;
  chunks: KnowledgeChunk[];
}

export interface SearchHit {
  chunk: KnowledgeChunk;
  score: number;
}

export interface KnowledgeIndex {
  chunks: KnowledgeChunk[];
  search(query: string, options?: { limit?: number; source?: KnowledgeChunk['source'] }): SearchHit[];
  /** Every part of one ref, in order. */
  read(ref: string): KnowledgeChunk[];
}

export const KNOWLEDGE_URL = '/knowledge.json';

const STOP = new Set(('a an and are as at be by for from how i in is it its of on or that the this to ' +
  'was what when which with you your can do does should would will into than then there these those ' +
  'block blocks use using used gnu radio').split(' '));

/** Lowercase word stems; underscores and camel-case split so an id's parts are terms. */
export function tokenize(text: string): string[] {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // A bare number is noise -- "48 kHz" matches every page quoting a rate --
    // while g721 or dvbt2 stay whole.
    .filter(word => word.length > 1 && !STOP.has(word) && !/^\d+$/.test(word))
    .map(stem);
}

function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const K1 = 1.2;
const B = 0.75;
/** Terms in a chunk's title count this many times over the same term in its body. */
const TITLE_WEIGHT = 3;

export function buildIndex(chunks: KnowledgeChunk[]): KnowledgeIndex {
  const postings = new Map<string, Map<number, number>>();
  const lengths = new Float64Array(chunks.length);
  let totalLength = 0;
  chunks.forEach((chunk, index) => {
    const terms = tokenize(chunk.text);
    const titleTerms = tokenize(chunk.title);
    for (let i = 0; i < TITLE_WEIGHT; i++) terms.push(...titleTerms);
    lengths[index] = terms.length;
    totalLength += terms.length;
    for (const term of terms) {
      let list = postings.get(term);
      if (!list) postings.set(term, list = new Map());
      list.set(index, (list.get(index) || 0) + 1);
    }
  });
  const average = chunks.length ? totalLength / chunks.length : 1;
  const byRef = new Map<string, KnowledgeChunk[]>();
  for (const chunk of chunks) {
    const list = byRef.get(chunk.ref);
    if (list) list.push(chunk);
    else byRef.set(chunk.ref, [chunk]);
  }
  return {
    chunks,
    search(query, { limit = 5, source } = {}) {
      const terms = [...new Set(tokenize(query))];
      if (!terms.length) return [];
      const scores = new Map<number, number>();
      for (const term of terms) {
        const list = postings.get(term);
        if (!list) continue;
        const idf = Math.log(1 + (chunks.length - list.size + 0.5) / (list.size + 0.5));
        for (const [index, frequency] of list) {
          const norm = frequency * (K1 + 1) / (frequency + K1 * (1 - B + B * lengths[index] / average));
          scores.set(index, (scores.get(index) || 0) + idf * norm);
        }
      }
      return [...scores]
        .filter(([index]) => !source || chunks[index].source === source)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, limit)
        .map(([index, score]) => ({ chunk: chunks[index], score }));
    },
    read(ref) {
      // The exact ref, plus every section under it: a block id names its own
      // docs chunk and its wiki page's sections (`<id>#<anchor>`) together, and
      // a file name names every section of the file.
      const prefix = `${ref}#`;
      const found = chunks.filter(chunk => chunk.ref === ref || chunk.ref.startsWith(prefix) ||
        (chunk.block === ref && chunk.source === 'wiki'));
      return found.sort((a, b) => (a.part || 0) - (b.part || 0));
    },
  };
}

let loading: Promise<KnowledgeIndex> | null = null;

/** The site's index, fetched once per page on first use. */
export function loadKnowledge(fetchImpl: typeof fetch = fetch): Promise<KnowledgeIndex> {
  if (!loading) {
    loading = (async () => {
      const response = await fetchImpl(KNOWLEDGE_URL);
      if (!response.ok) throw new Error(`${KNOWLEDGE_URL}: HTTP ${response.status}`);
      const file = await response.json() as KnowledgeFile;
      return buildIndex(file.chunks || []);
    })();
    loading.catch(() => { loading = null; });   // a failed fetch is retried next time
  }
  return loading;
}

/** A hit as a tool result: a bounded excerpt naming where the rest is. */
export const EXCERPT_CHARS = 600;
export function excerpt(chunk: KnowledgeChunk, limit = EXCERPT_CHARS): string {
  const text = chunk.text.replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf(' ', limit);
  return `${text.slice(0, cut > limit * 0.6 ? cut : limit)}…`;
}

/**
 * The reference seed for one user message: the few chunks that plainly match
 * it, bounded, or nothing at all. Two thresholds keep it quiet -- a score
 * floor, since "run it again" matches something somewhere, and a share of the
 * best hit, since a second hit far below the first is noise. Seeded into the
 * message rather than the system prompt, as the canvas is, so the cached
 * prefix never changes.
 */
export const SEED_LIMIT = 3;
export const SEED_BYTES = 2000;
export const SEED_MIN_SCORE = 10;
export const SEED_MIN_SHARE = 0.5;
/**
 * Examples are left out of the seed: a chunk listing every block an example
 * uses matches any message naming a common block, and list_examples already
 * answers "an example that does X" by name.
 */
const SEED_SOURCES = new Set<KnowledgeChunk['source']>(['block', 'wiki', 'docs']);

export function seedReferences(index: KnowledgeIndex, message: string): string {
  if (tokenize(message).length < 2) return '';
  const hits = index.search(message, { limit: SEED_LIMIT * 3 })
    .filter(hit => SEED_SOURCES.has(hit.chunk.source)).slice(0, SEED_LIMIT);
  if (!hits.length || hits[0].score < SEED_MIN_SCORE) return '';
  const lines: string[] = [];
  let bytes = 0;
  for (const hit of hits) {
    if (hit.score < hits[0].score * SEED_MIN_SHARE) break;
    const line = `- ${hit.chunk.source} ${hit.chunk.ref} — ${hit.chunk.title}: ${excerpt(hit.chunk, 500)}`;
    if (bytes + line.length > SEED_BYTES && lines.length) break;
    lines.push(line);
    bytes += line.length;
  }
  return lines.length
    ? `[reference — matched to this message; search_docs finds more, read_doc reads one in full]\n${lines.join('\n')}`
    : '';
}
