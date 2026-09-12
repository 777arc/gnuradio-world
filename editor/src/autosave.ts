// The canvas, kept between visits.
//
// A reload used to open the welcome example no matter what was on the canvas,
// so an accidental refresh cost every unsaved edit. Now the canvas is written
// here on every recorded edit -- as the same .grc text Save would download, so
// it goes back through the ordinary importer and its schema reconciliation on
// the way in -- and the startup path restores it when no link claimed the
// canvas. main.ts owns *when*: this module is the store, the debounce, and the
// one rule that decides what a fresh page opens on.
//
// The store is localStorage rather than the editor's IndexedDB, and the reason
// is the reload itself: the edit most worth keeping is the one made a moment
// before the refresh, still inside the debounce, and the `pagehide` flush that
// catches it has to finish synchronously -- an IndexedDB write cannot even open
// its connection before the page is gone. A .grc is a few kilobytes, which is
// what localStorage is for; the `#duplicate=` hand-off already keeps one there.
//
// Everything here degrades to "nothing is persisted": private mode, a disabled
// storage, or a full one all leave the editor exactly as it was before this
// file existed.

export interface SavedWorkspace {
  /** The flowgraph as Save would write it. */
  grc: string;
  /** What Save would name it, so the name survives too. */
  file: string | null;
  /** Epoch ms of the edit that wrote it. */
  updated: number;
}

export interface WorkspaceStore {
  load(): SavedWorkspace | null;
  save(saved: SavedWorkspace): void;
  clear(): void;
}

/**
 * Edits arrive in bursts -- a drag records once per drop, but Properties
 * changes, auto-arrange and a Graham batch land several in a row -- and
 * serializing the canvas per edit would be wasted work. Short, because a
 * pending write is what an immediate reload loses; `flush()` covers `pagehide`.
 */
export const AUTOSAVE_DELAY_MS = 300;

export const WORKSPACE_STORAGE = 'gnuradio-world.workspace';

/** The localStorage-backed store; one key, the same shape in and out. */
export const workspaceStore: WorkspaceStore = {
  load() {
    const raw = localStorage.getItem(WORKSPACE_STORAGE);
    if (!raw) return null;
    const row = JSON.parse(raw);
    if (!row || typeof row.grc !== 'string' || !row.grc) return null;
    return { grc: row.grc, file: row.file ?? null, updated: Number(row.updated) || 0 };
  },
  save(saved) {
    localStorage.setItem(WORKSPACE_STORAGE, JSON.stringify(saved));
  },
  clear() {
    localStorage.removeItem(WORKSPACE_STORAGE);
  },
};

export interface WorkspaceAutosave {
  /** Write the canvas after the debounce; `read` runs then, not now. */
  schedule(read: () => SavedWorkspace): void;
  /** Write a pending save now -- for `pagehide`, where the debounce would lose it. */
  flush(): void;
  /** Drop the row and any pending write: the canvas is deliberately empty. */
  clear(): void;
}

export function createWorkspaceAutosave(
  store: WorkspaceStore,
  onError: (error: unknown) => void = () => {},
  delayMs = AUTOSAVE_DELAY_MS,
): WorkspaceAutosave {
  let timer = 0;
  let pending: (() => SavedWorkspace) | null = null;
  const write = () => {
    if (!pending) return;
    const read = pending;
    pending = null;
    globalThis.clearTimeout(timer);
    try { store.save(read()); } catch (error) { onError(error); }
  };
  return {
    schedule(read) {
      pending = read;
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(write, delayMs);
    },
    flush: write,
    clear() {
      pending = null;
      globalThis.clearTimeout(timer);
      try { store.clear(); } catch (error) { onError(error); }
    },
  };
}

/**
 * What a fresh page opens on, in order: whatever the URL named, then the saved
 * canvas, then the welcome example. A link always wins, because a link is
 * shared and has to show the same thing to everyone who follows it -- which is
 * also why an edit clears `#example=` from the address bar (see main.ts): an
 * edited example is no longer the example the link names, so a reload brings
 * the edit back rather than the pristine file. An embed opts out of the saved
 * canvas altogether: the framing site named a flowgraph and expects that one.
 */
export function startupSource(
  { linked, embedded, saved }: { linked: boolean; embedded: boolean; saved: boolean },
): 'link' | 'workspace' | 'default' {
  if (linked) return 'link';
  if (saved && !embedded) return 'workspace';
  return 'default';
}
