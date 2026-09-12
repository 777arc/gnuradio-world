// The GNU Radio wiki's page for a block, shown in the Properties dialog.
//
// The pages are the committed snapshot under blocks/wiki/, published by
// editor/gen/gen_knowledge.mjs as one file per block under /wiki/ beside a
// manifest of the block ids that have one. The manifest is read once at
// startup and is what decides whether a dialog gets a Wiki Docs tab at all;
// the page itself is fetched when that dialog opens. Nothing here shares code
// with Graham's retrieval on purpose: a reader opening one block's dialog
// should not download the whole search index to see its page.
//
// The text is community-edited, so it is rendered into DOM nodes with
// textContent -- never innerHTML -- from the small markdown-like subset the
// snapshot's converter emits: headings, bullet and numbered lists, fenced code,
// and paragraphs.

export const WIKI_INDEX_URL = '/wiki/index.json';
export const wikiPageUrl = (id: string) => `/wiki/${encodeURIComponent(id)}.md`;

let available = new Set<string>();
let loading: Promise<Set<string>> | null = null;

/** Read the manifest; resolves to the block ids with a page. Safe to call again. */
export function loadWikiIndex(fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  if (!loading) {
    loading = (async () => {
      const response = await fetchImpl(WIKI_INDEX_URL);
      if (!response.ok) throw new Error(`${WIKI_INDEX_URL}: HTTP ${response.status}`);
      const ids = await response.json();
      available = new Set(Array.isArray(ids) ? ids.map(String) : []);
      return available;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** Whether the snapshot holds a page for this block -- false until the manifest has loaded. */
export function hasWikiDoc(id: string): boolean {
  return available.has(id);
}

const pages = new Map<string, Promise<string>>();

/** The page's text, without its header comments. Cached per block. */
export function loadWikiDoc(id: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let page = pages.get(id);
  if (!page) {
    page = (async () => {
      const response = await fetchImpl(wikiPageUrl(id));
      if (!response.ok) throw new Error(`no wiki page for ${id} (HTTP ${response.status})`);
      return (await response.text()).replace(/^<!--.*-->\n?/gm, '').trim();
    })();
    pages.set(id, page);
    page.catch(() => pages.delete(id));
  }
  return page;
}

/** The page's header fields (title, source URL, licence), when present. */
export function wikiHeader(raw: string): Record<string, string> {
  return Object.fromEntries([...raw.matchAll(/^<!--\s*(\w+):\s*(.*?)\s*-->$/gm)].map(m => [m[1], m[2]]));
}

/** Markdown-like text to DOM, using only textContent. */
export function renderWikiText(text: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: HTMLElement | null = null;
  let fence: string[] | null = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = doc.createElement('p');
    p.textContent = paragraph.join(' ');
    fragment.appendChild(p);
    paragraph = [];
  };
  const flushList = () => { list = null; };
  for (const line of lines) {
    if (fence) {
      if (/^```/.test(line)) {
        const pre = doc.createElement('pre');
        pre.textContent = fence.join('\n');
        fragment.appendChild(pre);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushParagraph(); flushList(); fence = []; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      // Two levels below the dialog's own headings; deeper wiki levels flatten.
      const h = doc.createElement(heading[1].length <= 2 ? 'h3' : 'h4');
      h.textContent = heading[2];
      fragment.appendChild(h);
      continue;
    }
    const item = /^(-|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const kind = item[1] === '-' ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== kind) {
        list = doc.createElement(kind);
        fragment.appendChild(list);
      }
      const li = doc.createElement('li');
      li.textContent = item[2];
      list.appendChild(li);
      continue;
    }
    // A definition's body, indented under its `- term` by the converter.
    if (list && /^\s{2,}\S/.test(line) && list.lastElementChild) {
      list.lastElementChild.appendChild(doc.createTextNode(` — ${line.trim()}`));
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  if (fence) { const pre = doc.createElement('pre'); pre.textContent = fence.join('\n'); fragment.appendChild(pre); }
  return fragment;
}
