import {
  displayBytes,
  displayDuration,
  displayRecordingValue,
  displaySi,
  recordingDuration,
  recordingUrl,
  sigmfFileSourceFormat,
  type ExampleRecording,
  type FileSourceFormat,
} from './recording-catalog';
import {
  CATEGORY_BLURBS,
  UNSORTED_CATEGORY,
  categorize,
  compareBands,
  recordingBandLabel,
  recordingBandOf,
  recordingCategory,
  splitRecordings,
  type CategorySummary,
  type RecordingFacet,
} from './recording-taxonomy';
import { makePaletteSearch } from './palette-tree';

export interface RecordingPaletteDeps {
  loadExampleRecordings(): Promise<ExampleRecording[]>;
  openRecordingPreview(recording: ExampleRecording): void;
  copyRecordingUrl(name: string): Promise<void>;
  addRecordingBlock(recording: ExampleRecording, format: FileSourceFormat): Promise<void>;
  closePaletteDrawer(): void;
  log(message: string): void;
}

// A flat result list can run long; a section inside a category should stay a
// glance. Both grow on demand rather than truncating silently.
const PAGE_SIZE = 50;
const SECTION_PAGE_SIZE = 12;

// An RF capture whose metadata never recorded a centre frequency. Filterable, so
// the gap can be found and filled, but deliberately not a band.
const UNKNOWN_BAND = 'Unknown centre frequency';

type RecordingSort = 'name' | 'frequency' | 'duration' | 'newest' | 'size';

const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function selectControl(label: string, options: Array<[string, string]>): HTMLLabelElement {
  const wrapper = document.createElement('label'); wrapper.className = 'rec-control';
  const text = document.createElement('span'); text.textContent = label;
  const select = document.createElement('select'); select.setAttribute('aria-label', label);
  for (const [value, name] of options) {
    const option = document.createElement('option'); option.value = value; option.textContent = name;
    select.append(option);
  }
  wrapper.append(text, select);
  return wrapper;
}

function checkControl(label: string): HTMLLabelElement {
  const wrapper = document.createElement('label'); wrapper.className = 'rec-check';
  const input = document.createElement('input'); input.type = 'checkbox';
  const text = document.createElement('span'); text.textContent = label;
  wrapper.append(input, text);
  return wrapper;
}

function facetOptions(recordings: ExampleRecording[], getValue: (recording: ExampleRecording) => string,
                      allLabel: string, compare = byName,
                      displayValue: (value: string) => string = value => value): Array<[string, string]> {
  const counts = new Map<string, number>();
  for (const recording of recordings) {
    const value = getValue(recording);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [['', allLabel], ...[...counts].sort(([a], [b]) => compare(a, b))
    .map(([value, count]): [string, string] => [value, `${displayValue(value)} (${count})`])];
}

function recordingSearchText(recording: ExampleRecording): string {
  return [
    recording.title,
    recording.name,
    recording.author,
    recording.description,
    recording.datatype,
    recordingCategory(recording),
    ...recording.tags,
    ...recording.annotationLabels,
    recordingBandOf(recording),
    recording.frequency,
    displaySi(recording.frequency, 'Hz'),
    recording.sampleRate,
    displaySi(recording.sampleRate, 'Hz'),
  ].filter(value => value !== null && value !== '').join(' ').toLowerCase();
}

function relevance(recording: ExampleRecording, query: string, terms: string[]): number {
  if (!query) return 0;
  const title = recording.title.toLowerCase();
  const name = recording.name.toLowerCase();
  const tags = recording.tags.map(tag => tag.toLowerCase());
  let score = title === query ? 100 : title.startsWith(query) ? 70 : title.includes(query) ? 50 : 0;
  if (name.includes(query)) score += 30;
  for (const term of terms) {
    if (tags.includes(term)) score += 25;
    else if (tags.some(tag => tag.includes(term))) score += 12;
  }
  return score;
}

export function createRecordingPalette(deps: RecordingPaletteDeps) {
  const {
    loadExampleRecordings,
    openRecordingPreview,
    copyRecordingUrl,
    addRecordingBlock,
    closePaletteDrawer,
    log,
  } = deps;

  function makeRecordingItem(recording: ExampleRecording): HTMLElement {
    const item = document.createElement('article'); item.className = 'rec-item';

    // The spectrogram, when one has been rendered: the card's left third, square,
    // with the text and actions in the right two-thirds. It is rendered square at
    // source rather than being squeezed into shape here -- a 4:1 strip in this box
    // would either crop the frequency axis away or stretch time four times.
    if (recording.thumbnailUrl) {
      item.classList.add('has-thumb');
      const strip = document.createElement('img'); strip.className = 'rec-thumb';
      // crossOrigin before src, and not optional: the editor is served with
      // COEP require-corp so SharedArrayBuffer works, which blocks every
      // cross-origin subresource that is neither CORS-fetched nor marked
      // Cross-Origin-Resource-Policy by its host. The bucket already allows this
      // origin (scripts/r2-cors.json), so asking for CORS is all it takes --
      // without it the image 200s and is discarded, which looks exactly like a
      // 404 from here.
      strip.crossOrigin = 'anonymous';
      strip.src = recording.thumbnailUrl;
      strip.loading = 'lazy'; strip.decoding = 'async';
      strip.width = 128; strip.height = 128;
      strip.alt = `Spectrogram of ${recording.title}`;
      // A thumbnail is a nicety: a bucket that has not been rendered yet, or one
      // object that failed to upload, must not leave a broken-image box in the
      // middle of the catalog.
      strip.onerror = () => { strip.remove(); item.classList.remove('has-thumb'); };
      item.append(strip);
    }

    // The body column. It carries the container query rather than the card,
    // because what decides whether the actions fit beside the title is the width
    // left *after* the thumbnail has taken its third.
    const body = document.createElement('div'); body.className = 'rec-body-col';
    const head = document.createElement('div'); head.className = 'rec-head';
    const identity = document.createElement('div'); identity.className = 'rec-identity';
    const title = document.createElement('div'); title.className = 'rec-title';
    title.textContent = recording.title;
    const nameParts = recording.name.split('/');
    if (recording.title !== nameParts[nameParts.length - 1]) title.title = recording.name;

    const facts = [
      recording.author,
      displaySi(recording.frequency, 'Hz'),
      displaySi(recording.sampleRate, 'S/s'),
      displayDuration(recordingDuration(recording)),
    ].filter(value => value && value !== '—');
    const summary = document.createElement('div'); summary.className = 'rec-summary';
    summary.textContent = facts.length ? facts.join(' · ') : 'Metadata unavailable';

    const tags = document.createElement('div'); tags.className = 'rec-tags';
    const visibleTags = recording.tags.slice(0, 4);
    for (const tag of visibleTags) {
      const chip = document.createElement('span'); chip.className = 'rec-tag'; chip.textContent = tag;
      tags.append(chip);
    }
    if (recording.annotationCount) {
      const chip = document.createElement('span'); chip.className = 'rec-tag rec-annotated';
      chip.textContent = `${recording.annotationCount} annotation${recording.annotationCount === 1 ? '' : 's'}`;
      tags.append(chip);
    }
    identity.append(title, summary);
    if (tags.childElementCount) identity.append(tags);

    const actions = document.createElement('div'); actions.className = 'rec-actions';
    const view = document.createElement('button'); view.className = 'rec-action';
    view.type = 'button'; view.textContent = 'View';
    view.title = `Open the recording view of "${recording.name}"`;
    view.onclick = () => openRecordingPreview(recording);

    const sourceFormat = sigmfFileSourceFormat(recording.datatype);
    const add = document.createElement('button'); add.className = 'rec-action rec-add';
    add.type = 'button'; add.textContent = 'Add';
    if (!sourceFormat) {
      add.disabled = true;
      add.title = `GR World Recording cannot represent ${recording.datatype || 'this datatype'}`;
    } else {
      add.title = `Add "${recording.title}" to the flowgraph`;
      add.onclick = () => {
        closePaletteDrawer();
        void addRecordingBlock(recording, sourceFormat)
          .catch(error => log(`recording "${recording.name}" could not be added: ${error}`));
      };
    }

    const more = document.createElement('button'); more.className = 'rec-action rec-more';
    more.type = 'button'; more.textContent = 'Details'; more.setAttribute('aria-expanded', 'false');
    actions.append(view, add, more);
    head.append(identity, actions);

    const details = document.createElement('div'); details.className = 'rec-details'; details.hidden = true;
    if (recording.description) {
      const description = document.createElement('p'); description.className = 'rec-description';
      description.textContent = recording.description; details.append(description);
    }
    const props = document.createElement('dl'); props.className = 'rec-props';
    const addProperty = (label: string, value: string | number | null) => {
      const key = document.createElement('dt'); key.textContent = label;
      const val = document.createElement('dd'); val.textContent = displayRecordingValue(value);
      props.append(key, val);
    };
    addProperty('Key', recording.name);
    addProperty('Author', recording.author);
    addProperty('Data type', recording.datatype);
    addProperty('Samples', displaySi(recording.sampleCount, ''));
    addProperty('Size', displayBytes(recording.byteLength));
    addProperty('Captured', recording.captureDatetime);
    details.append(props);

    const detailActions = document.createElement('div'); detailActions.className = 'rec-detail-actions';
    const link = document.createElement('button'); link.className = 'rec-detail-link';
    link.type = 'button'; link.textContent = 'Copy link';
    link.title = `Copy ${recordingUrl(recording.name)}`;
    link.onclick = () => { void copyRecordingUrl(recording.name); };
    detailActions.append(link);
    const addDownloadLink = (label: string, url: string, fileName: string) => {
      const anchor = document.createElement('a'); anchor.className = 'rec-dl';
      anchor.href = url; anchor.download = fileName.split('/').pop()!; anchor.rel = 'noopener';
      anchor.textContent = label; detailActions.append(anchor);
    };
    addDownloadLink('Data file', recording.downloadUrl, recording.dataFile);
    addDownloadLink('Metadata file', recording.metadataUrl, recording.metaFile);
    details.append(detailActions);

    more.onclick = () => {
      details.hidden = !details.hidden;
      more.setAttribute('aria-expanded', String(!details.hidden));
      more.textContent = details.hidden ? 'Details' : 'Hide details';
    };
    body.append(head);
    item.append(body, details);
    return item;
  }

  async function buildRecordings(panel: HTMLElement) {
    const status = document.createElement('div'); status.className = 'ex-empty';
    status.textContent = 'Loading recordings…'; panel.append(status);
    let recordings: ExampleRecording[] = [];
    try {
      recordings = await loadExampleRecordings();
    } catch (error) {
      status.textContent = 'Could not load recordings.';
      log('recordings not loaded: ' + error); return;
    }
    if (!recordings.length) { status.textContent = 'No signal recordings found.'; return; }

    // The search haystack is rebuilt on every keystroke otherwise -- once per
    // recording per term -- which is unnoticeable at 150 recordings and is not
    // at 500. Nothing about a recording changes after the index is parsed.
    const searchText = new WeakMap<ExampleRecording, string>();
    for (const recording of recordings) searchText.set(recording, recordingSearchText(recording));

    const categories = categorize(recordings);
    const byCategory = new Map(categories.map(entry => [entry.category, entry]));
    // Computed per category rather than per render: the refine chips must not
    // vanish as soon as one of them is used.
    const splits = new Map(categories.map(entry =>
      [entry.category, splitRecordings(entry.recordings)] as const));

    const { bar: searchBar, input: search } =
      makePaletteSearch('Search all recordings…', 'Search signal recordings');
    const controls = document.createElement('div'); controls.className = 'rec-controls';
    // Labelled with their frequency ranges and ordered by frequency: "SHF" alone
    // is not a number anyone holds in their head, and alphabetical band order is
    // meaningless.
    const band = selectControl('Band', facetOptions(recordings,
      recording => recordingBandOf(recording) ?? UNKNOWN_BAND, 'All bands',
      compareBands, recordingBandLabel));
    const dataFormat = selectControl('Format', facetOptions(
      recordings, recording => recording.datatype ?? 'Unknown', 'All formats'));
    const sort = selectControl('Sort', [
      ['name', 'Name'], ['frequency', 'Frequency'], ['duration', 'Duration'],
      ['newest', 'Newest'], ['size', 'Size'],
    ]);
    const annotated = checkControl('Annotated');
    controls.append(band, dataFormat, annotated, sort);

    // Browsing is the categories; these narrow whatever is on screen. They stay
    // behind a disclosure because the header would otherwise be taller than the
    // results, and the badge reports how many are still narrowing things.
    const filterToggle = document.createElement('button');
    filterToggle.type = 'button'; filterToggle.className = 'rec-filter-toggle';
    filterToggle.setAttribute('aria-expanded', 'false');
    const filterCaret = document.createElement('span'); filterCaret.className = 'rec-filter-caret';
    filterCaret.textContent = '▸';
    const filterLabel = document.createElement('span'); filterLabel.textContent = 'Filters & sorting';
    const filterBadge = document.createElement('span');
    filterBadge.className = 'rec-filter-badge'; filterBadge.hidden = true;
    filterToggle.append(filterCaret, filterLabel, filterBadge);
    controls.hidden = true;
    filterToggle.onclick = () => {
      controls.hidden = !controls.hidden;
      filterToggle.setAttribute('aria-expanded', String(!controls.hidden));
      filterCaret.textContent = controls.hidden ? '▸' : '▾';
    };

    const crumbs = document.createElement('nav'); crumbs.className = 'rec-crumbs';
    crumbs.hidden = true;
    const catalogStatus = document.createElement('div'); catalogStatus.className = 'rec-catalog-status';
    const resultCount = document.createElement('span');
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'rec-clear';
    clear.textContent = 'Clear filters'; clear.hidden = true;
    catalogStatus.append(resultCount, clear);

    const body = document.createElement('div'); body.className = 'rec-body';
    status.remove();
    searchBar.append(filterToggle, controls, crumbs, catalogStatus);
    panel.append(searchBar, body);

    const selectOf = (label: HTMLLabelElement) => label.querySelector('select')!;
    const checkOf = (label: HTMLLabelElement) => label.querySelector('input')!;

    // ---- browse state -----------------------------------------------------
    let activeCategory: string | null = null;
    let refine: { facet: RecordingFacet; value: string } | null = null;
    let flatLimit = PAGE_SIZE;
    const sectionLimits = new Map<string, number>();
    // Which sections the reader has opened, so a re-render (a chip, a filter)
    // does not shut them again.
    const openSections = new Set<string>();

    const activeFilters = () =>
      [selectOf(band).value, selectOf(dataFormat).value].filter(Boolean).length +
      (checkOf(annotated).checked ? 1 : 0);

    const passesFilters = (recording: ExampleRecording): boolean => {
      const bandValue = selectOf(band).value;
      const formatValue = selectOf(dataFormat).value;
      return (!bandValue || (recordingBandOf(recording) ?? UNKNOWN_BAND) === bandValue) &&
        (!formatValue || (recording.datatype ?? 'Unknown') === formatValue) &&
        (!checkOf(annotated).checked || recording.annotationCount > 0);
    };

    const sorted = (entries: ExampleRecording[], query: string, terms: string[]) => {
      const sortValue = selectOf(sort).value as RecordingSort;
      return [...entries].sort((a, b) => {
        const score = relevance(b, query, terms) - relevance(a, query, terms);
        if (score) return score;
        if (sortValue === 'frequency') return (a.frequency ?? Infinity) - (b.frequency ?? Infinity);
        if (sortValue === 'duration')
          return (recordingDuration(b) ?? -1) - (recordingDuration(a) ?? -1);
        if (sortValue === 'newest')
          return (Date.parse(b.captureDatetime ?? '') || 0) - (Date.parse(a.captureDatetime ?? '') || 0);
        if (sortValue === 'size') return b.byteLength - a.byteLength;
        return byName(a.title, b.title) || byName(a.name, b.name);
      });
    };

    const makeGrid = (entries: ExampleRecording[]): HTMLElement => {
      const grid = document.createElement('div'); grid.className = 'rec-grid';
      for (const recording of entries) grid.append(makeRecordingItem(recording));
      return grid;
    };

    /**
     * One collapsible section, closed unless the reader opened it.
     *
     * Closed by default is the point of the whole view: a category's headings
     * are the answer to "what is in here", and 53 FSK cards unfurled under the
     * first of them buries the other four. A `<details>` so the browser owns the
     * open/close, and the cards are built on first expand rather than up front,
     * so a category costs its headings and nothing more until asked.
     */
    const appendSection = (container: HTMLElement, key: string, heading: string,
                           total: number, entries: ExampleRecording[],
                           openByDefault = false) => {
      const section = document.createElement('details'); section.className = 'rec-group';
      const title = document.createElement('summary'); title.className = 'rec-group-title';
      const caret = document.createElement('span'); caret.className = 'rec-group-caret';
      const name = document.createElement('span'); name.className = 'rec-group-name';
      name.textContent = heading;
      const count = document.createElement('span'); count.textContent = String(total);
      title.append(caret, name, count);
      const contents = document.createElement('div'); contents.className = 'rec-group-contents';
      section.append(title, contents);

      const fill = () => {
        const limit = sectionLimits.get(key) ?? SECTION_PAGE_SIZE;
        contents.replaceChildren(makeGrid(entries.slice(0, limit)));
        if (entries.length > limit) {
          const more = document.createElement('button');
          more.type = 'button'; more.className = 'rec-show-more';
          more.textContent = `Show ${Math.min(SECTION_PAGE_SIZE, entries.length - limit)} more`;
          // Only this section's contents are rebuilt: a full render would close
          // every other section the reader has open.
          more.onclick = () => { sectionLimits.set(key, limit + SECTION_PAGE_SIZE); fill(); };
          contents.append(more);
        }
      };

      section.open = openSections.has(key) || openByDefault;
      if (section.open) fill();
      section.ontoggle = () => {
        if (section.open) { openSections.add(key); if (!contents.childElementCount) fill(); }
        else openSections.delete(key);
      };
      container.append(section);
    };

    const emptyNote = (text: string): HTMLElement => {
      const note = document.createElement('div'); note.className = 'ex-empty';
      note.textContent = text; return note;
    };

    // ---- the three views --------------------------------------------------

    const renderLanding = () => {
      const tiles = document.createElement('div'); tiles.className = 'rec-tiles';
      for (const entry of categories) {
        const tile = document.createElement('button');
        tile.type = 'button'; tile.className = 'rec-tile';
        if (entry.category === UNSORTED_CATEGORY) tile.classList.add('rec-tile-unsorted');
        const name = document.createElement('span'); name.className = 'rec-tile-name';
        name.textContent = entry.category;
        const count = document.createElement('span'); count.className = 'rec-tile-count';
        count.textContent = String(entry.recordings.length);
        const blurb = document.createElement('span'); blurb.className = 'rec-tile-blurb';
        blurb.textContent = CATEGORY_BLURBS[entry.category] ?? '';
        tile.append(name, count, blurb);
        // A preview of the sections behind the tile, so the click is informed.
        const split = splits.get(entry.category);
        if (split?.facet && split.groups.length) {
          const inside = document.createElement('span'); inside.className = 'rec-tile-inside';
          inside.textContent = split.groups.slice(0, 3).map(group => group.value).join(' · ') +
            (split.groups.length > 3 ? ' …' : '');
          tile.append(inside);
        }
        tile.onclick = () => {
          activeCategory = entry.category;
          refine = null; sectionLimits.clear(); openSections.clear();
          flatLimit = PAGE_SIZE;
          body.scrollTop = 0;
          render();
        };
        tiles.append(tile);
      }
      body.append(tiles);
    };

    const renderCategory = (entry: CategorySummary) => {
      const split = splits.get(entry.category)!;
      const blurb = CATEGORY_BLURBS[entry.category];
      if (blurb) {
        const line = document.createElement('p'); line.className = 'rec-category-blurb';
        line.textContent = blurb; body.append(line);
      }

      // Refine chips come from the runner-up facet: the axis that was the second
      // best way to organize this category is exactly the one worth offering as
      // a filter once the best one is already the headings.
      const chipFacet = split.runnersUp[0];
      if (chipFacet) {
        const values = new Map<string, number>();
        for (const recording of entry.recordings) {
          const value = chipFacet.value(recording);
          if (value) values.set(value, (values.get(value) ?? 0) + 1);
        }
        if (values.size > 1) {
          const chips = document.createElement('div'); chips.className = 'rec-chips';
          const label = document.createElement('span'); label.className = 'rec-chips-label';
          label.textContent = chipFacet.label; chips.append(label);
          for (const [value, count] of [...values].sort((a, b) => b[1] - a[1])) {
            const chip = document.createElement('button');
            chip.type = 'button'; chip.className = 'rec-chip';
            chip.textContent = `${value} (${count})`;
            const active = refine?.facet.id === chipFacet.id && refine.value === value;
            chip.classList.toggle('active', active);
            chip.setAttribute('aria-pressed', String(active));
            chip.onclick = () => {
              refine = active ? null : { facet: chipFacet, value };
              sectionLimits.clear(); render();
            };
            chips.append(chip);
          }
          body.append(chips);
        }
      }

      const visible = entry.recordings.filter(recording =>
        passesFilters(recording) &&
        (!refine || refine.facet.value(recording) === refine.value));
      if (!visible.length) {
        body.append(emptyNote('No recording here matches the selected filters.'));
        return;
      }

      // The split is recomputed over what is actually on screen, so refining to
      // one band still shows that band organized by the category's own axis.
      const shown = splitRecordings(visible);
      if (!shown.facet) {
        body.append(makeGrid(sorted(visible, '', [])));
        return;
      }
      for (const group of shown.groups)
        appendSection(body, `${entry.category}/${group.value}`, group.value,
          group.recordings.length, sorted(group.recordings, '', []));
      if (shown.unlabelled.length)
        appendSection(body, `${entry.category}/~`, `No ${shown.facet.label.toLowerCase()} recorded`,
          shown.unlabelled.length, sorted(shown.unlabelled, '', []));
    };

    const renderResults = (query: string, terms: string[]) => {
      const matched = recordings.filter(recording =>
        passesFilters(recording) &&
        terms.every(term => (searchText.get(recording) ?? '').includes(term)));
      if (!matched.length) {
        body.append(emptyNote(`No signal recording matches “${query}” and the selected filters.`));
        return;
      }
      // Search is global from wherever the reader is standing, but a category
      // they opened deliberately still leads -- what it did not match is offered
      // below rather than hidden.
      const here = activeCategory
        ? matched.filter(recording => recordingCategory(recording) === activeCategory) : [];
      const elsewhere = activeCategory
        ? matched.filter(recording => recordingCategory(recording) !== activeCategory) : matched;
      if (activeCategory && here.length)
        appendSection(body, 'search/here', `In ${activeCategory}`, here.length,
          sorted(here, query, terms), true);
      if (elsewhere.length) {
        const heading = activeCategory ? 'Elsewhere in the catalog' : 'Matching recordings';
        const entries = sorted(elsewhere, query, terms);
        const section = document.createElement('section'); section.className = 'rec-group';
        const title = document.createElement('h3'); title.className = 'rec-group-title';
        title.textContent = heading;
        const count = document.createElement('span'); count.textContent = String(entries.length);
        title.append(count); section.append(title);
        section.append(makeGrid(entries.slice(0, flatLimit)));
        if (entries.length > flatLimit) {
          const more = document.createElement('button');
          more.type = 'button'; more.className = 'rec-show-more';
          more.textContent = `Show ${Math.min(PAGE_SIZE, entries.length - flatLimit)} more`;
          more.onclick = () => { flatLimit += PAGE_SIZE; render(); };
          section.append(more);
        }
        body.append(section);
      }
    };

    // ---- one render for all three ----------------------------------------

    function render() {
      const query = search.value.trim().toLowerCase();
      const terms = query.split(/\s+/).filter(Boolean);
      body.replaceChildren();
      crumbs.replaceChildren();

      const filters = activeFilters();
      filterBadge.hidden = !filters;
      filterBadge.textContent = String(filters);
      clear.hidden = !query && !filters && !refine;

      const entry = activeCategory ? byCategory.get(activeCategory) : undefined;
      crumbs.hidden = !entry;
      if (entry) {
        const root = document.createElement('button');
        root.type = 'button'; root.className = 'rec-crumb';
        root.textContent = 'All recordings';
        root.onclick = () => {
          activeCategory = null; refine = null;
          sectionLimits.clear(); openSections.clear(); flatLimit = PAGE_SIZE;
          body.scrollTop = 0; render();
        };
        const here = document.createElement('span'); here.className = 'rec-crumb-current';
        here.textContent = entry.category;
        crumbs.append(root, here);
      }

      if (terms.length) {
        renderResults(query, terms);
      } else if (entry) {
        renderCategory(entry);
      } else {
        renderLanding();
      }

      // The count line says what the reader is looking at, which differs per
      // view: a category browses within a total, a search reports a match count.
      if (terms.length) {
        const matched = recordings.filter(recording =>
          passesFilters(recording) &&
          terms.every(term => (searchText.get(recording) ?? '').includes(term))).length;
        resultCount.textContent =
          `${matched} matching · ${recordings.length} recordings`;
      } else if (entry) {
        const visible = entry.recordings.filter(recording => passesFilters(recording) &&
          (!refine || refine.facet.value(recording) === refine.value)).length;
        resultCount.textContent = visible === entry.recordings.length
          ? `${entry.recordings.length} in ${entry.category}`
          : `${visible} of ${entry.recordings.length} in ${entry.category}`;
      } else {
        resultCount.textContent =
          `${categories.length} categories · ${recordings.length} recordings`;
      }
    }

    const filterChanged = () => {
      flatLimit = PAGE_SIZE; sectionLimits.clear(); render();
    };
    search.oninput = filterChanged;
    search.onkeydown = event => {
      if (event.key === 'Escape' && search.value) {
        event.stopPropagation(); search.value = ''; filterChanged();
      }
    };
    for (const control of controls.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'))
      control.onchange = filterChanged;
    clear.onclick = () => {
      search.value = '';
      for (const control of [band, dataFormat]) selectOf(control).value = '';
      checkOf(annotated).checked = false;
      refine = null;
      openSections.clear();
      filterChanged();
    };
    render();
  }

  return { buildRecordings };
}
