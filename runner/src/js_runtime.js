// The JavaScript Block's runtime, browser side. See docs/js-blocks.md.
//
// Linked with --pre-js, so this lands in runner.js itself -- the glue every
// Emscripten pthread worker loads before it runs a single scheduler thread. That
// is the whole trick: a JS block's work() is a plain synchronous call made from
// the block's own GR scheduler thread, with zero-copy typed-array views straight
// onto GNU Radio's circular buffers. Nothing here is proxied and nothing here
// waits.
//
// Three rules this file exists to keep:
//
//   1. Views are re-derived through GROWABLE_HEAP_* on EVERY call and never
//      cached across calls. On a -pthread shared heap, growth does not detach the
//      old SharedArrayBuffer -- a stale view keeps reading and writing the same
//      real memory, correctly. What it cannot do is address memory that only
//      exists after the growth, so a cached subarray fails as a silent
//      out-of-range against a buffer allocated later, not as a crash. That is a
//      much quieter bug than a detach would be, which makes the rule more
//      load-bearing rather than less.
//
//   2. Nothing here may use MAIN_THREAD_EM_ASM, window, or anything else that
//      reaches the browser main thread. `window` is undefined on a pthread;
//      globalThis is what exists in every realm. The C++ side's hot path uses
//      plain EM_ASM for the same reason (blocks/src/js_block.hpp).
//
//   3. A JS exception never unwinds through a wasm frame. Every entry point
//      catches, writes error.stack into the fixed buffer C++ handed it, and
//      returns a negative code that becomes a std::runtime_error.
//
// This file is also served as a static asset (runner/build/js_runtime.js) and
// read by the editor, which evaluates the very same descriptor validation inside
// a sandboxed iframe. Editor and runner therefore cannot disagree about what a
// descriptor means. Keep it free of Emscripten-only globals at load time --
// UTF8ToString and friends are referenced inside functions only, so the file
// evaluates fine in a plain realm that never calls them.
(function () {
  'use strict';

  // ---- the control-word layout, mirrored in blocks/src/js_block.hpp --------
  // One int32 array per block, owned by C++. Names match the C++ enum.
  var MAX_PORTS = 32;
  var W_NOUT = 0;          // host -> js: noutput_items
  var W_NIN_PORTS = 1;
  var W_NOUT_PORTS = 2;
  var W_RESULT = 3;        // js -> host: what work()/generalWork() returned
  var W_CONSUME_EACH = 4;  // js -> host: -1 when the block consumed per port
  var W_LOG_PENDING = 5;   // js -> host: this.log() has lines waiting
  var W_IN_PTR = 8;
  var W_IN_AVAIL = W_IN_PTR + MAX_PORTS;
  var W_OUT_PTR = W_IN_AVAIL + MAX_PORTS;
  var W_CONSUME = W_OUT_PTR + MAX_PORTS;
  var W_FORECAST = W_CONSUME + MAX_PORTS;
  var W_WORDS = W_FORECAST + MAX_PORTS;

  // ---- stream types --------------------------------------------------------
  // The view a port's dtype produces, and how many array elements one item of it
  // occupies. complex is interleaved I/Q in a Float32Array, so two.
  var DTYPES = {
    complex: { elems: 2, bytes: 4, heap: 'F32', shift: 2 },
    float:   { elems: 1, bytes: 4, heap: 'F32', shift: 2 },
    int:     { elems: 1, bytes: 4, heap: 'I32', shift: 2 },
    short:   { elems: 1, bytes: 2, heap: 'I16', shift: 1 },
    byte:    { elems: 1, bytes: 1, heap: 'I8',  shift: 0 },
  };
  var DTYPE_NAMES = Object.keys(DTYPES);

  function heapFor(name) {
    switch (name) {
      case 'F32': return GROWABLE_HEAP_F32();
      case 'I32': return GROWABLE_HEAP_I32();
      case 'I16': return GROWABLE_HEAP_I16();
      default: return GROWABLE_HEAP_I8();
    }
  }

  // Rule 1. Fresh every call; a `subarray` costs tens of nanoseconds against a
  // work() that moves thousands of items, so there is no reason to bend it.
  function view(port, ptr, items) {
    var spec = DTYPES[port.dtype];
    var heap = heapFor(spec.heap);
    var base = ptr >> spec.shift;
    return heap.subarray(base, base + items * spec.elems * port.vlen);
  }

  // ---- descriptor validation ----------------------------------------------
  // Everything a source is allowed to say about itself, normalized to plain data
  // the C++ factory and the editor both read. Errors name the offending field:
  // this is the only feedback a block author gets while typing.

  function fail(message) { throw new Error(message); }

  function normalizePort(spec, where) {
    var dtype = spec, vlen = 1;
    if (spec && typeof spec === 'object') {
      dtype = spec.dtype;
      vlen = spec.vlen === undefined ? 1 : spec.vlen;
    }
    if (typeof dtype !== 'string' || !DTYPES[dtype])
      fail(where + ': unknown port type ' + JSON.stringify(dtype) +
           ' (expected one of ' + DTYPE_NAMES.join(', ') + ')');
    vlen = Math.trunc(Number(vlen));
    if (!(vlen >= 1)) fail(where + ': vlen must be a positive integer');
    return { dtype: dtype, vlen: vlen };
  }

  function normalizePorts(list, where) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) fail(where + ' must be an array');
    if (list.length > MAX_PORTS)
      fail(where + ': at most ' + MAX_PORTS + ' ports on one side');
    return list.map(function (spec, i) {
      return normalizePort(spec, where + '[' + i + ']');
    });
  }

  function positiveInt(value, fallback, where) {
    if (value === undefined || value === null) return fallback;
    var n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n < 1) fail(where + ' must be a positive integer');
    return n;
  }

  /**
   * A descriptor as it came from gr.export(), turned into plain JSON-safe data.
   * The same object shape is what make_js_block() reads on the main thread and
   * what the editor turns into a RunnableDef.
   */
  function describe(d) {
    if (!d || typeof d !== 'object') fail('gr.export() needs a descriptor object');
    var hasWork = typeof d.work === 'function';
    var hasGeneral = typeof d.generalWork === 'function';
    if (hasWork && hasGeneral)
      fail('a block defines work() or generalWork(), not both');
    if (!hasWork && !hasGeneral)
      fail('the descriptor has no work() (or generalWork()) function');

    var inputs = normalizePorts(d.inputs, 'inputs');
    var outputs = normalizePorts(d.outputs, 'outputs');
    if (!inputs.length && !outputs.length)
      fail('a block needs at least one input or output port');

    var params = [];
    var numericParams = [];
    var raw = d.params || {};
    if (typeof raw !== 'object' || Array.isArray(raw))
      fail('params must be an object of default values');
    Object.keys(raw).forEach(function (name) {
      if (!/^[A-Za-z_]\w*$/.test(name))
        fail('params: ' + JSON.stringify(name) + ' is not a usable identifier');
      var value = raw[name];
      var kind = typeof value;
      if (kind === 'function' || (kind === 'object' && value !== null))
        fail('params.' + name + ': only numbers, strings and booleans have defaults');
      params.push([name, value === undefined ? null : value]);
      if (kind === 'number') numericParams.push(name);
    });
    if (numericParams.length > MAX_PORTS)
      fail('at most ' + MAX_PORTS + ' numeric parameters');

    var decim = positiveInt(d.decimation, 1, 'decimation');
    var interp = positiveInt(d.interpolation, 1, 'interpolation');
    var relativeRate = d.relativeRate === undefined || d.relativeRate === null
      ? interp / decim : Number(d.relativeRate);
    if (!Number.isFinite(relativeRate) || relativeRate <= 0)
      fail('relativeRate must be a positive number');

    return {
      label: typeof d.label === 'string' && d.label.trim()
        ? d.label.trim() : 'JS Block',
      doc: typeof d.doc === 'string' ? d.doc : '',
      inputs: inputs,
      outputs: outputs,
      params: params,
      numericParams: numericParams,
      decim: decim,
      interp: interp,
      history: positiveInt(d.history, 1, 'history'),
      outputMultiple: d.outputMultiple === undefined || d.outputMultiple === null
        ? 0 : positiveInt(d.outputMultiple, 0, 'outputMultiple'),
      relativeRate: relativeRate,
      general: hasGeneral,
      overridesForecast: typeof d.forecast === 'function',
      hasStart: typeof d.start === 'function',
      hasStop: typeof d.stop === 'function',
    };
  }

  /**
   * Evaluate one block source and hand back {descriptor, info}. `new Function`
   * rather than a module: the source is a function body, there is no module graph
   * and no import. This project ships no Content-Security-Policy, and if one is
   * ever added it must keep script-src 'unsafe-eval' (docs/ci.md).
   *
   * Module-level side effects run once per evaluation, and the source is
   * evaluated twice per block -- once on the main thread for its descriptor, once
   * on the block's own thread for its instance. Per-instance state belongs in
   * start() or on `this`.
   */
  function evaluate(source) {
    var descriptor = null;
    var gr = {
      export: function (d) {
        if (descriptor) fail('gr.export() was called more than once');
        if (!d) fail('gr.export() needs a descriptor object');
        descriptor = d;
      },
    };
    var fn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function('gr', '"use strict";\n' + String(source));
    } catch (e) {
      fail('the block source did not parse: ' + (e && e.message ? e.message : e));
    }
    fn(gr);
    if (!descriptor)
      fail('the block source never called gr.export({...}) — a JS block ' +
           'registers itself with exactly one such call');
    return { descriptor: descriptor, info: describe(descriptor) };
  }

  // ---- per-realm instance table -------------------------------------------
  // Each em-pthread worker is its own realm, so two blocks on two scheduler
  // threads cannot see each other's compiled sources or globals. The handle is
  // the C++ object's address, which is unique within the process.
  var blocks = new Map();

  function errorText(e) {
    if (!e) return 'the block threw a non-Error value';
    var text = e.stack || e.message || String(e);
    return String(text);
  }

  function setError(errPtr, errCap, e) {
    if (!errPtr || !errCap) return;
    var message = errorText(e);
    // Leave room for the terminator; stringToUTF8 will not split a code point.
    stringToUTF8(message.slice(0, errCap - 1), errPtr, errCap);
  }

  function phaseError(phase, e) {
    var message = errorText(e);
    return new Error('[' + phase + '] ' + message);
  }

  var api = {
    // Shared with js_block.hpp so a layout change cannot be half-applied.
    WORDS: W_WORDS,
    MAX_PORTS: MAX_PORTS,

    /** The pure half, for the editor's sandbox and for tests. */
    describeSource: function (source) {
      try {
        return { ok: true, info: evaluate(source).info };
      } catch (e) {
        return { ok: false, error: errorText(phaseError('descriptor', e)) };
      }
    },

    /**
     * Main thread, inside make_js_block(): what does this source say it is?
     * Returns a malloc'd JSON string the caller frees, or 0 with the reason in
     * the error buffer. Nothing is retained -- the descriptor is data, and the
     * instance that will actually run is built later, on the block's own thread.
     */
    describe: function (srcPtr, errPtr, errCap) {
      try {
        return stringToNewUTF8(JSON.stringify(evaluate(UTF8ToString(srcPtr)).info));
      } catch (e) {
        setError(errPtr, errCap, phaseError('descriptor', e));
        return 0;
      }
    },

    /**
     * Block thread, before the first work(): build the instance. The source is
     * evaluated a second time here because a JS object cannot cross a worker
     * boundary -- see "Why the source is evaluated twice" in docs/js-blocks.md.
     *
     * `paramsPtr` is the flowgraph's values for this instance as a JSON object;
     * they land on `this` under their own names, the same shape as
     * self.example_param in a Python block.
     */
    compile: function (handle, srcPtr, paramsPtr, errPtr, errCap) {
      var phase = 'compile';
      try {
        var evaluated = evaluate(UTF8ToString(srcPtr));
        var d = evaluated.descriptor;
        var info = evaluated.info;
        var self = {};
        info.params.forEach(function (entry) { self[entry[0]] = entry[1]; });
        var overridesText = paramsPtr ? UTF8ToString(paramsPtr) : '';
        var overrides = overridesText ? JSON.parse(overridesText) : {};
        Object.keys(overrides).forEach(function (name) { self[name] = overrides[name]; });
        var block = {
          d: d, info: info, self: self,
          // Recorded by this.consume() and applied by C++ when the call returns.
          // GR's own consume() only moves a read pointer nothing reads until
          // general_work() is done, so recording it is not a deferral of anything
          // observable -- it just keeps the JS side free of exported shims.
          consumed: null,
        };
        // `this.consume(port, n)` for a generalWork() block. Bound here so a
        // block that stashes it on construction still gets its own.
        self.consume = function (port, n) {
          port = port | 0;
          if (port < 0 || port >= info.inputs.length)
            fail('consume(): no input port ' + port);
          if (!block.consumed) block.consumed = new Array(info.inputs.length).fill(0);
          block.consumed[port] += Math.max(0, n | 0);
        };
        // What a running flowgraph prints reaches the editor's console pane, and
        // console.log from a scheduler worker reaches only devtools, where nobody
        // looks. So lines are queued here and drained by C++ into printf(), which
        // is the path every other block's output already takes. A word flag makes
        // the common case -- a block that never logs -- free.
        block.log = [];
        self.log = function () {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            var value = arguments[i];
            parts.push(typeof value === 'string' ? value
                       : (value && typeof value === 'object') ? JSON.stringify(value)
                       : String(value));
          }
          if (block.log.length < 64) block.log.push(parts.join(' '));
        };
        blocks.set(handle, block);
        if (typeof d.start === 'function') {
          phase = 'start';
          d.start.call(self);
        }
        return 0;
      } catch (e) {
        setError(errPtr, errCap, phaseError(phase, e));
        return -1;
      }
    },

    /**
     * A live parameter change, drained from the dirty mask by C++ immediately
     * before the next work() -- so it lands *between* calls and none is lost.
     */
    setParam: function (handle, namePtr, value) {
      var block = blocks.get(handle);
      if (!block) return -1;
      block.self[UTF8ToString(namePtr)] = value;
      return 0;
    },

    /** The hot path. One call per work(), on the block's own scheduler thread. */
    work: function (handle, wordsPtr, errPtr, errCap) {
      var block = blocks.get(handle);
      if (!block) { setError(errPtr, errCap, new Error('this block was never compiled')); return -1; }
      var words = GROWABLE_HEAP_I32();
      var base = wordsPtr >> 2;
      try {
        var info = block.info;
        var nout = words[base + W_NOUT];
        var inPorts = words[base + W_NIN_PORTS];
        var outPorts = words[base + W_NOUT_PORTS];
        var input = [], output = [], avail = [], i;

        if (info.general) {
          for (i = 0; i < inPorts; i++) {
            avail.push(words[base + W_IN_AVAIL + i]);
            input.push(view(info.inputs[i], words[base + W_IN_PTR + i], avail[i]));
          }
        } else {
          // A sync/decim/interp block is guaranteed nout*decim/interp input
          // items, exactly as GNU Radio's sync_block family is.
          var needed = Math.floor(nout * info.decim / info.interp);
          for (i = 0; i < inPorts; i++)
            input.push(view(info.inputs[i], words[base + W_IN_PTR + i],
                            Math.min(needed, words[base + W_IN_AVAIL + i])));
        }
        for (i = 0; i < outPorts; i++)
          output.push(view(info.outputs[i], words[base + W_OUT_PTR + i], nout));

        var produced;
        if (info.general) {
          block.consumed = null;
          produced = block.d.generalWork.call(block.self, nout, avail, input, output);
        } else {
          produced = block.d.work.call(block.self, nout, input, output);
        }
        produced = produced === undefined ? nout : (produced | 0);

        // The words array can have moved if user code grew the heap, so re-read
        // it before writing anything back. Rule 1, applied to our own view.
        words = GROWABLE_HEAP_I32();
        words[base + W_RESULT] = produced;
        words[base + W_LOG_PENDING] = block.log.length ? 1 : 0;
        if (info.general) {
          // A general block consumes nothing it did not ask to consume -- which
          // is precisely what gr::block's contract says, and why generalWork()
          // gets this.consume(port, n) in the first place.
          words[base + W_CONSUME_EACH] = -1;
          for (i = 0; i < inPorts; i++)
            words[base + W_CONSUME + i] = block.consumed ? (block.consumed[i] | 0) : 0;
          block.consumed = null;
        } else {
          // What every sync/decim/interp block's general_work() does:
          // consume_each(r * decimation) / consume_each(r / interpolation).
          words[base + W_CONSUME_EACH] = produced > 0
            ? Math.floor(produced * info.decim / info.interp) : 0;
        }
        return 0;
      } catch (e) {
        setError(errPtr, errCap, phaseError('work', e));
        return -2;
      }
    },

    /** Only called for a descriptor that supplies its own forecast(). */
    forecast: function (handle, wordsPtr, errPtr, errCap) {
      var block = blocks.get(handle);
      if (!block) { setError(errPtr, errCap, new Error('this block was never compiled')); return -1; }
      try {
        var words = GROWABLE_HEAP_I32();
        var base = wordsPtr >> 2;
        var nout = words[base + W_NOUT];
        var ports = words[base + W_NIN_PORTS];
        var required = new Array(ports).fill(0);
        block.d.forecast.call(block.self, nout, required);
        words = GROWABLE_HEAP_I32();
        for (var i = 0; i < ports; i++)
          words[base + W_FORECAST + i] = Math.max(0, required[i] | 0);
        return 0;
      } catch (e) {
        setError(errPtr, errCap, phaseError('forecast', e));
        return -2;
      }
    },

    /** The optional stop() hook, and the instance's last rites. */
    stop: function (handle, errPtr, errCap) {
      var block = blocks.get(handle);
      if (!block) return 0;
      try {
        if (typeof block.d.stop === 'function') block.d.stop.call(block.self);
        return 0;
      } catch (e) {
        setError(errPtr, errCap, phaseError('stop', e));
        return -2;
      }
      // Deliberately not deleted here: the caller drains this.log() afterwards,
      // and stop() is exactly where a block reports its totals. destroy() is what
      // forgets it -- though in practice the realm dies with its worker.
    },

    /**
     * Drain this block's queued this.log() lines into a buffer C++ owns, which
     * printf()s them -- so they land in the console pane below the flowgraph
     * rather than in a worker's devtools console. Returns the byte length written.
     */
    takeLog: function (handle, ptr, cap) {
      var block = blocks.get(handle);
      if (!block || !block.log.length) return 0;
      var text = block.log.join('\n');
      block.log.length = 0;
      stringToUTF8(text.slice(0, cap - 1), ptr, cap);
      return 1;
    },

    destroy: function (handle) { blocks.delete(handle); return 0; },

    /** How many blocks does THIS realm hold? Used by the tests. */
    count: function () { return blocks.size; },
  };

  globalThis.__grJs = api;
})();
