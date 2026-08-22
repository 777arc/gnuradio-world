// SigMF Source and SigMF Sink: the editor-side half.
//
// Both blocks read or write a *local* SigMF recording -- a pair of files sharing
// a base name, `<base>.sigmf-data` holding the samples and `<base>.sigmf-meta`
// holding a JSON description of them. They are deliberately separate blocks from
// GR World Recording, which streams a recording this project hosts: the title on
// the canvas is what tells a reader where a flowgraph's samples come from, and
// merging the two would take that away.
//
// What lives here is everything about those two blocks that is not DOM wiring:
// pairing the files a picker returns, reading the metadata, and deciding what
// follows from it. main.ts keeps the dialog and the run path, the way
// recording-catalog.ts and main.ts already split GR World Recording.

import { sigmfFileSourceFormat, type FileSourceFormat } from './recording-catalog';

export const SIGMF_SOURCE_ID = 'wasm_sigmf_source';
export const SIGMF_SINK_ID = 'wasm_sigmf_sink';

// Both blocks name their recording in the same parameter, and it is a base name
// in both -- no directory, no suffix.
export const SIGMF_FILE_PARAM = 'file';

// Browser-only dtypes. The Properties dialog renders these itself: a multi-file
// picker for the source, a name plus a folder picker for the sink. Neither is a
// GRC dtype, and neither ever reaches a .grc -- what reaches a .grc is the base
// name, exactly as File Source stores a file name and nothing more.
export const SIGMF_OPEN_DTYPE = 'sigmf_file_open';
export const SIGMF_SAVE_DTYPE = 'sigmf_file_save';

// Where a sink's destination is bound for the run, mirroring the
// /local-files/... prefix an input binding uses. Distinct so the runner's two
// maps can never be confused for one another.
export const SIGMF_OUTPUT_PREFIX = '/local-output/';

export const SIGMF_DATA_SUFFIX = '.sigmf-data';
export const SIGMF_META_SUFFIX = '.sigmf-meta';

// What the picker offers. A recording's two halves have no MIME type, so this is
// by extension; the browser still lets the reader override it.
export const SIGMF_ACCEPT = `${SIGMF_META_SUFFIX},${SIGMF_DATA_SUFFIX}`;

// One recording bound for this browser session. As with File Source, a .grc
// keeps only the base name: a File handle cannot be serialized, and a flowgraph
// that could silently reopen a file from a previous session would be worse if it
// could.
export interface SigmfBinding {
  base: string;
  data: File;
  meta: File;
  metaText: string;
  datatype: string;
  sampleRate: number | null;
  captures: number;
  annotations: number;
}

/** The base name of either half of a recording, or null for anything else. */
export function sigmfBaseName(name: string): string | null {
  if (name.endsWith(SIGMF_DATA_SUFFIX))
    return name.slice(0, -SIGMF_DATA_SUFFIX.length);
  if (name.endsWith(SIGMF_META_SUFFIX))
    return name.slice(0, -SIGMF_META_SUFFIX.length);
  return null;
}

export interface SigmfPair { base: string; data: File; meta: File }

/**
 * The one complete recording in a picker's selection.
 *
 * A browser cannot derive a sibling file from a picked File, so both halves have
 * to be selected together -- which is also why this reports what is missing
 * rather than just failing: "you picked one of the two files" is the mistake
 * everyone makes the first time.
 */
export function pairSigmfFiles(files: File[]): SigmfPair | { error: string } {
  if (!files.length) return { error: 'No files selected.' };

  const bases = new Map<string, { data?: File; meta?: File }>();
  const strays: string[] = [];
  for (const file of files) {
    const base = sigmfBaseName(file.name);
    if (base === null) { strays.push(file.name); continue; }
    const entry = bases.get(base) || {};
    if (file.name.endsWith(SIGMF_DATA_SUFFIX)) entry.data = file;
    else entry.meta = file;
    bases.set(base, entry);
  }

  const complete = [...bases.entries()].filter(([, e]) => e.data && e.meta);
  if (complete.length === 1) {
    const [base, entry] = complete[0];
    return { base, data: entry.data!, meta: entry.meta! };
  }
  if (complete.length > 1)
    return {
      error: `Selected ${complete.length} recordings ` +
        `(${complete.map(([base]) => base).join(', ')}). Choose one recording's two files.`,
    };

  const partial = [...bases.entries()][0];
  if (partial) {
    const [base, entry] = partial;
    const missing = entry.data ? SIGMF_META_SUFFIX : SIGMF_DATA_SUFFIX;
    return { error: `Also select ${base}${missing} — a SigMF recording is both files.` };
  }
  return {
    error: strays.length
      ? `${strays[0]} is not part of a SigMF recording. ` +
        `Select a ${SIGMF_DATA_SUFFIX} file and its ${SIGMF_META_SUFFIX}.`
      : 'Select a SigMF recording — both its .sigmf-data and its .sigmf-meta.',
  };
}

export interface SigmfMeta {
  datatype: string;
  sampleRate: number | null;
  captures: number;
  annotations: number;
}

/**
 * What the editor needs out of a .sigmf-meta: the datatype, which decides the
 * block's Output Type, and the sample rate, which the "Use as samp_rate" toggle
 * publishes. The captures and annotations are counted only so the dialog can say
 * what the recording carries -- turning them into tags is the runner's job, in
 * runner/src/sigmf_meta.hpp, and doing it in one place is what keeps the two
 * ends of a round trip agreeing.
 */
export function parseSigmfMeta(text: string): SigmfMeta | { error: string } {
  let document: any;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { error: `${SIGMF_META_SUFFIX} is not valid JSON: ${(error as Error).message}` };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    return { error: `${SIGMF_META_SUFFIX} is not a SigMF document.` };

  const global = document.global;
  if (!global || typeof global !== 'object')
    return { error: `${SIGMF_META_SUFFIX} has no "global" object.` };

  const datatype = String(global['core:datatype'] || '').trim();
  if (!datatype)
    return { error: `${SIGMF_META_SUFFIX} does not say its core:datatype.` };

  const rate = Number(global['core:sample_rate']);
  return {
    datatype,
    sampleRate: Number.isFinite(rate) && rate > 0 ? rate : null,
    captures: Array.isArray(document.captures) ? document.captures.length : 0,
    annotations: Array.isArray(document.annotations) ? document.annotations.length : 0,
  };
}

/**
 * The stream type a datatype has to be read as, or null when it has none here.
 *
 * Refused rather than approximated, exactly as GR World Recording's chooser
 * refuses one: a datatype with no stream type could not be corrected in the
 * dialog afterwards, since Output Type is derived and disabled.
 */
export function sigmfStreamFormat(datatype: string): FileSourceFormat | null {
  return sigmfFileSourceFormat(datatype);
}

/** Whether this browser can stream a recording to a folder rather than buffer it. */
export function canPickOutputDirectory(): boolean {
  return typeof (globalThis as any).showDirectoryPicker === 'function';
}

/**
 * Ask for the folder a SigMF Sink writes into.
 *
 * `startIn: 'downloads'` because that is where someone putting a new file
 * usually wants it — and because of the one restriction worth knowing about
 * here: Chrome's File System Access blocklist refuses the Downloads folder
 * *itself* as a directory handle, showing "can't open this folder because it
 * contains system files". Its entry is `kDontBlockChildren`, so anything
 * *inside* Downloads is fine — the picker's own "New folder" button is the whole
 * fix, and opening there is what makes that a click rather than a hunt.
 *
 * `id` makes Chrome reopen wherever this app was last pointed, so the choice is
 * made once per browser rather than once per run. A remembered directory takes
 * precedence over `startIn`.
 */
export const SIGMF_OUTPUT_PICKER_ID = 'gr-world-sigmf-sink';

export function pickOutputDirectory(): Promise<FileSystemDirectoryHandle> {
  return (globalThis as any).showDirectoryPicker({
    mode: 'readwrite',
    id: SIGMF_OUTPUT_PICKER_ID,
    startIn: 'downloads',
  });
}

/**
 * What to say when no folder came back. The picker throws the same AbortError
 * whether it was dismissed or a blocked folder was chosen and then dismissed, so
 * this covers both rather than guessing which happened.
 */
export const SIGMF_OUTPUT_PICKER_HELP =
  'Chrome does not allow the Downloads folder itself — a folder inside it is ' +
  'fine, and the picker’s "New folder" button makes one.';

/**
 * A name that is safe as the stem of two files, and non-empty.
 *
 * The reader types this, and it becomes a filename in a folder they chose, so a
 * path separator in it has to go rather than be passed to getFileHandle() --
 * which rejects it, but only once the flowgraph is already running.
 */
export function sanitizeSigmfBase(name: string): string {
  const base = sigmfBaseName(name.trim()) ?? name.trim();
  return base.replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').trim();
}

/** What a sink writes, for the dialog and the console note. */
export function sigmfSinkFileNames(base: string): string[] {
  return [`${base}${SIGMF_DATA_SUFFIX}`, `${base}${SIGMF_META_SUFFIX}`];
}
