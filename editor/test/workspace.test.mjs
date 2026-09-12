// The canvas between visits: the autosave debounce and its store contract, the
// startup rule that decides what a fresh page opens on, and the main.ts wiring
// that keeps a first visit on the welcome example and an embed on the flowgraph
// it was framed with. The store is exercised against a fake localStorage.
import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';
import { mainSource as main } from './editor-contract-source.mjs';

const { AUTOSAVE_DELAY_MS, WORKSPACE_STORAGE, createWorkspaceAutosave, startupSource, workspaceStore } =
  await bundleModule('../src/autosave.ts');
const { DB_NAME, DB_VERSION, STORES } = await bundleModule('../src/local-db.ts');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- the stores -------------------------------------------------------------

// The JS block library's database, opened from one place so every store joins
// it by bumping the one version -- which Graham's sessions did.
assert.equal(DB_NAME, 'gnuradio-world');
assert.equal(DB_VERSION, 2);
assert.deepEqual(STORES, { jsBlocks: 'js-blocks', grahamSessions: 'graham-sessions' });

// The canvas is in localStorage, because the pagehide flush has to be
// synchronous to survive the reload it exists for.
{
  const backing = new Map();
  globalThis.localStorage = {
    getItem: key => backing.has(key) ? backing.get(key) : null,
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: key => backing.delete(key),
  };
  assert.equal(workspaceStore.load(), null);
  workspaceStore.save({ grc: 'options: {}\n', file: 'x.grc', updated: 42 });
  assert.equal(typeof backing.get(WORKSPACE_STORAGE), 'string');
  assert.deepEqual(workspaceStore.load(), { grc: 'options: {}\n', file: 'x.grc', updated: 42 });
  backing.set(WORKSPACE_STORAGE, JSON.stringify({ grc: '' }));
  assert.equal(workspaceStore.load(), null, 'an empty row is no row');
  workspaceStore.clear();
  assert.equal(workspaceStore.load(), null);
  delete globalThis.localStorage;
}

// ---- the debounce -----------------------------------------------------------

function fakeStore() {
  const writes = [];
  return {
    writes,
    row: null,
    load() { return this.row; },
    save(saved) { writes.push(['save', saved]); this.row = saved; },
    clear() { writes.push(['clear']); this.row = null; },
  };
}

{
  const store = fakeStore();
  const errors = [];
  const autosave = createWorkspaceAutosave(store, error => errors.push(error), 20);
  let reads = 0;
  const read = () => ({ grc: `grc ${++reads}`, file: 'a.grc', updated: reads });
  autosave.schedule(read);
  autosave.schedule(read);
  autosave.schedule(read);
  assert.equal(reads, 0, 'the canvas is serialized at flush time, not when the edit lands');
  await sleep(60);
  assert.equal(reads, 1, 'a burst of edits is one write');
  assert.deepEqual(store.writes, [['save', { grc: 'grc 1', file: 'a.grc', updated: 1 }]]);
  assert.deepEqual(errors, []);
}

{
  const store = fakeStore();
  const autosave = createWorkspaceAutosave(store, () => {}, 1000);
  autosave.schedule(() => ({ grc: 'pending', file: null, updated: 1 }));
  autosave.flush();
  assert.deepEqual(store.writes, [['save', { grc: 'pending', file: null, updated: 1 }]],
    'pagehide flushes a pending write synchronously instead of waiting out the debounce');
  autosave.flush();
  assert.equal(store.writes.length, 1, 'a flush with nothing pending writes nothing');
}

{
  const store = fakeStore();
  const autosave = createWorkspaceAutosave(store, () => {}, 20);
  autosave.schedule(() => ({ grc: 'blank canvas', file: null, updated: 1 }));
  autosave.clear();
  await sleep(60);
  assert.deepEqual(store.writes, [['clear']],
    'New drops the row and the save the record before it had scheduled');
}

{
  const store = fakeStore();
  const errors = [];
  const autosave = createWorkspaceAutosave(store, error => errors.push(error), 5);
  store.save = () => { throw new Error('quota'); };
  autosave.schedule(() => ({ grc: 'x', file: null, updated: 1 }));
  await sleep(30);
  assert.equal(errors.length, 1, 'a failed write is reported, never thrown into the edit');
  autosave.schedule(() => { throw new Error('serialize'); });
  await sleep(30);
  assert.equal(errors.length, 2, 'so is a canvas that will not serialize');
}

assert.ok(AUTOSAVE_DELAY_MS <= 500, 'a pending write is what an immediate reload loses');

// ---- what a fresh page opens on ----------------------------------------------

assert.equal(startupSource({ linked: true, embedded: false, saved: true }), 'link',
  'a link is shared: it shows the same thing to everyone who follows it');
assert.equal(startupSource({ linked: false, embedded: false, saved: true }), 'workspace');
assert.equal(startupSource({ linked: false, embedded: false, saved: false }), 'default',
  'a first visit still lands on the welcome example');
assert.equal(startupSource({ linked: false, embedded: true, saved: true }), 'default',
  'an embed shows what the framing site named, never a visitor\'s own canvas');

// ---- the main.ts wiring -----------------------------------------------------

assert.match(main, /function persistWorkspace\(\) \{\n  if \(!historyReady \|\| EMBEDDED \|\| trainingSession \|\| canvasIsDefaultExample\) return;/,
  'the untouched welcome example, an embed and a lesson are never written');
for (const fn of ['resetHistory', 'recordHistory', 'restoreHistory']) {
  const body = main.slice(main.indexOf(`function ${fn}(`));
  assert.ok(body.slice(0, body.indexOf('\n}')).includes('persistWorkspace()'),
    `${fn} persists the canvas -- undo included, or a reload would bring back the undone edit`);
}
assert.match(main, /if \(!EMBEDDED\) setExampleHash\(null\);\n  graphHistory\.splice/,
  'the first edit clears #example= so a reload restores the edit, not the pristine example');
{
  const body = main.slice(main.indexOf('function clearFlowgraph('));
  assert.ok(body.slice(0, body.indexOf('\n}')).includes('autosave.clear()'),
    'New and Close drop the saved canvas so a reload opens on the welcome example');
}
assert.match(main, /if \(!loaded && !opened\) await openStartupCanvas\(\);/,
  'the saved canvas is consulted only after the URL has had its say');
assert.match(main, /window\.addEventListener\('pagehide', \(\) => autosave\.flush\(\)\)/);
assert.ok(main.includes("await loadExampleByName('digital/welcome_example.grc', /* updateHash */ false);\n    canvasIsDefaultExample = true;"),
  'the welcome example is still marked as the editor\'s own after the fallback load');

console.log('workspace tests passed');
