import {
  compareRecordingBands,
  displayBytes,
  displayDuration,
  displayRecordingValue,
  displaySi,
  recordingBand,
  recordingBandLabel,
  recordingCollection,
  recordingDuration,
  recordingUrl,
  sigmfFileSourceFormat,
  type ExampleRecording,
  type FileSourceFormat,
} from './recording-catalog';
import { makePaletteSearch } from './palette-tree';

export interface RecordingPaletteDeps {
  loadExampleRecordings(): Promise<ExampleRecording[]>;
  openRecordingPreview(recording: ExampleRecording): void;
  copyRecordingUrl(name: string): Promise<void>;
  addRecordingBlock(recording: ExampleRecording, format: FileSourceFormat): Promise<void>;
  closePaletteDrawer(): void;
  log(message: string): void;
}

const PAGE_SIZE = 50;

type RecordingGroup = 'category' | 'collection' | 'none';
type RecordingSort = 'name' | 'frequency' | 'duration' | 'newest' | 'size';

const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const byCollection = (a: string, b: string): number => {
  if (a === 'Uncollected') return -1;
  if (b === 'Uncollected') return 1;
  return byName(a, b);
};

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
    recording.category,
    ...recording.tags,
    ...recording.annotationLabels,
    recordingBand(recording.frequency),
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

function groupName(recording: ExampleRecording, group: RecordingGroup): string {
  if (group === 'category') return recording.category ?? 'Uncategorized';
  if (group === 'collection') return recordingCollection(recording);
  return '';
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
    ].filter(value => value !== '—');
    const summary = document.createElement('div'); summary.className = 'rec-summary';
    summary.textContent = facts.length ? facts.join(' · ') : 'Metadata unavailable';

    const tags = document.createElement('div'); tags.className = 'rec-tags';
    const legacyCollection = recording.category ? null : recordingCollection(recording);
    const visibleTags = [recording.category, legacyCollection === 'Uncollected' ? null : legacyCollection,
      ...recording.tags]
      .filter((tag): tag is string => !!tag).slice(0, 4);
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
    more.type = 'button'; more.textContent = 'More'; more.setAttribute('aria-expanded', 'false');
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
      more.textContent = details.hidden ? 'More' : 'Less';
    };
    item.append(head, details);
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
    if (!recordings.length) { status.textContent = 'No SigMF recordings found.'; return; }

    const { bar: searchBar, input: search } =
      makePaletteSearch('Search recordings…', 'Search SigMF recordings');
    const controls = document.createElement('div'); controls.className = 'rec-controls';
    const category = selectControl('Category', facetOptions(
      recordings, recording => recording.category ?? 'Uncategorized', 'All categories'));
    const band = selectControl('Band', facetOptions(recordings,
      recording => recordingBand(recording.frequency), 'All bands',
      compareRecordingBands, recordingBandLabel));
    const collection = selectControl('Collection', facetOptions(
      recordings, recordingCollection, 'All collections', byCollection));
    const dataFormat = selectControl('Format', facetOptions(
      recordings, recording => recording.datatype ?? 'Unknown', 'All formats'));
    const group = selectControl('Group', [
      ['category', 'Category'], ['collection', 'Collection'], ['none', 'No grouping'],
    ]);
    // Existing indexes predate catalog categories. Keep those useful on first
    // open by grouping their stable key prefixes until curated metadata arrives.
    if (!recordings.some(recording => recording.category))
      group.querySelector('select')!.value = 'collection';
    const sort = selectControl('Sort', [
      ['name', 'Name'], ['frequency', 'Frequency'], ['duration', 'Duration'],
      ['newest', 'Newest'], ['size', 'Size'],
    ]);
    const annotated = checkControl('Annotated');
    controls.append(category, band, collection, dataFormat, annotated, group, sort);

    // The catalog's seven facets are taller than the list they filter, so the
    // sticky header opens with the search box alone and keeps the rest behind a
    // disclosure whose badge reports how many facets are narrowing the results.
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

    const catalogStatus = document.createElement('div'); catalogStatus.className = 'rec-catalog-status';
    const resultCount = document.createElement('span');
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'rec-clear';
    clear.textContent = 'Clear filters'; clear.hidden = true;
    catalogStatus.append(resultCount, clear);

    const list = document.createElement('div'); list.className = 'rec-list';
    const noMatch = document.createElement('div'); noMatch.className = 'ex-empty'; noMatch.hidden = true;
    const moreResults = document.createElement('button');
    moreResults.type = 'button'; moreResults.className = 'rec-show-more'; moreResults.hidden = true;
    status.remove(); searchBar.append(filterToggle, controls, catalogStatus);
    panel.append(searchBar, list, noMatch, moreResults);

    const selectOf = (label: HTMLLabelElement) => label.querySelector('select')!;
    const checkOf = (label: HTMLLabelElement) => label.querySelector('input')!;
    let visibleLimit = PAGE_SIZE;

    const refresh = () => {
      const query = search.value.trim().toLowerCase();
      const terms = query.split(/\s+/).filter(Boolean);
      const categoryValue = selectOf(category).value;
      const bandValue = selectOf(band).value;
      const collectionValue = selectOf(collection).value;
      const formatValue = selectOf(dataFormat).value;
      const filtered = recordings.filter(recording =>
        terms.every(term => recordingSearchText(recording).includes(term)) &&
        (!categoryValue || (recording.category ?? 'Uncategorized') === categoryValue) &&
        (!bandValue || recordingBand(recording.frequency) === bandValue) &&
        (!collectionValue || recordingCollection(recording) === collectionValue) &&
        (!formatValue || (recording.datatype ?? 'Unknown') === formatValue) &&
        (!checkOf(annotated).checked || recording.annotationCount > 0));

      const sortValue = selectOf(sort).value as RecordingSort;
      filtered.sort((a, b) => {
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

      const activeFilters = [categoryValue, bandValue, collectionValue, formatValue]
        .filter(Boolean).length + (checkOf(annotated).checked ? 1 : 0);
      filterBadge.hidden = !activeFilters;
      filterBadge.textContent = String(activeFilters);
      clear.hidden = !query && !activeFilters;
      resultCount.textContent = `Showing ${Math.min(visibleLimit, filtered.length)} of ` +
        `${filtered.length} matching · ${recordings.length} total`;
      noMatch.textContent = query
        ? `No SigMF recording matches “${query}” and the selected filters.`
        : 'No SigMF recording matches the selected filters.';
      noMatch.hidden = filtered.length > 0;
      moreResults.hidden = filtered.length <= visibleLimit;
      moreResults.textContent = `Show ${Math.min(PAGE_SIZE, filtered.length - visibleLimit)} more`;

      list.replaceChildren();
      const shown = filtered.slice(0, visibleLimit);
      const groupValue = selectOf(group).value as RecordingGroup;
      const totals = new Map<string, number>();
      for (const recording of filtered) {
        const name = groupName(recording, groupValue);
        totals.set(name, (totals.get(name) ?? 0) + 1);
      }
      const grouped = new Map<string, ExampleRecording[]>();
      for (const recording of shown) {
        const name = groupName(recording, groupValue);
        const entries = grouped.get(name) ?? [];
        entries.push(recording); grouped.set(name, entries);
      }
      const groupEntries = [...grouped];
      if (groupValue !== 'none') groupEntries.sort(([a], [b]) =>
        groupValue === 'collection' ? byCollection(a, b) : byName(a, b));
      for (const [name, entries] of groupEntries) {
        const section = document.createElement('section'); section.className = 'rec-group';
        if (groupValue !== 'none') {
          const heading = document.createElement('h3'); heading.className = 'rec-group-title';
          heading.textContent = name;
          const count = document.createElement('span'); count.textContent = String(totals.get(name) ?? 0);
          heading.append(count); section.append(heading);
        }
        for (const recording of entries) section.append(makeRecordingItem(recording));
        list.append(section);
      }
    };

    const filterChanged = () => { visibleLimit = PAGE_SIZE; refresh(); };
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
      for (const control of [category, band, collection, dataFormat]) selectOf(control).value = '';
      checkOf(annotated).checked = false;
      filterChanged();
    };
    moreResults.onclick = () => { visibleLimit += PAGE_SIZE; refresh(); };
    refresh();
  }

  return { buildRecordings };
}
