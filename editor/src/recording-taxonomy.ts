// How the recordings catalog is organized: one root category per recording, a
// named collection, and the facet that splits a category into sections.
//
// Two consumers share this file, which is why it is pure and DOM-free:
//
//  - the Recordings palette, which browses categories and drills into them, and
//  - scripts/backfill-recording-metadata.mjs, which proposes the `grworld:`
//    fields to write into each recording's own `.sigmf-meta`.
//
// That sharing is the point. Every derivation here is a *fallback* for metadata
// a recording does not yet declare, and the backfill writes exactly what the
// fallback already inferred -- so applying it changes no grouping, it only moves
// the answer from a guess in the browser to a fact in the bucket. A recording
// that declares `grworld:category`, `grworld:collection` or `grworld:tags`
// always wins over anything guessed here.

import type { ExampleRecording } from './recording-catalog';

// One primary browse group per recording. Deliberately small: each value has to
// be worth a tile on the landing view, and a reader has to be able to guess
// which one holds the thing they want without reading all of them.
export const RECORDING_CATEGORIES = [
  'Satellite',
  'Aviation',
  'Maritime',
  'Navigation',
  'Cellular',
  'Broadcast',
  'ISM / IoT',
  'Amateur',
  'Radar',
  'Telemetry',
  'Time Signal',
  'Digital Voice',
  'HF Utility',
  'CTF / Puzzle',
  'Synthetic / Test',
] as const;

export type RecordingCategory = (typeof RECORDING_CATEGORIES)[number] | typeof UNSORTED_CATEGORY;

// Anything the rules below cannot place. Always ordered last, and never hidden:
// a recording nobody has classified still has to be reachable by browsing.
export const UNSORTED_CATEGORY = 'Other / Unsorted';

export const CATEGORY_BLURBS: Record<string, string> = {
  Satellite: 'Downlinks from spacecraft — telemetry, beacons and image transmissions.',
  Aviation: 'Aircraft transponders, air-band voice and unmanned aircraft.',
  Maritime: 'Ship transponders, navigational warnings and marine radiotelephony.',
  Navigation: 'Positioning and bearing services: GNSS constellations and NAVAIDs.',
  Cellular: 'Mobile network air interfaces.',
  Broadcast: 'One-to-many services: radio, television and their data subcarriers.',
  'ISM / IoT': 'Licence-free bands — sensors, remotes and short-range links.',
  Amateur: 'Amateur-radio modes, from packet and paging to slow-scan television.',
  Radar: 'Pulsed and continuous-wave ranging signals.',
  Telemetry: 'Instrumentation and measurement links that are not spacecraft.',
  'Time Signal': 'Standard-frequency and time stations.',
  'Digital Voice': 'Digitally coded speech modes.',
  'HF Utility': 'Point-to-point services on the shortwave bands.',
  'CTF / Puzzle': 'Challenge signals from capture-the-flag competitions.',
  'Synthetic / Test': 'Generated and simulated signals with known ground truth.',
  [UNSORTED_CATEGORY]: 'Recordings that carry no category yet.',
};

export function compareCategories(a: string, b: string): number {
  const order = RECORDING_CATEGORIES as readonly string[];
  const ai = order.indexOf(a), bi = order.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  if (a === UNSORTED_CATEGORY) return 1;
  if (b === UNSORTED_CATEGORY) return -1;
  return a.localeCompare(b);
}

// ---- derivation from a recording that declares nothing --------------------

// Word-boundary matched against the recording key and its description together.
// Order is significant: the first rule that matches wins, so a satellite
// telemetry downlink is Satellite rather than Telemetry, and a CTF challenge
// stays a CTF challenge whatever signal it happens to contain.
const CATEGORY_RULES: Array<[string, RegExp]> = [
  ['CTF / Puzzle', /\bctf\b|capture[- ]the[- ]flag/],
  // A `synthetic/` key is the publisher saying so outright, and it outranks
  // whatever the signal is a synthesis *of*: a generated GPS Gold code belongs
  // with the other test vectors, not among real navigation captures.
  ['Synthetic / Test', /^synthetic\//],
  ['Satellite', /\b(satellite|sat|norad|cubesat|noaa|meteor|iss|apt|lrpt|beacon|downlink|estevez)\b/],
  ['Aviation', /\b(ads-?b|adsb|air ?band|acars|aircraft|drone|dji|uav|mode-?s)\b/],
  ['Maritime', /\b(ais|navtex|sitor|marine|maritime|vessel)\b/],
  ['Navigation', /\b(gps|gnss|galileo|glonass|beidou|vor|dme|ils|navaid)\b/],
  ['Cellular', /\b(lte|gsm|umts|cdma|cellular|5g ?nr)\b/],
  ['Broadcast', /\b(broadcast|rds|dab\+?|dvb-?[stc]?2?|atsc|wbfm|nbfm|fm radio)\b/],
  ['ISM / IoT', /\b(lora|ism|zigbee|z-wave|ble|bluetooth|wi-?fi|802\.11|433 ?mhz|868 ?mhz|915 ?mhz|microwave|remote|doorbell)\b/],
  ['Amateur', /\b(amateur|ham|aprs|pocsag|dmr|p25|rtty|sstv|dsd|lmr|packet radio|2 ?m band)\b/],
  ['Radar', /\bradar\b/],
  ['Telemetry', /\b(telemetry|radiosonde)\b/],
  ['Time Signal', /\b(time signal|msf|dcf77|wwv|hbg)\b/],
  ['Digital Voice', /\b(digital voice|dstar|d-star|c4fm|codec2)\b/],
  ['HF Utility', /\b(hf utility|teleprinter|numbers station)\b/],
  ['Synthetic / Test', /\b(synthetic|simulated|generated|test signal|tone)\b/],
];

const haystack = (recording: ExampleRecording): string =>
  `${recording.name} ${recording.description ?? ''} ${recording.tags.join(' ')}`
    .toLowerCase().replace(/_/g, ' ');

/** The recording's declared category, or the best guess the rules can make. */
export function recordingCategory(recording: ExampleRecording): string {
  if (recording.category) return recording.category;
  const text = haystack(recording);
  for (const [category, pattern] of CATEGORY_RULES)
    if (pattern.test(text)) return category;
  return UNSORTED_CATEGORY;
}

/** True when the category was guessed rather than read out of the metadata. */
export const categoryIsDerived = (recording: ExampleRecording): boolean => !recording.category;

// Display names for the collection prefixes already in the bucket. A prefix not
// listed here is title-cased from its own text, so a new upload is never
// nameless -- this map exists to give the established ones a name a reader
// recognizes, not to gate anything.
const COLLECTION_NAMES: Record<string, string> = {
  estevez: 'Daniel Estévez satellite recordings',
  sdrangel: 'SDRangel sample set',
  GRCon23_CTF: 'GRCon 2023 CTF',
  GRCon24_CTF: 'GRCon 2024 CTF',
  GRCon25_CTF: 'GRCon 2025 CTF',
  synthetic: 'Synthetic test vectors',
  drone: 'Drone downlink captures',
};

export const STANDALONE_COLLECTION = 'Standalone uploads';

/**
 * The recording's declared collection, or a display name for the object-key
 * prefix it lives under.
 *
 * The prefix is the fallback rather than the definition: grouping off the
 * storage layout re-couples browsing to where bytes happen to sit, so once
 * `grworld:collection` is backfilled an object can move without being re-filed.
 */
export function recordingCollectionName(recording: ExampleRecording): string {
  if (recording.collection) return recording.collection;
  const parts = recording.name.split('/');
  if (parts.length < 2) return STANDALONE_COLLECTION;
  const prefix = parts[0];
  return COLLECTION_NAMES[prefix] ??
    prefix.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// "ADS-B", "adsb" and "ads_b" are one tag with three spellings. Compare the
// letters and digits alone so a catalog that already says one is not given
// another beside it, and so the facet groups them together.
export const normalizeTag = (tag: string): string =>
  tag.replace(/[^a-z0-9]/gi, '').toLowerCase();

const MODULATIONS = ['BPSK', 'QPSK', '8PSK', 'AFSK', 'GFSK', 'GMSK', 'FSK', 'MSK',
  'OFDM', 'QAM', 'OOK', 'ASK', 'PSK', 'CW', 'AM', 'FM', 'SSB'];

/**
 * Modulation from a declared tag, else from the key or the description.
 *
 * The key counts, and has to: a `synthetic/BPSK_2SPS` says what it is in its own
 * name and carries no description at all, so reading only the description filed
 * the entire synthetic collection under "no modulation". Underscores are spaced
 * out first so the word boundaries see BPSK rather than BPSK_2SPS.
 */
export function recordingModulation(recording: ExampleRecording): string | null {
  const tagged = recording.tags.find(tag =>
    MODULATIONS.some(modulation => normalizeTag(modulation) === normalizeTag(tag)));
  if (tagged) return MODULATIONS.find(
    modulation => normalizeTag(modulation) === normalizeTag(tagged))!;
  const text = ` ${recording.name} ${recording.description ?? ''} `.replace(/_/g, ' ');
  for (const modulation of MODULATIONS)
    if (new RegExp(`\\b${modulation}\\b`, 'i').test(text)) return modulation;
  return null;
}

const PROTOCOLS = ['ADS-B', 'AIS', 'RDS', 'LoRa', 'APRS', 'POCSAG', 'DMR', 'P25',
  'DVB-S2', 'DVB-T', 'ATSC', 'DAB', 'APT', 'LRPT', 'SSTV', 'RTTY', 'NAVTEX',
  'ACARS', 'GPS', 'VOR', 'LTE', 'GSM'];

/** Protocol from a declared tag, else from the key or description. */
export function recordingProtocol(recording: ExampleRecording): string | null {
  const tagged = recording.tags.find(tag =>
    PROTOCOLS.some(protocol => normalizeTag(protocol) === normalizeTag(tag)));
  if (tagged) return PROTOCOLS.find(
    protocol => normalizeTag(protocol) === normalizeTag(tagged))!;
  const text = ` ${recording.name} ${recording.description ?? ''} `.replace(/_/g, ' ');
  for (const protocol of PROTOCOLS) {
    const escaped = protocol.replace(/[-]/g, '-?');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return protocol;
  }
  return null;
}

export const BASEBAND_AUDIO_BAND = 'Baseband / audio';

/**
 * The band a recording sits in, or null when nothing here knows.
 *
 * Three populations hide in what a frequency alone would call "unknown", and
 * they are not the same thing. A real-valued recording is a receiver's audio
 * output, so it has no RF centre to report and never will -- that is an answer.
 * A complex recording with no `core:frequency` is an RF capture whose metadata
 * is simply incomplete, which is a gap to fill rather than a bucket to browse,
 * so it returns null and is left out of the facet instead of being filed beside
 * genuine audio.
 */
export function recordingBandOf(recording: ExampleRecording): string | null {
  if (recording.datatype?.toLowerCase().startsWith('r')) return BASEBAND_AUDIO_BAND;
  const frequency = recording.frequency;
  if (frequency === null || !Number.isFinite(frequency) || frequency <= 0) return null;
  if (frequency < 300e3) return 'LF and below';
  if (frequency < 3e6) return 'MF';
  if (frequency < 30e6) return 'HF';
  if (frequency < 300e6) return 'VHF';
  if (frequency < 3e9) return 'UHF';
  if (frequency < 30e9) return 'SHF';
  return 'EHF and above';
}

// ---- choosing the facet that splits a category ----------------------------

export interface RecordingFacet {
  id: string;
  label: string;
  value(recording: ExampleRecording): string | null;
  /**
   * Section order. Takes whole groups rather than their names because the right
   * order is not always a property of the name: collections order by *when*,
   * which only the recordings inside them know.
   */
  compare?(a: FacetGroup, b: FacetGroup): number;
}

const newestIn = (group: FacetGroup): number => group.recordings.reduce(
  (newest, recording) => Math.max(newest, Date.parse(recording.captureDatetime ?? '') || 0), 0);

const yearIn = (value: string): number => {
  const match = /\b(19|20)\d{2}\b/.exec(value);
  return match ? Number(match[0]) : 0;
};

/**
 * Collections are events as often as they are people, and an event list reads
 * newest first -- nobody opens CTF / Puzzle wanting 2023.
 *
 * Capture time is the real answer and is used wherever it exists. Until
 * `core:datetime` is backfilled almost nothing here has one, so a four-digit
 * year in the collection's own name is the stand-in; it is deliberately not a
 * plain reverse alphabetical sort, which would put "Zulu set" before "Alpha
 * set" for no reason. Everything else falls back to size, then name.
 */
function compareCollections(a: FacetGroup, b: FacetGroup): number {
  const newest = newestIn(b) - newestIn(a);
  if (newest) return newest;
  const years = yearIn(b.value) - yearIn(a.value);
  if (years) return years;
  return b.recordings.length - a.recordings.length || a.value.localeCompare(b.value);
}

export const BAND_ORDER = [BASEBAND_AUDIO_BAND, 'LF and below', 'MF', 'HF', 'VHF',
  'UHF', 'SHF', 'EHF and above'];

// What the band means in numbers, because "SHF" alone is not a frequency anyone
// holds in their head.
const BAND_RANGES: Record<string, string> = {
  [BASEBAND_AUDIO_BAND]: 'no RF centre frequency',
  'LF and below': '< 300 kHz',
  MF: '300 kHz–3 MHz',
  HF: '3–30 MHz',
  VHF: '30–300 MHz',
  UHF: '300 MHz–3 GHz',
  SHF: '3–30 GHz',
  'EHF and above': '≥ 30 GHz',
};

export function recordingBandLabel(band: string): string {
  return BAND_RANGES[band] ? `${BAND_RANGES[band]} (${band})` : band;
}

/** Band order by frequency, with anything unrecognized left at the end. */
export function compareBands(a: string, b: string): number {
  const ai = BAND_ORDER.indexOf(a), bi = BAND_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  return (ai === -1 ? BAND_ORDER.length : ai) - (bi === -1 ? BAND_ORDER.length : bi);
}

// Tried in this order, and ties are broken by it: an explicit collection is a
// better answer than an inferred modulation, which is a better answer than a
// datatype, which is a storage detail rather than anything about the signal.
export const SECTION_FACETS: RecordingFacet[] = [
  { id: 'collection', label: 'Collection', value: recordingCollectionName,
    compare: compareCollections },
  { id: 'protocol', label: 'Protocol', value: recordingProtocol },
  { id: 'modulation', label: 'Modulation', value: recordingModulation },
  {
    id: 'band', label: 'Band', value: recordingBandOf,
    compare: (a, b) => compareBands(a.value, b.value),
  },
  { id: 'datatype', label: 'Format', value: recording => recording.datatype },
];

// Below this a category is a single screen already, and headings cost more
// attention than the structure buys.
export const MIN_TO_SPLIT = 8;
// A heading standing over one card is noise, not organization.
export const MIN_PER_GROUP = 3;
// One group holding nearly everything has not split anything.
const MAX_GROUP_SHARE = 0.75;
// A facet most of the category cannot answer should not be the thing it is
// filed under, however cleanly it divides the minority that can.
const MIN_COVERAGE = 0.6;
const IDEAL_GROUP_RANGE: [number, number] = [2, 8];

export interface FacetGroup {
  value: string;
  recordings: ExampleRecording[];
}

export interface FacetSplit {
  /** null when nothing splits the category well -- render it flat. */
  facet: RecordingFacet | null;
  groups: FacetGroup[];
  /** Recordings the winning facet has no value for; shown under their own heading. */
  unlabelled: ExampleRecording[];
  /** Facets that scored but did not win, offered as refine chips. */
  runnersUp: RecordingFacet[];
}

function groupBy(recordings: ExampleRecording[], facet: RecordingFacet):
    { groups: FacetGroup[]; unlabelled: ExampleRecording[] } {
  const byValue = new Map<string, ExampleRecording[]>();
  const unlabelled: ExampleRecording[] = [];
  for (const recording of recordings) {
    const value = facet.value(recording);
    if (!value) { unlabelled.push(recording); continue; }
    const entries = byValue.get(value) ?? [];
    entries.push(recording);
    byValue.set(value, entries);
  }
  const groups = [...byValue].map(([value, entries]) => ({ value, recordings: entries }));
  groups.sort((a, b) => facet.compare
    ? facet.compare(a, b)
    : b.recordings.length - a.recordings.length || a.value.localeCompare(b.value));
  return { groups, unlabelled };
}

/**
 * How well this facet organizes this set. Negative means "do not use it".
 *
 * Every guard below was earned from the live catalog: without the size ones,
 * four Maritime recordings split into three headings of one card each, which
 * reads as structure while carrying none.
 */
export function facetScore(groups: FacetGroup[], total: number): number {
  if (total < MIN_TO_SPLIT) return -1;
  if (groups.length < 2) return -1;
  const covered = groups.reduce((sum, group) => sum + group.recordings.length, 0);
  if (covered / groups.length < MIN_PER_GROUP) return -1;
  if (covered < MIN_COVERAGE * total) return -1;
  const largest = Math.max(...groups.map(group => group.recordings.length)) / covered;
  if (largest > MAX_GROUP_SHARE) return -1;
  const [low, high] = IDEAL_GROUP_RANGE;
  const sizeFit = groups.length >= low && groups.length <= high ? 1 : 0.4;
  return (1 - largest) * sizeFit * (covered / total);
}

/** Pick the facet that best splits these recordings, or none. */
export function splitRecordings(recordings: ExampleRecording[],
                                facets: RecordingFacet[] = SECTION_FACETS): FacetSplit {
  const scored = facets.map(facet => {
    const { groups, unlabelled } = groupBy(recordings, facet);
    return { facet, groups, unlabelled, score: facetScore(groups, recordings.length) };
  }).filter(entry => entry.score > 0);
  // Stable sort keeps the declared facet order as the tie-break.
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { facet: null, groups: [], unlabelled: recordings, runnersUp: [] };
  return {
    facet: best.facet,
    groups: best.groups,
    unlabelled: best.unlabelled,
    runnersUp: scored.slice(1).map(entry => entry.facet),
  };
}

export interface CategorySummary {
  category: string;
  recordings: ExampleRecording[];
}

/** Every category present in the catalog, in vocabulary order. */
export function categorize(recordings: ExampleRecording[]): CategorySummary[] {
  const byCategory = new Map<string, ExampleRecording[]>();
  for (const recording of recordings) {
    const category = recordingCategory(recording);
    const entries = byCategory.get(category) ?? [];
    entries.push(recording);
    byCategory.set(category, entries);
  }
  return [...byCategory]
    .map(([category, entries]) => ({ category, recordings: entries }))
    .sort((a, b) => compareCategories(a.category, b.category));
}
