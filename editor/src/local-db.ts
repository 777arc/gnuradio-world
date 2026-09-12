// The one IndexedDB the editor keeps between visits, and the one place its
// version lives.
//
// Every store the editor persists is declared here, because IndexedDB versions
// the *database*, not its stores: two openers naming the same database at
// different versions do not merge, the lower one fails with VersionError. So a
// module that wants a store of its own adds it to STORES, bumps DB_VERSION, and
// lets the upgrade below create it -- rather than opening the database itself.
//
// Connections are short-lived on purpose. A version upgrade cannot proceed while
// any tab holds an older connection open, so each transaction opens, runs and
// closes, and a connection that is open when another tab upgrades closes itself
// on `versionchange` instead of blocking that tab for as long as this one lives.

export const DB_NAME = 'gnuradio-world';
export const DB_VERSION = 1;

export const STORES = {
  /** The browser-local library of saved JS blocks -- see js-block.ts. */
  jsBlocks: 'js-blocks',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

/**
 * How long to wait on a tab still holding an older version open before giving
 * up. The wait is finite so a stuck old tab degrades this one to "nothing is
 * persisted" with an error rather than a request that never settles.
 */
const BLOCKED_TIMEOUT_MS = 3000;

export function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of Object.values(STORES))
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
    };
    request.onblocked = () => {
      timer = globalThis.setTimeout(() => reject(new Error(
        'another tab of GNU Radio World is holding the local database open; close it and reload')),
        BLOCKED_TIMEOUT_MS);
    };
    request.onsuccess = () => {
      globalThis.clearTimeout(timer);
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      globalThis.clearTimeout(timer);
      reject(request.error || new Error('IndexedDB is unavailable'));
    };
  });
}

/** One request in one transaction against one store, on a connection closed after it. */
export function transact<T>(store: StoreName, mode: IDBTransactionMode,
                            run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openLocalDb().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = run(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`the local ${store} store failed`));
    tx.oncomplete = () => db.close();
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error || new Error(`the local ${store} store failed`));
    };
  }));
}
