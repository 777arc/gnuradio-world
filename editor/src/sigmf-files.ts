export const SIGMF_DATA_SUFFIX = '.sigmf-data';
export const SIGMF_META_SUFFIX = '.sigmf-meta';
export const SIGMF_ACCEPT = `${SIGMF_META_SUFFIX},${SIGMF_DATA_SUFFIX}`;

export const SIGMF_DATA_LIMIT = 300_000_000;
export const SIGMF_META_LIMIT = 5_000_000;
export const SIGMF_SUBMISSION_LIMIT = 2_000_000_000;
export const SIGMF_RECORDING_LIMIT = 10;

export interface SigmfPair { base: string; data: File; meta: File }

export interface SigmfMeta {
  datatype: string;
  sampleRate: number | null;
  captures: number;
  annotations: number;
  document: Record<string, unknown>;
}

export interface ValidatedSigmfPair extends SigmfPair {
  metadata: SigmfMeta;
  metaText: string;
  totalSize: number;
  warning: string | null;
}

/** The base name of either half of a recording, or null for anything else. */
export function sigmfBaseName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(SIGMF_DATA_SUFFIX))
    return name.slice(0, -SIGMF_DATA_SUFFIX.length);
  if (lower.endsWith(SIGMF_META_SUFFIX))
    return name.slice(0, -SIGMF_META_SUFFIX.length);
  return null;
}

function halfOf(name: string): 'data' | 'meta' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(SIGMF_DATA_SUFFIX)) return 'data';
  if (lower.endsWith(SIGMF_META_SUFFIX)) return 'meta';
  return null;
}

/**
 * Group an arbitrary multi-file selection into complete SigMF pairs. All
 * problems are returned together so a ten-recording pick can be fixed in one
 * pass rather than failing one filename at a time.
 */
export function pairSigmfFileBatch(files: File[]): { pairs: SigmfPair[]; errors: string[] } {
  if (!files.length) return { pairs: [], errors: ['No files selected.'] };
  const entries = new Map<string, { base: string; data?: File; meta?: File }>();
  const errors: string[] = [];
  for (const file of files) {
    const base = sigmfBaseName(file.name);
    const half = halfOf(file.name);
    if (base === null || half === null) {
      errors.push(`${file.name} is not part of a SigMF recording; select only .sigmf-data and .sigmf-meta files.`);
      continue;
    }
    const folded = base.toLocaleLowerCase();
    const entry = entries.get(folded) ?? { base };
    if (entry[half]) errors.push(`Selected more than one ${base}.sigmf-${half} file.`);
    else entry[half] = file;
    entries.set(folded, entry);
  }
  const pairs: SigmfPair[] = [];
  for (const entry of entries.values()) {
    if (!entry.data) errors.push(`Also select ${entry.base}${SIGMF_DATA_SUFFIX}.`);
    if (!entry.meta) errors.push(`Also select ${entry.base}${SIGMF_META_SUFFIX}.`);
    if (entry.data && entry.meta) pairs.push({ base: entry.base, data: entry.data, meta: entry.meta });
  }
  if (pairs.length > SIGMF_RECORDING_LIMIT)
    errors.push(`A submission can contain at most ${SIGMF_RECORDING_LIMIT} recordings.`);
  return { pairs, errors };
}

/** Backwards-compatible single-pair picker used by SigMF Source. */
export function pairSigmfFiles(files: File[]): SigmfPair | { error: string } {
  const grouped = pairSigmfFileBatch(files);
  if (grouped.errors.length) return { error: grouped.errors[0] };
  if (grouped.pairs.length !== 1)
    return { error: `Selected ${grouped.pairs.length} recordings. Choose one recording's two files.` };
  return grouped.pairs[0];
}

export function sigmfBytesPerSample(datatype: string): number | null {
  const match = datatype.trim().match(/^([rc])[fiu](\d+)(?:_(?:le|be))?$/i);
  if (!match) return null;
  const bytes = (match[1].toLowerCase() === 'c' ? 2 : 1) * Number(match[2]) / 8;
  return Number.isInteger(bytes) && bytes > 0 ? bytes : null;
}

export function parseSigmfMeta(text: string): SigmfMeta | { error: string } {
  let document: any;
  try { document = JSON.parse(text); }
  catch (error) {
    return { error: `${SIGMF_META_SUFFIX} is not valid JSON: ${(error as Error).message}` };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    return { error: `${SIGMF_META_SUFFIX} is not a SigMF document.` };
  const global = document.global;
  if (!global || typeof global !== 'object' || Array.isArray(global))
    return { error: `${SIGMF_META_SUFFIX} has no "global" object.` };
  if (document.captures !== undefined && !Array.isArray(document.captures))
    return { error: `${SIGMF_META_SUFFIX} "captures" is not an array.` };
  if (document.annotations !== undefined && !Array.isArray(document.annotations))
    return { error: `${SIGMF_META_SUFFIX} "annotations" is not an array.` };
  const datatype = String(global['core:datatype'] || '').trim();
  if (!datatype) return { error: `${SIGMF_META_SUFFIX} does not say its core:datatype.` };
  if (sigmfBytesPerSample(datatype) === null)
    return { error: `${SIGMF_META_SUFFIX} has invalid core:datatype "${datatype}".` };
  const rate = Number(global['core:sample_rate']);
  return {
    datatype,
    sampleRate: Number.isFinite(rate) && rate > 0 ? rate : null,
    captures: Array.isArray(document.captures) ? document.captures.length : 0,
    annotations: Array.isArray(document.annotations) ? document.annotations.length : 0,
    document,
  };
}

export async function validateSigmfPair(pair: SigmfPair): Promise<ValidatedSigmfPair | { error: string }> {
  if (pair.data.size <= 0) return { error: `${pair.data.name} is empty.` };
  if (pair.data.size > SIGMF_DATA_LIMIT)
    return { error: `${pair.data.name} exceeds the 300 MB data-file limit.` };
  if (pair.meta.size <= 0) return { error: `${pair.meta.name} is empty.` };
  if (pair.meta.size > SIGMF_META_LIMIT)
    return { error: `${pair.meta.name} exceeds the 5 MB metadata-file limit.` };
  let text: string;
  try { text = await pair.meta.text(); }
  catch { return { error: `${pair.meta.name} could not be read.` }; }
  const metadata = parseSigmfMeta(text);
  if ('error' in metadata) return { error: `${pair.meta.name}: ${metadata.error}` };
  const bytes = sigmfBytesPerSample(metadata.datatype)!;
  if (pair.data.size % bytes !== 0)
    return { error: `${pair.data.name} is not aligned to ${metadata.datatype} samples (${bytes} bytes each).` };
  const warnings = [];
  if (metadata.sampleRate === null) warnings.push('no sample rate');
  if (!metadata.captures) warnings.push('no captures');
  return {
    ...pair, metadata, metaText: text, totalSize: pair.data.size + pair.meta.size,
    warning: warnings.length ? warnings.join(' · ') : null,
  };
}
