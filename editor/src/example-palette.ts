import { parseGrc } from './grc';
import { challengeFromGrc, type ChallengeSpec, type ChallengeStatus } from './challenge';
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
  /** The challenge this example states, once its .grc has been parsed. */
  challenge: ChallengeSpec | null;
  /** Repaints this row's lock/tick glyph and its locked styling. */
  paintStatus: (() => void) | null;
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
  /** Where a challenge stands for this browser: passed, unlocked, or locked. */
  challengeStatus(spec: Pick<ChallengeSpec, 'id' | 'requires'>): ChallengeStatus;
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
  // Every challenge the list has seen, by its Challenge ID, so a locked row can
  // name its prerequisite by title rather than by slug. Built from the examples
  // themselves: the chain is stated in the .grc files, nowhere else.
  const challengesById = new Map<string, ChallengeSpec>();
  const challengeName = (id: string) =>
    challengesById.get(id)?.title || id;
  // The challenges each folder holds, collected as the examples' .grc files
  // arrive. Only folders in here get their count line recomputed on a refresh --
  // that runs on every keystroke in the search box, and every other folder keeps
  // the plain count written when it was drawn.
  const challengesByDirectory = new Map<HTMLElement, ChallengeSpec[]>();
  // Set once the Examples tab has been built. Passing a challenge repaints the
  // list through this, so the next one flips from locked without a reload.
  let refreshExamples: (() => void) | null = null;

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
  
    // "6 examples · 2 of 6 passed" on a folder of challenges. Recomputed rather
    // than written once: the tally has to move the moment a challenge is passed,
    // and the examples' .grc files arrive after the folders are drawn.
    const paintDirectoryCount = (details: HTMLElement, challenges: ChallengeSpec[]) => {
      const count = details.querySelector<HTMLElement>(
        ':scope > .ex-directory-head > .ex-directory-count');
      if (!count) return;
      const total = Number(count.dataset.total || challenges.length);
      const passed = challenges
        .filter(spec => deps.challengeStatus(spec) === 'passed').length;
      const text = `${total} example${total === 1 ? '' : 's'}` +
        ` · ${passed} of ${challenges.length} passed`;
      if (count.textContent !== text) count.textContent = text;
    };

    const refresh = () => {
      const f = exampleFilter;
      const q = terms.join(' ');
      bar.hidden = !f;
      let shown = 0, pending = 0;
      for (const entry of exampleEntries) entry.paintStatus?.();   // challenge rows only
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
      for (const [details, specs] of challengesByDirectory)
        paintDirectoryCount(details, specs);
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
    refreshExamples = refresh;
  
    status.remove(); panel.append(searchBar, bar, list, noMatch);
    exampleEntries.length = 0;
    challengesByDirectory.clear();
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
      const entry: ExampleEntry = {
        file, item: row, blockIds: null, text: file.toLowerCase(),
        challenge: null, paintStatus: null,
      };
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
        entry.challenge = challengeFromGrc(fg);
        if (entry.challenge) {
          const spec = entry.challenge;
          if (spec.id) challengesById.set(spec.id, spec);
          for (let node = row.parentElement; node; node = node.parentElement)
            if (node.classList?.contains('ex-directory'))
              challengesByDirectory.set(node, [...(challengesByDirectory.get(node) || []), spec]);
        }
        // A challenge row's glyph, dimming and tooltip all follow the progress
        // store, so they are repainted rather than set once: passing one
        // challenge has to unlock the next without a reload.
        entry.paintStatus = () => {
          const spec = entry.challenge;
          if (!spec) return;
          const status = deps.challengeStatus(spec);
          // The ✅/▶/🔒 glyph is drawn by CSS off this attribute rather than by
          // an element of its own, so `.ex-title` keeps holding exactly the
          // example's title and nothing else -- which is what the palette
          // search and the example harnesses read it for.
          item.dataset.challenge = status;
          item.classList.toggle('locked', status === 'locked');
          const words = status === 'passed' ? 'Challenge passed'
            : status === 'locked'
              ? `Locked — finish “${challengeName(spec.requires)}” first`
              : 'Challenge unlocked, not yet passed';
          item.title = `${words}. ${fgTitle}`;
        };
        entry.paintStatus();
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
          // The lock is soft and palette-only: a #example= deep link and the
          // generated /examples/ page still open a locked challenge, so
          // sharing, bookmarks and search indexing keep working.
          const spec = entry.challenge;
          if (spec && deps.challengeStatus(spec) === 'locked') {
            log(`"${fgTitle}" is locked — finish "${challengeName(spec.requires)}" first`);
            return;
          }
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
        count.dataset.total = String(total);
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
  return { showExamplesFor, buildExamples, refresh: () => refreshExamples?.() };
}
