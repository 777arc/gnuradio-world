// Throwaway spike harness for the JS Block design (JAVASCRIPT_BLOCKS_PLAN2.md,
// phase 1). This is the shape `runner/src/js_runtime.js` would take: linked with
// --pre-js so it lands in the glue that every em-pthread worker loads.
//
// Everything here runs on whatever thread called into it. Nothing is proxied.
(function () {
  'use strict';

  // Per-realm state. Each em-pthread worker is its own realm, so two blocks on
  // two scheduler threads cannot see each other's compiled sources or globals.
  const blocks = new Map();

  // Rule 1 from the plan: re-derive views through the growable accessors on
  // every call; never cache a subarray across calls.
  const HEAP_FOR = {
    complex: () => GROWABLE_HEAP_F32(),
    float:   () => GROWABLE_HEAP_F32(),
    int:     () => GROWABLE_HEAP_I32(),
    short:   () => GROWABLE_HEAP_I16(),
    byte:    () => GROWABLE_HEAP_I8(),
  };
  const SHIFT = { complex: 2, float: 2, int: 2, short: 1, byte: 0 };
  const PER_ITEM = { complex: 2, float: 1, int: 1, short: 1, byte: 1 };

  function view(dtype, ptr, items) {
    const heap = HEAP_FOR[dtype]();
    const shift = SHIFT[dtype];
    const base = ptr >> shift;
    return heap.subarray(base, base + items * PER_ITEM[dtype]);
  }

  function setError(errPtr, errCap, e) {
    if (!errPtr) return;
    const msg = (e && (e.stack || e.message)) ? String(e.stack || e.message) : String(e);
    stringToUTF8(msg.slice(0, errCap - 1), errPtr, errCap);
  }

  const api = {
    // Is this call executing on the calling (pthread) thread, or was it proxied
    // back to the browser main thread?
    onPthread() { return ENVIRONMENT_IS_PTHREAD ? 1 : 0; },

    // Compile user source. `new Function` -- no CSP in this project (see
    // site/_headers), which fact 3 of the plan depends on.
    compile(handle, srcPtr, errPtr, errCap) {
      try {
        const src = UTF8ToString(srcPtr);
        let descriptor = null;
        const gr = {
          export(d) {
            if (descriptor) throw new Error('gr.export() called more than once');
            descriptor = d;
          },
        };
        // eslint-disable-next-line no-new-func
        const fn = new Function('gr', src);
        fn(gr);
        if (!descriptor) throw new Error('source never called gr.export()');
        const inst = Object.create(null);
        const params = descriptor.params || {};
        for (const k of Object.keys(params)) inst[k] = params[k];
        blocks.set(handle, { d: descriptor, inst });
        if (typeof descriptor.start === 'function') descriptor.start.call(inst);
        return 0;
      } catch (e) { setError(errPtr, errCap, e); return -1; }
    },

    // How many blocks does THIS realm know about? Used to prove isolation.
    count() { return blocks.size; },

    setParam(handle, namePtr, value) {
      const b = blocks.get(handle);
      if (!b) return -1;
      b.inst[UTF8ToString(namePtr)] = value;
      return 0;
    },

    // The hot path. One call per work(), on the block's own scheduler thread.
    work(handle, nout, inPtr, outPtr, errPtr, errCap) {
      const b = blocks.get(handle);
      if (!b) return -1;
      try {
        const din = b.d.inputs || [], dout = b.d.outputs || [];
        const input = [], output = [];
        for (let i = 0; i < din.length; i++) input.push(view(din[i], inPtr, nout));
        for (let i = 0; i < dout.length; i++) output.push(view(dout[i], outPtr, nout));
        const n = b.d.work.call(b.inst, nout, input, output);
        return n | 0;
      } catch (e) { setError(errPtr, errCap, e); return -2; }
    },

    // --- growth probes, spike-only ---------------------------------------
    // Deliberately break rule 1: stash a view and the buffer it came from.
    cacheView(ptr, floats) {
      const heap = GROWABLE_HEAP_F32();
      api._cached = heap.subarray(ptr >> 2, (ptr >> 2) + floats);
      api._cachedBuffer = wasmMemory.buffer;
      api._cachedByteLength = wasmMemory.buffer.byteLength;
      return 1;
    },
    // 0 = buffer object was replaced by growth, 1 = same object.
    cachedBufferIsCurrent() { return api._cachedBuffer === wasmMemory.buffer ? 1 : 0; },
    cachedBufferDetached() { return api._cached.length === 0 ? 1 : 0; },
    // Write through the STALE view. Does it still reach real memory?
    writeThroughCached(value) {
      try { for (let i = 0; i < api._cached.length; i++) api._cached[i] = value; return 1; }
      catch (e) { return 0; }
    },
    // Can a stale view address memory that only exists after growth?
    staleViewCoversNewMemory(ptr, floats) {
      const need = (ptr >> 2) + floats;
      return need <= api._cached.byteOffset / 4 + api._cached.length ? 1 : 0;
    },
    heapBytes() { return wasmMemory.buffer.byteLength; },

    // --- concurrency probe, spike-only -----------------------------------
    // Spin until every participating thread has arrived. If EM_ASM were proxied
    // to the main thread, or if JS work() serialized for any other reason, this
    // cannot reach `total` and returns 0.
    barrier(counterPtr, total, deadlineMs) {
      const i32 = GROWABLE_HEAP_I32();
      Atomics.add(i32, counterPtr >> 2, 1);
      const stop = Date.now() + deadlineMs;
      while (Date.now() < stop) {
        if (Atomics.load(i32, counterPtr >> 2) >= total) return 1;
      }
      return 0;
    },
  };

  globalThis.__grJsSpike = api;
  // Did --pre-js actually execute in this realm? Recorded per realm.
  globalThis.__grJsSpikePreJsRan = true;
})();
