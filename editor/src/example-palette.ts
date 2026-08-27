import { parseGrc } from './grc';
import {
  buildExampleTree,
  encodeExamplePath,
  exampleFileName,
  examplePageUrl,
  exampleTreeCount,
  exampleUrl,
  summarizeExampleFlowgraph,
  type ExampleDirectory,
} from './example-catalog';
import { makePaletteSearch } from './palette-tree';

interface ExampleEntry {
  file: string;
  item: HTMLElement;
  blockIds: Set<string> | null;
  text: string;
}

export interface ExamplePaletteDeps {
  activateExamplesTab(): void;
  log(message: string): void;
  copyExampleUrl(file: string): Promise<void>;
  closePaletteDrawer(): void;
  trustExampleJavaScript(flowgraph: any): void;
  loadFlowgraphAnimated(flowgraph: any): void;
  setExampleHash(file: string | null): void;
  setCurrentFileName(file: string | null): void;
  bindFlowgraphRecordings(flowgraph: any, name: string): Promise<void>;
}

export function createExamplePalette(deps: ExamplePaletteDeps) {
  const {
    log,
    copyExampleUrl,
    closePaletteDrawer,
    trustExampleJavaScript,
    loadFlowgraphAnimated,
    setExampleHash,
    setCurrentFileName,
    bindFlowgraphRecordings,
  } = deps;
  const exampleEntries: ExampleEntry[] = [];
  let exampleFilter: { id: string; label: string } | null = null;
  let applyExampleFilter: (() => void) | null = null;

  function showExamplesFor(id: string, label: string) {
    exampleFilter = { id, label };
    deps.activateExamplesTab();   // builds the tab on first visit
    applyExampleFilter?.();             // ...which is why this comes after
    log(`showing example flowgraphs that use "${label}"`);
  }

  async function buildExamples(panel: HTMLElement) {
    const list = document.createElement('div'); list.className = 'ex-list';
    const status = document.createElement('div'); status.className = 'ex-empty'; status.textContent = 'Loading examples…';
    panel.append(status);
    let files: string[] = [];
    try {
      files = await (await fetch('/example_flowgraphs')).json();
    } catch (e) {
      status.textContent = 'Could not load example flowgraphs.';
      log('example flowgraphs not loaded: ' + e); return;
    }
    if (!files.length) { status.textContent = 'No example flowgraphs found.'; return; }
  
    // Search box: matches every whitespace-separated term against the entry's
    // title/author/description/file name, so "estevez afsk" narrows by both. It is
    // independent of the block filter below — both apply at once.
    const { bar: searchBar, input: search } =
      makePaletteSearch('Search examples…', 'Search example flowgraphs');
    let terms: string[] = [];
    const onQuery = () => {
      terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      refresh();
    };
    search.oninput = onQuery;
    search.onkeydown = e => {
      if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; onQuery(); }
    };
  
    // Filter banner: only visible while a block filter is active, and its button
    // is the way back to the full list.
    const bar = document.createElement('div'); bar.className = 'ex-filter'; bar.hidden = true;
    const barText = document.createElement('div'); barText.className = 'ex-filter-text';
    const clear = document.createElement('button'); clear.className = 'ex-filter-clear';
    clear.textContent = 'Show all';
    clear.onclick = () => { exampleFilter = null; refresh(); log('showing all example flowgraphs'); };
    bar.append(barText, clear);
    const noMatch = document.createElement('div'); noMatch.className = 'ex-empty'; noMatch.hidden = true;
  
    const refresh = () => {
      const f = exampleFilter;
      const q = terms.join(' ');
      bar.hidden = !f;
      let shown = 0, pending = 0;
      for (const entry of exampleEntries) {
        const hit = terms.every(t => entry.text.includes(t));
        if (!f) { entry.item.hidden = !hit; if (hit) shown++; continue; }
        if (!entry.blockIds) { entry.item.hidden = true; pending++; continue; }
        const match = entry.blockIds.has(f.id) && hit;
        entry.item.hidden = !match;
        if (match) shown++;
      }
      // A directory stays visible when any descendant is visible. Filtering and
      // searching expand matching paths so the result is not hidden in a closed
      // disclosure; clearing the query leaves the user's open state alone.
      const directories = [...list.querySelectorAll<HTMLDetailsElement>('.ex-directory')].reverse();
      for (const details of directories) {
        const contents = details.querySelector<HTMLElement>(':scope > .ex-directory-contents');
        const hasVisibleChild = !!contents && [...contents.children]
          .some(child => !(child as HTMLElement).hidden);
        details.hidden = !hasVisibleChild;
        if ((f || q) && hasVisibleChild) details.open = true;
      }
      if (f) {
        barText.textContent =
          `Filtered: ${shown} of ${exampleEntries.length} examples use “${f.label}”` +
          (q ? ` and match “${q}”` : '') +
          (pending ? ' (still loading…)' : '');
        noMatch.textContent = pending ? '' : `No example flowgraph uses “${f.label}”${q ? ` and matches “${q}”` : ''}.`;
      } else if (q) {
        noMatch.textContent = `No example flowgraph matches “${q}”.`;
      }
      noMatch.hidden = (!f && !q) || shown > 0 || pending > 0;
    };
    applyExampleFilter = refresh;
  
    // The way to the generated example pages from inside the app. Every row is
    // already a link to one, but those only exist once the palette has rendered;
    // this is here from the first paint and is the entry a reader (or a crawler)
    // finds without opening a directory.
    const browse = document.createElement('div'); browse.className = 'ex-browse';
    const browseLink = document.createElement('a');
    browseLink.href = '/examples/';
    browseLink.target = '_blank';
    browseLink.rel = 'noopener noreferrer';
    browseLink.textContent = 'Browse all examples ↗';
    browseLink.title = 'Open the example flowgraph catalog in a new tab';
    browse.append(browseLink);

    status.remove(); panel.append(searchBar, browse, bar, list, noMatch);
    exampleEntries.length = 0;
    const addExample = (file: string, container: HTMLElement) => {
      // A row, not just the entry, because the copy-link button sits on top of it
      // and neither a button nor an anchor may contain another button.
      const row = document.createElement('div'); row.className = 'ex-row';
      // An anchor, not a button, and it really points at the example's own page
      // under /examples/ (editor/gen/gen_example_pages.mjs). A plain click still
      // loads the flowgraph in place -- the handler below cancels the
      // navigation -- but ctrl/⌘/middle-click open the page in a tab, "copy link
      // address" yields something worth pasting, and a crawler rendering the
      // editor finds a real link to all 79 of them. A <button> offered none of
      // that.
      const item = document.createElement('a'); item.className = 'ex-item';
      item.href = examplePageUrl(file);
      const title = document.createElement('div'); title.className = 'ex-title';
      title.textContent = exampleFileName(file).replace(/\.grc$/, '');
      item.append(title);
      const link = document.createElement('button'); link.className = 'ex-link';
      link.textContent = '🔗'; link.title = `Copy a link to this example (${exampleUrl(file)})`;
      link.setAttribute('aria-label', `Copy a link to ${file}`);
      link.onclick = e => { e.stopPropagation(); void copyExampleUrl(file); };
      row.append(item, link);
      container.append(row);
      const entry: ExampleEntry = { file, item: row, blockIds: null, text: file.toLowerCase() };
      exampleEntries.push(entry);
      // Fetch the file to show its title/description and load it on click.
      fetch('/example_flowgraphs/' + encodeExamplePath(file)).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      }).then(text => {
        const fg = parseGrc(text);
        const summary = summarizeExampleFlowgraph(file, fg);
        const fgTitle = summary.title;
        const fgAuthor = summary.author;
        const fgDesc = summary.description;
        entry.text = [file, fgTitle, fgAuthor, fgDesc].filter(Boolean).join(' ').toLowerCase();
        title.textContent = fgTitle;
        if (fgAuthor) {
          const author = document.createElement('div'); author.className = 'ex-author';
          author.textContent = `by ${fgAuthor}`; item.append(author);
        }
        if (fgDesc) {
          const desc = document.createElement('div'); desc.className = 'ex-desc';
          desc.textContent = fgDesc; item.append(desc);
        }
        const blocks = Array.isArray(fg.blocks) ? fg.blocks : [];
        const n = summary.blockCount;
        entry.blockIds = new Set(blocks.map((b: any) => String(b?.id)));
        refresh();
        const meta = document.createElement('div'); meta.className = 'ex-meta';
        meta.textContent = `${file} · ${n} block${n === 1 ? '' : 's'}`;
        item.append(meta);
        item.onclick = e => {
          // Let the browser have the modified clicks: they are the ones a reader
          // means as "open the page", not "load this into the canvas".
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          try {
            closePaletteDrawer();
            trustExampleJavaScript(fg);
            loadFlowgraphAnimated(fg);
            setExampleHash(file);
            setCurrentFileName(file);
            log(`loaded example "${fgTitle}"`);
            void bindFlowgraphRecordings(fg, fgTitle);
          } catch (err) { log(`failed to load example "${file}": ${err}`); }
        };
      }).catch(err => {
        // An unparseable example can never match a block filter, but it must stop
        // counting as pending or the banner claims it is still loading forever.
        entry.blockIds = new Set(); refresh();
        item.classList.add('disabled'); item.removeAttribute('href');
        title.textContent = `${file} (failed to load)`;
        log(`example "${file}" not loaded: ${err}`);
      });
    };
  
    const renderDirectory = (directory: ExampleDirectory, container: HTMLElement) => {
      const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
      for (const child of [...directory.directories.values()].sort((a, b) => byName(a.name, b.name))) {
        const details = document.createElement('details');
        details.className = 'ex-directory';
        const summary = document.createElement('summary'); summary.className = 'ex-directory-head';
        const name = document.createElement('span'); name.className = 'ex-directory-name';
        name.textContent = child.name;
        const count = document.createElement('span'); count.className = 'ex-directory-count';
        const total = exampleTreeCount(child);
        count.textContent = `${total} example${total === 1 ? '' : 's'}`;
        summary.append(name, count);
        const contents = document.createElement('div'); contents.className = 'ex-directory-contents';
        renderDirectory(child, contents);
        details.append(summary, contents);
        container.append(details);
      }
      for (const file of [...directory.files].sort(byName)) addExample(file, container);
    };
    renderDirectory(buildExampleTree(files), list);
    refresh();
  }
  return { showExamplesFor, buildExamples };
}
