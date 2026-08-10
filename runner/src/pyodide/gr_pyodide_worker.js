// The Pyodide worker: the only place Python runs in this app.
//
// Two clients, one script:
//
//   the editor    posts {type:'introspect'} to derive a Python Block's label,
//                 parameters and ports from its source (editor/src/epy.ts).
//   the runner    posts {type:'attach'} with the runner's WebAssembly memory and
//                 one control block per Python Block, then never posts again:
//                 from there on the GR scheduler threads and this worker talk
//                 through shared memory (blocks/src/python_block.hpp).
//
// Why a worker at all: a block's work() call has to *block* its GR thread until
// Python has answered, which means Atomics.wait, which is illegal on the browser
// main thread. Asyncify is off in this build, so there is no other way to
// suspend. A worker can wait, so the worker is where Python lives.
//
// One worker serves every Python Block in a flowgraph, so their work() calls
// serialize -- the same behaviour as desktop GNU Radio, where the GIL does it.

// ---- the control block ----------------------------------------------------
// Mirror of PythonBlockWasm::Control in blocks/src/python_block.hpp. Both sides
// index the same Int32Array; keep the two in step. The widths are checked at
// attach time, so a mismatch is an error message rather than a wild write.
const MAX_PORTS = 32;

const W_STATE = 0;         // written by this worker: what happened to the request
const W_OP = 1;            // written by the host: which call it wants
const W_NOUTPUT = 2;
const W_NIN = 3;
const W_NOUT = 4;
const W_RESULT = 5;        // work()'s return value, or start()/stop()'s bool
const W_ERROR_LEN = 6;
const W_CONSUME_EACH = 7;  // -1 when the block did not call consume_each()
const W_SET_MASK = 8;      // bit i: callback i has a new value waiting in D_SET_VALUE
const W_SEQ = 9;           // bumped by the host per request; this worker waits on it
const W_IN_PTR = 10;
const W_IN_AVAIL = W_IN_PTR + MAX_PORTS;
const W_OUT_PTR = W_IN_AVAIL + MAX_PORTS;
const W_CONSUME = W_OUT_PTR + MAX_PORTS;
const W_PRODUCE = W_CONSUME + MAX_PORTS;
const CONTROL_WORDS = W_PRODUCE + MAX_PORTS;

// Doubles, in their own region so neither side has to reason about alignment
// inside the int32 block. nitems_read/written are uint64 in C++ and exact as
// doubles to 2^53 items, which no browser flowgraph reaches.
const D_NITEMS_READ = 0;
const D_NITEMS_WRITTEN = MAX_PORTS;
// One slot per callback, so a live parameter change is a plain write plus one
// atomic OR into W_SET_MASK. That is all a QT GUI Range's handler can afford: it
// runs on the browser main thread, which may never block, so it cannot wait for
// Python to acknowledge anything. This worker drains the mask immediately before
// each call into Python, which makes the change take effect on the next work().
const D_SET_VALUE = D_NITEMS_WRITTEN + MAX_PORTS;
const MAX_CALLBACKS = 32;  // one per bit of W_SET_MASK
const DOUBLE_SLOTS = D_SET_VALUE + MAX_CALLBACKS;

// State values (this worker -> host).
const ST_DONE = 2;
const ST_FAILED = 3;

// Op values (host -> this worker).
const OP_WORK = 1;
const OP_START = 2;
const OP_STOP = 3;
const OP_FORECAST = 4;
const OP_EXIT = 5;

// ---- state ----------------------------------------------------------------
let pyodide = null;
let grworld = null;
let memory = null;      // the *runner's* WebAssembly.Memory, not Pyodide's
let heap = null;        // Uint8Array over it, re-derived when it grows
const prepared = new Map();   // name -> description, from prepare()
const attached = new Map();   // name -> control-block entry, from bind()

function post(message) {
  self.postMessage(message);
}

function describeError(error) {
  // A Python exception arrives as Pyodide's PythonError with the traceback in
  // .message, which is the part a user can act on.
  if (error && error.constructor && error.constructor.name === 'PythonError')
    return String(error.message).trim();
  return error && error.stack ? String(error.stack) : String(error);
}

// A view over the runner's memory that survives ALLOW_MEMORY_GROWTH: growing can
// replace the buffer, and a stale view then reads zeros or throws.
// browser_file_reader.js re-derives for the same reason.
function runnerHeap() {
  if (!heap || heap.byteLength !== memory.buffer.byteLength)
    heap = new Uint8Array(memory.buffer);
  return heap;
}

// ---- bootstrap ------------------------------------------------------------

async function init(indexURL, shimURL) {
  const { loadPyodide } = await import(new URL('pyodide.mjs', indexURL).href);
  pyodide = await loadPyodide({
    indexURL,
    // A Python Block reports to the user by printing, exactly as a C++ block
    // does; the client forwards these to the editor's console pane.
    stdout: line => post({ type: 'print', line }),
    stderr: line => post({ type: 'print', line }),
  });
  // numpy up front because every Python Block needs it: the base classes
  // describe their ports with numpy dtypes. Anything else a block imports is
  // loaded from that block's own source -- see loadImports.
  await pyodide.loadPackage('numpy');

  // The shim -- gnuradio.gr's block base classes, pmt, and grworld itself -- is
  // written into Pyodide's filesystem rather than bundled into this script, so it
  // stays readable, reviewable Python next to a host test that runs it. The
  // manifest is generated at build time from the directory contents, so it
  // cannot drift from what is actually there.
  const manifest = await (await fetch(new URL('manifest.json', shimURL))).json();
  const sources = await Promise.all(manifest.files.map(async name => {
    const response = await fetch(new URL(name, shimURL));
    if (!response.ok) throw new Error(`Python shim file ${name}: HTTP ${response.status}`);
    return [name, await response.text()];
  }));
  const root = '/gr_shim';
  pyodide.FS.mkdirTree(root);
  for (const [name, text] of sources) {
    const path = `${root}/${name}`;
    const slash = path.lastIndexOf('/');
    if (slash > root.length) pyodide.FS.mkdirTree(path.slice(0, slash));
    pyodide.FS.writeFile(path, text);
  }
  pyodide.runPython(`import sys; sys.path.insert(0, ${JSON.stringify(root)})`);
  grworld = pyodide.pyimport('grworld');
  post({ type: 'ready', python: pyodide.version });
}

// ---- packages a block's source asks for ------------------------------------

/**
 * Install whatever Pyodide packages `source` imports, before it is executed.
 *
 * Pyodide reads the import statements and resolves them against
 * pyodide-lock.json, so `from scipy.signal import fftconvolve` installs scipy
 * and an import of something Pyodide does not ship is left alone (to fail as an
 * ordinary ImportError, which is the message the block author can act on).
 *
 * Lazily, and not at start-up, because scipy is 14 MB against numpy's 3 -- a
 * block that does not import it should never pay for it. Loading is idempotent
 * and cheap once installed, so this runs per source rather than being cached.
 */
async function loadImports(source) {
  try {
    await pyodide.loadPackagesFromImports(source, {
      // A 14 MB fetch is worth saying out loud: both clients put these in the
      // console pane, where the wait then has an explanation.
      messageCallback: line => post({ type: 'print', line }),
      errorCallback: line => post({ type: 'print', line }),
    });
  } catch (error) {
    // The usual cause is a package Pyodide ships but this site does not serve:
    // the wheels are vendored one by one (deps/fetch-pyodide.sh), so the fetch
    // 404s rather than the package being unknown.
    throw new Error('loading the packages this block imports failed: ' +
      describeError(error) + ' (a package Pyodide ships may not be vendored ' +
      'here -- see WHEELS in deps/fetch-pyodide.sh)');
  }
}

// ---- the editor's client --------------------------------------------------

async function introspect(id, source, params, scope) {
  await loadImports(source);
  post({ type: 'introspected', id, io: grworld.introspect(source, params, scope) });
}

// ---- the runner's client -------------------------------------------------

// Step one, before the runner builds a single C++ block: instantiate every
// Python Block from its source and the flowgraph's parameter values, and report
// what each one turned out to be. The runner needs the io signature, the history
// and the output multiple *before* it can construct the C++ block, because
// buffers are sized at construction -- so this cannot be deferred to first use,
// and the block's own constructor cannot wait for it either (it runs on the
// browser main thread, which may not block).
async function prepare(request) {
  if (request.controlWords !== CONTROL_WORDS || request.doubleSlots !== DOUBLE_SLOTS)
    throw new Error('Python Block control block mismatch: the runner says ' +
      `${request.controlWords}/${request.doubleSlots} words, this worker ` +
      `${CONTROL_WORDS}/${DOUBLE_SLOTS} -- python_block.hpp and ` +
      'gr_pyodide_worker.js are out of step');
  const descriptions = {};
  for (const block of request.blocks) {
    await loadImports(block.source);
    const description = grworld.create(block.name, block.source, block.params, request.scope);
    prepared.set(block.name, description);
    descriptions[block.name] = description;
  }
  return descriptions;
}

// Step two, from each block's constructor: here is my control block, start
// serving me. Asynchronous on purpose -- the constructor posts and returns. A
// work() request that arrives before this lands is not lost: it is a durable
// sequence-number bump in shared memory, so the pump serves it as soon as it
// starts. The GR thread is futex-waiting either way.
function bind(request) {
  memory = request.memory;
  heap = null;
  const description = prepared.get(request.name);
  if (!description) throw new Error(`Python Block ${request.name} was never prepared`);
  const entry = {
    name: request.name,
    textPointer: request.textPointer,
    textCapacity: request.textCapacity,
    control: new Int32Array(memory.buffer, request.controlPointer, CONTROL_WORDS),
    doubles: new Float64Array(memory.buffer, request.doublePointer, DOUBLE_SLOTS),
    callbacks: description.callbacks || [],
    seq: 0,
  };
  attached.set(entry.name, entry);
  pump(entry);
}

function detach() {
  for (const entry of attached.values()) {
    Atomics.store(entry.control, W_OP, OP_EXIT);
    Atomics.add(entry.control, W_SEQ, 1);
    Atomics.notify(entry.control, W_SEQ);
  }
  for (const name of prepared.keys()) grworld.destroy(name);
  attached.clear();
  prepared.clear();
}

// One pump per block. Each waits for its own control block's sequence number to
// move, serves that one request and answers.
//
// The sequence number is what makes the handshake unambiguous: the host bumps it
// last when posting a request, so waiting for "W_SEQ != the value I last served"
// can neither miss a request nor spin on a stale response the host has not
// collected yet. W_STATE carries only the answer, which the host futex-waits on.
async function pump(entry) {
  const control = entry.control;
  for (;;) {
    const waiter = Atomics.waitAsync(control, W_SEQ, entry.seq);
    if (waiter.async) {
      const outcome = await waiter.value;
      if (outcome === 'timed-out') continue;
    }
    const seq = Atomics.load(control, W_SEQ);
    if (seq === entry.seq) continue;   // spurious wake: nothing new posted
    entry.seq = seq;

    const op = Atomics.load(control, W_OP);
    if (op === OP_EXIT || !attached.has(entry.name)) return;
    try {
      applyPendingParameters(entry);
      serve(entry, op);
      Atomics.store(control, W_STATE, ST_DONE);
    } catch (error) {
      writeError(entry, describeError(error));
      Atomics.store(control, W_STATE, ST_FAILED);
    }
    Atomics.notify(control, W_STATE);
  }
}

function serve(entry, op) {
  const control = entry.control;
  switch (op) {
    case OP_WORK:
      return serveWork(entry);
    case OP_START:
      control[W_RESULT] = grworld.start(entry.name) ? 1 : 0;
      return;
    case OP_STOP:
      control[W_RESULT] = grworld.stop(entry.name) ? 1 : 0;
      return;
    case OP_FORECAST: {
      const required = grworld.forecast(entry.name, control[W_NOUTPUT], control[W_NIN]);
      for (let i = 0; i < required.length; ++i) control[W_IN_AVAIL + i] = required[i];
      return;
    }
    default:
      throw new Error(`unknown Python Block op ${op}`);
  }
}

// Drain W_SET_MASK: every callback whose bit is set has a fresh value waiting.
// Exchanging the mask for zero in one atomic op means a value written after this
// point is simply picked up next time rather than lost.
function applyPendingParameters(entry) {
  const mask = Atomics.exchange(entry.control, W_SET_MASK, 0);
  if (!mask) return;
  for (let i = 0; i < MAX_CALLBACKS; ++i) {
    if (!(mask & (1 << i))) continue;
    const key = entry.callbacks[i];
    if (key !== undefined) grworld.set_param(entry.name, key, entry.doubles[D_SET_VALUE + i]);
  }
}

function serveWork(entry) {
  const control = entry.control;
  const noutput = control[W_NOUTPUT];
  const nin = control[W_NIN];
  const nout = control[W_NOUT];
  const inputPointers = [], inputAvailable = [], outputPointers = [];
  const nitemsRead = [], nitemsWritten = [];
  for (let i = 0; i < nin; ++i) {
    inputPointers.push(control[W_IN_PTR + i]);
    inputAvailable.push(control[W_IN_AVAIL + i]);
    nitemsRead.push(entry.doubles[D_NITEMS_READ + i]);
  }
  for (let i = 0; i < nout; ++i) {
    outputPointers.push(control[W_OUT_PTR + i]);
    nitemsWritten.push(entry.doubles[D_NITEMS_WRITTEN + i]);
  }
  const result = grworld.work(entry.name, noutput, runnerHeap(), inputPointers,
                              inputAvailable, outputPointers, nitemsRead, nitemsWritten);
  control[W_RESULT] = result[0];
  control[W_CONSUME_EACH] = result[1];
  for (let i = 0; i < nin; ++i) control[W_CONSUME + i] = result[2 + i];
  for (let i = 0; i < nout; ++i) control[W_PRODUCE + i] = result[2 + nin + i];
}

function writeError(entry, message) {
  const bytes = new TextEncoder().encode(message);
  const length = Math.min(bytes.length, entry.textCapacity - 1);
  new Uint8Array(memory.buffer, entry.textPointer, entry.textCapacity)
    .set(bytes.subarray(0, length));
  entry.control[W_ERROR_LEN] = length;
  // Also straight to the console pane: a raise out of work() is the commonest way
  // a Python Block fails, and the traceback is the whole story.
  post({ type: 'print', line: `${entry.name}: ${message}` });
}

// ---- message plumbing ----------------------------------------------------

self.onmessage = async event => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'init':
        await init(request.indexURL, request.shimURL);
        return;
      case 'introspect':
        await introspect(request.id, request.source, request.params, request.scope);
        return;
      case 'prepare':
        post({ type: 'prepared', id: request.id, descriptions: await prepare(request) });
        return;
      case 'bind':
        bind(request);
        return;
      case 'detach':
        detach();
        return;
      default:
        throw new Error(`unknown message ${request.type}`);
    }
  } catch (error) {
    post({ type: 'failed', id: request.id, message: describeError(error) });
  }
};
