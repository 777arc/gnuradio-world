export interface ExampleRecording {
  name: string;
  dataFile: string;
  metaFile: string;
  datatype: string | null;
  sampleRate: number | null;
  author: string | null;
  sampleCount: number | null;
  byteLength: number;
  downloadUrl: string;
  metadataUrl: string;
}

export interface R2RecordingIndexEntry {
  base_filename?: unknown;
  datatype?: unknown;
  sample_rate?: unknown;
  author?: unknown;
  byte_length?: unknown;
  number_of_samples?: unknown;
}

export interface RecordingDirectory {
  name: string;
  directories: Map<string, RecordingDirectory>;
  recordings: ExampleRecording[];
}

export interface FileSourceFormat {
  type: 'complex' | 'float' | 'int' | 'short' | 'byte';
  vlen: number;
}

// A recording key may contain collection prefixes (estevez/). Encode it one
// segment at a time: encodeURIComponent on the whole key would turn its path
// separators into %2F.
export const encodeRecordingPath = (path: string): string =>
  path.split('/').map(encodeURIComponent).join('/');

export const RECORDINGS_R2_BASE = String(
  import.meta.env.VITE_RECORDINGS_R2_BASE || 'https://recordings.gnuradioworld.com',
)
  .replace(/\/+$/, '');

export function recordingsBucketUrl(key: string): string {
  if (!RECORDINGS_R2_BASE)
    throw new Error('VITE_RECORDINGS_R2_BASE was not set when the editor was built');
  return RECORDINGS_R2_BASE + '/' + encodeRecordingPath(key);
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function indexBytesPerSample(datatype: string | null): number | null {
  const match = datatype?.match(/^([rc])[fiu](\d+)(?:_(?:le|be))?$/i);
  if (!match) return null;
  const bytes = (match[1].toLowerCase() === 'c' ? 2 : 1) * Number(match[2]) / 8;
  return Number.isInteger(bytes) && bytes > 0 ? bytes : null;
}

export function recordingFromR2Index(raw: R2RecordingIndexEntry): ExampleRecording | null {
  if (typeof raw?.base_filename !== 'string') return null;
  const name = raw.base_filename;
  const segments = name.split('/');
  if (!name || segments.some(segment => !segment || segment === '.' || segment === '..')) return null;

  const datatype = typeof raw.datatype === 'string' ? raw.datatype : null;
  const sampleCount = finiteNumber(raw.number_of_samples);
  const indexedBytes = finiteNumber(raw.byte_length);
  const bytesPerSample = indexBytesPerSample(datatype);
  const byteLength = indexedBytes ??
    (sampleCount !== null && bytesPerSample !== null ? sampleCount * bytesPerSample : null);
  if (byteLength === null || !Number.isSafeInteger(byteLength) || byteLength < 0) return null;

  const dataFile = name + '.sigmf-data';
  const metaFile = name + '.sigmf-meta';
  return {
    name,
    dataFile,
    metaFile,
    datatype,
    sampleRate: finiteNumber(raw.sample_rate),
    author: typeof raw.author === 'string' ? raw.author : null,
    sampleCount,
    byteLength,
    downloadUrl: recordingsBucketUrl(dataFile),
    metadataUrl: recordingsBucketUrl(metaFile),
  };
}

// A recording is linkable by its base key — the index's own `base_filename`,
// without either SigMF suffix — so #recording=estevez/ao73 stays readable. The
// separators are left literal for the same reason: they are legal in a fragment
// and URLSearchParams splits only on '&' and '='.
export function normalizeRecordingKey(name: string): string {
  const key = String(name).replace(/\\/g, '/').replace(/\.sigmf-(?:data|meta)$/, '');
  const segments = key.split('/');
  if (!key || segments.some(segment => !segment || segment === '.' || segment === '..'))
    throw new Error('invalid recording key');
  return segments.join('/');
}

export function recordingUrl(name: string, href = location.href): string {
  const base = href.split('#')[0].split('?')[0];
  return `${base}#recording=${encodeRecordingPath(normalizeRecordingKey(name))}`;
}

export const RECORDING_VIEW_BASE = '/recording/#';

export const base64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Used by the recording tabs, which embed this route in an iframe and pass
// blob: URLs for a locally picked file.
export function recordingViewUrl(metaUrl: string, dataUrl: string, name: string): string {
  return `${RECORDING_VIEW_BASE}/view/url/${base64Url(metaUrl)}/${base64Url(dataUrl)}/` +
    encodeURIComponent(name);
}

export const displayRecordingValue = (value: string | number | null): string => {
  if (value === null || value === '') return '—';
  return typeof value === 'number' ? value.toLocaleString() : value;
};

// Scale to a k/M/G prefix so recording counts and rates stay readable. Keeps up
// to three significant digits and drops trailing zeros (1500000 -> "1.5 M").
export const displaySi = (value: number | null, unit: string): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  let scaled = Math.abs(value), prefix = '';
  for (const next of ['k', 'M', 'G']) {
    if (scaled < 1000) break;
    scaled /= 1000; prefix = next;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const text = Number(scaled.toFixed(digits)).toString();
  return `${sign}${text} ${prefix}${unit}`.trimEnd();
};

export const displayBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

// File Source exposes integer recordings as scalar component streams, matching
// GNU Radio's normal interleaved-I/Q convention. For example, ci16_le becomes
// short with vlen=1 and can feed IShort To Complex with Vector Input disabled.
// Floating-point complex samples have a native GNU Radio complex item type.
export function sigmfFileSourceFormat(datatype: string | null): FileSourceFormat | null {
  const match = datatype?.toLowerCase().match(/^([rc])([fiu])(\d+)(?:_(le|be))?$/);
  if (!match) return null;
  const [, shape, kind, width, endian] = match;
  if (endian === 'be') return null; // WASM and the native File Source are little-endian.
  const complex = shape === 'c';
  if (kind === 'f' && width === '32')
    return complex ? { type: 'complex', vlen: 1 } : { type: 'float', vlen: 1 };
  if ((kind === 'i' || kind === 'u') && width === '8')
    return { type: 'byte', vlen: 1 };
  if (kind === 'i' && width === '16')
    return { type: 'short', vlen: 1 };
  if (kind === 'i' && width === '32')
    return { type: 'int', vlen: 1 };
  return null;
}

export function isCi16Datatype(datatype: string | null): boolean {
  return /^ci16(?:_le)?$/i.test(datatype?.trim() || '');
}

export function buildRecordingTree(recordings: ExampleRecording[]): RecordingDirectory {
  const root: RecordingDirectory = { name: '', directories: new Map(), recordings: [] };
  for (const recording of recordings) {
    const parts = recording.name.split('/').filter(Boolean);
    parts.pop(); // the recording basename is rendered as the card
    let directory = root;
    for (const name of parts) {
      let child = directory.directories.get(name);
      if (!child) {
        child = { name, directories: new Map(), recordings: [] };
        directory.directories.set(name, child);
      }
      directory = child;
    }
    directory.recordings.push(recording);
  }
  return root;
}

export function recordingTreeCount(directory: RecordingDirectory): number {
  let count = directory.recordings.length;
  for (const child of directory.directories.values()) count += recordingTreeCount(child);
  return count;
}
