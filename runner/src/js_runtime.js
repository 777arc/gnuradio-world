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

  // ---- PMT values ---------------------------------------------------------
  // Handles and borrowed heap views never escape these converters. Everything
  // author code sees is an owned JavaScript value and may be retained.
  var K = {
    NIL: 0, BOOL: 1, SYMBOL: 2, LONG: 3, U64: 4, REAL: 5, COMPLEX: 6,
    DICT: 7, PAIR: 8, VECTOR: 9, TUPLE: 10,
    U8: 20, S8: 21, U16: 22, S16: 23, U32: 24, S32: 25,
    U64V: 26, S64: 27, F32: 28, F64: 29, C32: 30, C64: 31, BLOB: 32,
  };
  var BRAND = Symbol('GNU Radio PMT value');
  var U64_MAX = (1n << 64n) - 1n;
  var SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

  function branded(kind, value) {
    if (value && (typeof value === 'object' || typeof value === 'function'))
      Object.defineProperty(value, BRAND, { value: kind });
    return value;
  }
  function realValue(value) {
    return branded('real', {
      value: value,
      valueOf: function () { return this.value; },
      toString: function () { return String(this.value); },
    });
  }
  function complexValue(re, im) {
    return branded('complex', { re: Number(re), im: Number(im) });
  }
  function pairValue(car, cdr) { return branded('pair', { car: car, cdr: cdr }); }
  function dictValue(entries) { return branded('dict', { entries: entries || [] }); }
  function tupleValue(values) { return branded('tuple', values || []); }

  function shimFailure(name) {
    var ptr = _gr_js_last_error();
    var detail = ptr ? UTF8ToString(ptr) : '';
    throw new Error(name + ' failed' + (detail ? ': ' + detail : ''));
  }
  function checkedHandle(name, value) {
    if (value < 0) shimFailure(name);
    return value;
  }
  function allocText(text) {
    var bytes = new TextEncoder().encode(String(text));
    var ptr = _malloc(bytes.length + 1);
    stringToUTF8(String(text), ptr, bytes.length + 1);
    return ptr;
  }
  function makeScalar(kind, lo, hi, x, y, text) {
    var ptr = 0;
    try {
      if (text !== undefined) ptr = allocText(text);
      return checkedHandle('PMT scalar conversion',
        _gr_js_pmt_make(kind, lo || 0, hi || 0, x || 0, y || 0, ptr));
    } finally { if (ptr) _free(ptr); }
  }
  function u64Words(value, where) {
    var n;
    if (typeof value === 'bigint') n = value;
    else {
      if (!Number.isSafeInteger(value) || value < 0)
        // The value matters: this is what a work() called with the wrong
        // argument order looks like from in here, and "must be a non-negative
        // safe integer" alone reads as a rule rather than as NaN arriving.
        fail(where + ' must be a non-negative safe integer or BigInt (got ' +
             (typeof value === 'number' ? String(value) : typeof value) + ')');
      n = BigInt(value);
    }
    if (n < 0n || n > U64_MAX) fail(where + ' is outside the uint64 range');
    return [Number(n & 0xffffffffn), Number((n >> 32n) & 0xffffffffn)];
  }
  function counterNumber(lo, hi, where) {
    var value = BigInt(lo >>> 0) | (BigInt(hi >>> 0) << 32n);
    if (value > SAFE_MAX)
      fail(where + ' exceeds JavaScript\'s exact integer range (2^53 - 1)');
    return Number(value);
  }
  function sequenceHandle(kind, values) {
    var handles = values.map(toPmt), ptr = 0;
    try {
      if (handles.length) {
        ptr = _malloc(handles.length * 4);
        GROWABLE_HEAP_I32().set(handles, ptr >> 2);
      }
      return checkedHandle('PMT sequence conversion',
        _gr_js_pmt_seq(kind, ptr, handles.length));
    } finally { if (ptr) _free(ptr); }
  }
  function dictionaryHandle(entries) {
    var handles = [];
    entries.forEach(function (entry) {
      handles.push(toPmt(entry[0]), toPmt(entry[1]));
    });
    var ptr = 0;
    try {
      if (handles.length) {
        ptr = _malloc(handles.length * 4);
        GROWABLE_HEAP_I32().set(handles, ptr >> 2);
      }
      return checkedHandle('PMT dictionary conversion',
        _gr_js_pmt_dict(ptr, handles.length));
    } finally { if (ptr) _free(ptr); }
  }
  var TYPED_KIND = new Map([
    [Uint8Array, K.U8], [Int8Array, K.S8], [Uint16Array, K.U16],
    [Int16Array, K.S16], [Uint32Array, K.U32], [Int32Array, K.S32],
    [Float32Array, K.F32], [Float64Array, K.F64],
  ]);
  if (typeof BigUint64Array !== 'undefined') TYPED_KIND.set(BigUint64Array, K.U64V);
  if (typeof BigInt64Array !== 'undefined') TYPED_KIND.set(BigInt64Array, K.S64);

  function uniformHandle(value, forcedKind) {
    var kind = forcedKind || TYPED_KIND.get(value.constructor);
    if (!kind) fail('unsupported typed array at the PMT boundary');
    var count = (kind === K.C32 || kind === K.C64) ? value.length / 2 : value.length;
    if (!Number.isInteger(count)) fail('a complex PMT vector needs interleaved re/im values');
    var meta = _malloc(16), handle;
    try {
      handle = checkedHandle('PMT uniform-vector allocation',
        _gr_js_pmt_blob_new(kind, count, meta));
      // The shim may grow memory. Re-derive both the metadata and destination
      // views after it returns; a stale SharedArrayBuffer view fails silently.
      var m = GROWABLE_HEAP_U32();
      var base = meta >> 2, ptr = m[base], bytes = m[base + 1];
      var src = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (src.byteLength !== bytes)
        fail('the PMT vector allocation returned ' + bytes + ' bytes for ' + src.byteLength);
      GROWABLE_HEAP_U8().set(src, ptr);
      return handle;
    } finally { _free(meta); }
  }

  function toPmt(value) {
    if (value === null || value === undefined) return makeScalar(K.NIL);
    if (typeof value === 'boolean') return makeScalar(K.BOOL, 0, 0, value ? 1 : 0);
    if (typeof value === 'string') return makeScalar(K.SYMBOL, 0, 0, 0, 0, value);
    if (typeof value === 'bigint') {
      var uw = u64Words(value, 'a PMT uint64');
      return makeScalar(K.U64, uw[0], uw[1]);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('a PMT number must be finite');
      if (Number.isInteger(value)) {
        if (value < -2147483648 || value > 2147483647)
          fail('an integral PMT number must fit wasm32 long; use pmt.from_uint64(1n) for uint64');
        return makeScalar(K.LONG, value >>> 0);
      }
      return makeScalar(K.REAL, 0, 0, value);
    }
    var kind = value && value[BRAND];
    if (kind === 'real') return makeScalar(K.REAL, 0, 0, Number(value.value));
    if (kind === 'complex') return makeScalar(K.COMPLEX, 0, 0, value.re, value.im);
    if (kind === 'pair') return sequenceHandle(K.PAIR, [value.car, value.cdr]);
    if (kind === 'tuple') return sequenceHandle(K.TUPLE, Array.from(value));
    if (kind === 'dict') return dictionaryHandle(value.entries);
    if (kind === 'blob') return uniformHandle(value, K.BLOB);
    if (kind === 'c32') return uniformHandle(value, K.C32);
    if (kind === 'c64') return uniformHandle(value, K.C64);
    if (ArrayBuffer.isView(value)) return uniformHandle(value);
    if (Array.isArray(value)) return sequenceHandle(K.VECTOR, value);
    if (value && Object.getPrototypeOf(value) === Object.prototype)
      return dictionaryHandle(Object.keys(value).map(function (key) { return [key, value[key]]; }));
    fail('unsupported JavaScript value at the PMT boundary');
  }

  function scalarWords(handle) {
    var ptr = _malloc(8);
    try {
      if (_gr_js_pmt_u64(handle, ptr) < 0) shimFailure('PMT uint64 read');
      var w = GROWABLE_HEAP_U32(), base = ptr >> 2;
      return [w[base], w[base + 1]];
    } finally { _free(ptr); }
  }
  function pmtText(handle) {
    var cap = 4096, ptr = _malloc(cap);
    try {
      if (_gr_js_pmt_text(handle, ptr, cap) < 0) shimFailure('PMT symbol read');
      return UTF8ToString(ptr);
    } finally { _free(ptr); }
  }
  function refHandle(handle, op, index) {
    return checkedHandle('PMT reference', _gr_js_pmt_ref(handle, op, index || 0));
  }
  function copiedUniform(handle, kind) {
    var meta = _malloc(16);
    try {
      if (_gr_js_pmt_blob(handle, meta) < 0) shimFailure('PMT vector read');
      var m = GROWABLE_HEAP_U32(), base = meta >> 2;
      var ptr = m[base], count = m[base + 1], bytes = m[base + 2];
      var value;
      if (kind === K.U8) value = new Uint8Array(GROWABLE_HEAP_U8().buffer, ptr, count).slice();
      else if (kind === K.S8) value = new Int8Array(GROWABLE_HEAP_I8().buffer, ptr, count).slice();
      else if (kind === K.U16) value = new Uint16Array(GROWABLE_HEAP_U16().buffer, ptr, count).slice();
      else if (kind === K.S16) value = new Int16Array(GROWABLE_HEAP_I16().buffer, ptr, count).slice();
      else if (kind === K.U32) value = new Uint32Array(GROWABLE_HEAP_U32().buffer, ptr, count).slice();
      else if (kind === K.S32) value = new Int32Array(GROWABLE_HEAP_I32().buffer, ptr, count).slice();
      else if (kind === K.F32) value = new Float32Array(GROWABLE_HEAP_F32().buffer, ptr, count).slice();
      else if (kind === K.F64) value = new Float64Array(GROWABLE_HEAP_F64().buffer, ptr, count).slice();
      else if (kind === K.U64V)
        value = new BigUint64Array(GROWABLE_HEAP_U8().buffer, ptr, count).slice();
      else if (kind === K.S64)
        value = new BigInt64Array(GROWABLE_HEAP_U8().buffer, ptr, count).slice();
      else if (kind === K.C32)
        value = branded('c32', new Float32Array(GROWABLE_HEAP_F32().buffer, ptr, count * 2).slice());
      else if (kind === K.C64)
        value = branded('c64', new Float64Array(GROWABLE_HEAP_F64().buffer, ptr, count * 2).slice());
      else fail('unsupported uniform PMT kind ' + kind + ' (' + bytes + ' byte items)');
      return value;
    } finally { _free(meta); }
  }

  function fromPmt(handle, depth) {
    depth = depth || 0;
    if (depth > 64) fail('a PMT value is nested more than 64 levels deep');
    var kind = _gr_js_pmt_type(handle);
    if (kind < 0) shimFailure('PMT type read');
    if (kind === K.NIL) return null;
    if (kind === K.BOOL) return !!_gr_js_pmt_real(handle, 0);
    if (kind === K.SYMBOL) return pmtText(handle);
    if (kind === K.LONG) return _gr_js_pmt_real(handle, 0);
    if (kind === K.U64) {
      var uw = scalarWords(handle);
      return BigInt(uw[0] >>> 0) | (BigInt(uw[1] >>> 0) << 32n);
    }
    if (kind === K.REAL) {
      var real = _gr_js_pmt_real(handle, 0);
      return Number.isInteger(real) ? realValue(real) : real;
    }
    if (kind === K.COMPLEX)
      return complexValue(_gr_js_pmt_real(handle, 0), _gr_js_pmt_real(handle, 1));
    if (kind === K.PAIR)
      return pairValue(fromPmt(refHandle(handle, 0), depth + 1),
                       fromPmt(refHandle(handle, 1), depth + 1));
    var length = _gr_js_pmt_length(handle);
    if (length < 0) shimFailure('PMT length read');
    if (kind === K.VECTOR || kind === K.TUPLE) {
      var values = [];
      for (var i = 0; i < length; i++)
        values.push(fromPmt(refHandle(handle, kind === K.VECTOR ? 2 : 3, i), depth + 1));
      return kind === K.TUPLE ? tupleValue(values) : values;
    }
    if (kind === K.DICT) {
      var entries = [];
      for (var j = 0; j < length; j++)
        entries.push([fromPmt(refHandle(handle, 4, j), depth + 1),
                      fromPmt(refHandle(handle, 5, j), depth + 1)]);
      return dictValue(entries);
    }
    if (kind >= K.U8 && kind <= K.C64) return copiedUniform(handle, kind);
    fail('unsupported PMT type ' + kind + ' at the JavaScript boundary');
  }

  function kindOf(value) {
    if (value === null || value === undefined) return 'NIL';
    if (typeof value === 'boolean') return 'a bool';
    if (typeof value === 'string') return 'a symbol';
    if (typeof value === 'bigint') return 'a uint64';
    if (typeof value === 'number') return Number.isInteger(value) ? 'a long' : 'a real';
    if (Array.isArray(value)) return 'a vector';
    if (ArrayBuffer.isView(value)) return 'a uniform vector';
    var kind = value && value[BRAND];
    if (kind === 'pair') return 'a pair — take its value with pmt.cdr(msg)';
    return kind ? 'a ' + kind : typeof value;
  }

  function valueEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (a[BRAND] !== b[BRAND]) return false;
    if (a[BRAND] === 'real') return Object.is(a.value, b.value);
    if (a[BRAND] === 'complex') return Object.is(a.re, b.re) && Object.is(a.im, b.im);
    if (a[BRAND] === 'pair') return valueEqual(a.car, b.car) && valueEqual(a.cdr, b.cdr);
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b))
      return a.constructor === b.constructor && a.length === b.length &&
        Array.from(a).every(function (v, i) { return Object.is(v, b[i]); });
    return false;
  }
  function requirePair(value, name) {
    if (!value || value[BRAND] !== 'pair') fail('pmt.' + name + '() needs a pair');
    return value;
  }
  function requireDict(value, name) {
    if (value === null) return dictValue([]);
    if (value && Object.getPrototypeOf(value) === Object.prototype)
      return dictValue(Object.keys(value).map(function (key) { return [key, value[key]]; }));
    if (!value || value[BRAND] !== 'dict') fail('pmt.' + name + '() needs a dictionary');
    return value;
  }
  function copyToPython(value) {
    if (!value || typeof value !== 'object') return value;
    var kind = value[BRAND];
    if (kind === 'real') return value.value;
    if (kind === 'complex') return { re: value.re, im: value.im };
    if (kind === 'pair') return [copyToPython(value.car), copyToPython(value.cdr)];
    if (kind === 'tuple') return Array.from(value, copyToPython);
    if (kind === 'dict') {
      var symbolKeys = value.entries.every(function (e) { return typeof e[0] === 'string'; });
      if (symbolKeys) {
        var object = {};
        value.entries.forEach(function (e) { object[e[0]] = copyToPython(e[1]); });
        return object;
      }
      return new Map(value.entries.map(function (e) { return [copyToPython(e[0]), copyToPython(e[1])]; }));
    }
    if (ArrayBuffer.isView(value)) return value.slice();
    if (Array.isArray(value)) return value.map(copyToPython);
    return value;
  }

  var pmt = {
    PMT_NIL: null, PMT_T: true, PMT_F: false,
    intern: function (value) {
      if (typeof value !== 'string' || !value.length) fail('pmt.intern() needs a non-empty string');
      return value;
    },
    from_long: function (value) {
      value = Number(value);
      if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
        fail('pmt.from_long() needs an integer in the wasm32 long range');
      return value;
    },
    from_double: function (value) {
      value = Number(value); if (!Number.isFinite(value)) fail('pmt.from_double() needs a finite number');
      return realValue(value);
    },
    from_uint64: function (value) {
      var result = BigInt(value);
      if (result < 0n || result > U64_MAX) fail('pmt.from_uint64() needs a value in the uint64 range');
      return result;
    },
    from_bool: function (value) { return !!value; },
    from_complex: complexValue,
    // What a conversion actually received. A control block's message is very
    // often a (key . value) pair -- a QT GUI Message Edit Box in its default
    // pair mode sends one -- and "needs a PMT real or long" alone leaves the
    // author re-reading their handler rather than unwrapping the message.
    to_long: function (value) {
      if (!Number.isInteger(value) || (value && value[BRAND] === 'real'))
        fail('pmt.to_long() needs a PMT long, got ' + kindOf(value));
      return value;
    },
    to_uint64: function (value) {
      if (typeof value === 'bigint') return value;
      if (Number.isInteger(value) && value >= 0) return BigInt(value);
      fail('pmt.to_uint64() needs a PMT uint64 or non-negative long, got ' + kindOf(value));
    },
    to_double: function (value) {
      if (value && value[BRAND] === 'real') return value.value;
      if (typeof value === 'number') return value;
      fail('pmt.to_double() needs a PMT real or long, got ' + kindOf(value));
    },
    to_bool: function (value) { if (typeof value !== 'boolean') fail('pmt.to_bool() needs a bool'); return value; },
    to_python: copyToPython,
    cons: pairValue,
    car: function (value) { return requirePair(value, 'car').car; },
    cdr: function (value) { return requirePair(value, 'cdr').cdr; },
    is_pair: function (value) { return !!value && value[BRAND] === 'pair'; },
    list: function () {
      var result = null;
      for (var i = arguments.length - 1; i >= 0; --i) result = pairValue(arguments[i], result);
      return result;
    },
    make_dict: function () { return dictValue([]); },
    dict_add: function (dict, key, value) {
      var entries = requireDict(dict, 'dict_add').entries.filter(function (e) { return !valueEqual(e[0], key); });
      return dictValue([[key, value]].concat(entries));
    },
    dict_ref: function (dict, key, notFound) {
      var entry = requireDict(dict, 'dict_ref').entries.find(function (e) { return valueEqual(e[0], key); });
      return entry ? entry[1] : notFound;
    },
    dict_keys: function (dict) {
      return pmt.list.apply(null, requireDict(dict, 'dict_keys').entries.map(function (e) { return e[0]; }));
    },
    is_dict: function (value) { return value === null || (!!value &&
      (value[BRAND] === 'dict' || Object.getPrototypeOf(value) === Object.prototype)); },
    make_vector: function (count, fill) { return new Array(Number(count)).fill(fill); },
    make_tuple: function () { return tupleValue(Array.from(arguments)); },
    vector_ref: function (value, index) {
      if (!Array.isArray(value) || value[BRAND] === 'tuple') fail('pmt.vector_ref() needs a vector');
      return value[index];
    },
    tuple_ref: function (value, index) {
      if (!value || value[BRAND] !== 'tuple') fail('pmt.tuple_ref() needs a tuple');
      return value[index];
    },
    make_blob: function (value) { return branded('blob', new Uint8Array(value)); },
    // GNU Radio implements is_blob() as is_u8vector(); make_blob() retains a
    // private outbound brand, but an inbound native blob is necessarily just a
    // copied Uint8Array and must still satisfy the native predicate.
    is_blob: function (value) { return value instanceof Uint8Array; },
  };
  [
    ['u8', Uint8Array], ['s8', Int8Array], ['u16', Uint16Array], ['s16', Int16Array],
    ['u32', Uint32Array], ['s32', Int32Array], ['u64', typeof BigUint64Array === 'undefined' ? null : BigUint64Array],
    ['s64', typeof BigInt64Array === 'undefined' ? null : BigInt64Array],
    ['f32', Float32Array], ['f64', Float64Array],
  ].forEach(function (entry) {
    var name = entry[0], Constructor = entry[1];
    pmt['init_' + name + 'vector'] = function (count, values) {
      if (!Constructor) fail('pmt.init_' + name + 'vector() is unavailable in this browser');
      if (values === undefined) { values = count; count = values.length; }
      var result = new Constructor(values);
      if (result.length !== Number(count)) fail('pmt.init_' + name + 'vector() length mismatch');
      return result;
    };
    pmt[name + 'vector_elements'] = function (value) {
      if (!(value instanceof Constructor)) fail('pmt.' + name + 'vector_elements() got the wrong vector type');
      return value.slice();
    };
  });
  pmt.init_c32vector = function (count, values) {
    var result = branded('c32', new Float32Array(values));
    if (result.length !== Number(count) * 2) fail('pmt.init_c32vector() needs interleaved complex values');
    return result;
  };
  pmt.init_c64vector = function (count, values) {
    var result = branded('c64', new Float64Array(values));
    if (result.length !== Number(count) * 2) fail('pmt.init_c64vector() needs interleaved complex values');
    return result;
  };
  pmt.c32vector_elements = function (value) { return branded('c32', value.slice()); };
  pmt.c64vector_elements = function (value) { return branded('c64', value.slice()); };

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
      // A port *is* a dtype; it is not a description of one. {name, type} is
      // the shape an author reaches for first, and reporting that as "unknown
      // port type undefined" hides the mistake rather than naming it -- the
      // type is right there, under a key nothing reads. Say what the accepted
      // spellings are and what this object actually carried.
      if (typeof dtype !== 'string')
        fail(where + ": a port is a dtype string such as 'complex', or " +
             "{ dtype: 'complex', vlen: 1 }; this object has no dtype (its keys are " +
             (Object.keys(spec).join(', ') || 'none') +
             '). Stream ports are identified by position, not by a name.');
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

  function baseInfo(d) {
    if (!d || typeof d !== 'object') fail('gr.export() needs a descriptor object');
    var hasWork = typeof d.work === 'function';
    var hasGeneral = typeof d.generalWork === 'function';
    if (hasWork && hasGeneral)
      fail('a block defines work() or generalWork(), not both');

    var inputs = normalizePorts(d.inputs, 'inputs');
    var outputs = normalizePorts(d.outputs, 'outputs');

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

  function portSymbol(value, where) {
    if (typeof value !== 'string' || !value.length)
      fail(where + ' needs a non-empty PMT symbol');
    return value;
  }
  function positiveNumber(value, where) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) fail(where + ' must be a positive number');
    return number;
  }

  // Install the constructor-like declaration methods. They only record: the C++
  // constructor has already applied the factory pass before a live init runs.
  function bindDeclaration(self, info, handlers) {
    var ins = [], outs = [], handlerMap = new Map();
    var minima = new Array(info.outputs.length).fill(0);
    self.message_port_register_in = function (port) {
      port = portSymbol(port, 'message_port_register_in()');
      if (ins.indexOf(port) >= 0) fail('message_port_register_in(): duplicate port ' + port);
      ins.push(port);
    };
    self.message_port_register_out = function (port) {
      port = portSymbol(port, 'message_port_register_out()');
      if (outs.indexOf(port) >= 0) fail('message_port_register_out(): duplicate port ' + port);
      outs.push(port);
    };
    self.set_msg_handler = function (port, handler) {
      port = portSymbol(port, 'set_msg_handler()');
      if (ins.indexOf(port) < 0)
        fail('set_msg_handler(): ' + port + ' is not a registered input message port');
      if (typeof handler !== 'function') fail('set_msg_handler() needs a function');
      handlerMap.set(port, handler);
      if (handlers) handlers.set(port, handler);
    };
    self.set_tag_propagation_policy = function (policy) {
      policy = Number(policy);
      if (![0, 1, 2, 3].includes(policy))
        fail('set_tag_propagation_policy() accepts gr.TPP_DONT, TPP_ALL_TO_ALL, TPP_ONE_TO_ONE, or TPP_CUSTOM');
      info.tagPropagation = policy;
    };
    self.set_history = function (value) { info.history = positiveInt(value, 1, 'set_history()'); };
    self.set_output_multiple = function (value) {
      info.outputMultiple = positiveInt(value, 1, 'set_output_multiple()');
    };
    self.set_relative_rate = function (first, second) {
      info.relativeRate = second === undefined
        ? positiveNumber(first, 'set_relative_rate()')
        : positiveNumber(first, 'set_relative_rate() interpolation') /
          positiveNumber(second, 'set_relative_rate() decimation');
    };
    self.set_min_output_buffer = function (first, second) {
      if (!info.outputs.length) fail('set_min_output_buffer(): this block has no stream outputs');
      if (second === undefined) {
        var all = positiveInt(first, 1, 'set_min_output_buffer()');
        minima.fill(all);
        return;
      }
      var port = Math.trunc(Number(first));
      if (port < 0 || port >= info.outputs.length)
        fail('set_min_output_buffer(): no output port ' + port);
      minima[port] = positiveInt(second, 1, 'set_min_output_buffer()');
    };
    self.set_max_noutput_items = function (value) {
      info.maxNoutputItems = positiveInt(value, 1, 'set_max_noutput_items()');
    };
    return function finish() {
      if (ins.length) info.msgPortsIn = ins.slice();
      if (outs.length) info.msgPortsOut = outs.slice();
      var handlerPorts = ins.filter(function (port) { return handlerMap.has(port); });
      if (handlerPorts.length) info.msgHandlerPorts = handlerPorts;
      if (info.tagPropagation === 1) delete info.tagPropagation;
      if (minima.some(function (n) { return n > 0; })) info.minOutputBuffers = minima;
      else delete info.minOutputBuffers;
      if (!info.maxNoutputItems) delete info.maxNoutputItems;
      return info;
    };
  }

  function unavailableDuringDescriptor(name) {
    return function () { fail(name + ' is not available while the block\'s interface is being read'); };
  }

  function describeDescriptor(d) {
    var info = baseInfo(d);
    var self = Object.create(d);
    info.params.forEach(function (entry) { self[entry[0]] = entry[1]; });
    var finish = bindDeclaration(self, info, null);
    ['message_port_pub', 'add_item_tag', 'get_tags_in_window', 'get_tags_in_range',
     'nitems_read', 'nitems_written', 'consume'].forEach(function (name) {
      self[name] = unavailableDuringDescriptor(name + '()');
    });
    if (typeof d.init === 'function') d.init.call(self);
    finish();
    var hasMessages = (info.msgPortsIn && info.msgPortsIn.length) ||
                      (info.msgPortsOut && info.msgPortsOut.length);
    if (!info.general && typeof d.work !== 'function' && !hasMessages)
      // A descriptor is the block, not a description of where the block is.
      // The class form -- gr.export({ block: SomeClass }) -- reads as obvious
      // and is not part of the contract, and saying only that work() is missing
      // sends an author round the same attempt again.
      fail('the descriptor has no work() (or generalWork()) function: define ' +
           'work(nout, input, output) as a method on the object passed to ' +
           'gr.export(). There is no class or constructor form, and no key that ' +
           'names one. This descriptor carries: ' +
           (Object.keys(d).join(', ') || 'nothing'));
    if (!info.inputs.length && !info.outputs.length && !hasMessages)
      fail('a block needs at least one stream or message port');
    return info;
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
  function grSurface(exportFn) {
    return {
      export: exportFn,
      TPP_DONT: 0, TPP_ALL_TO_ALL: 1, TPP_ONE_TO_ONE: 2, TPP_CUSTOM: 3,
    };
  }

  function evaluateSource(source) {
    var descriptor = null;
    var gr = grSurface(function (d) {
        if (descriptor) fail('gr.export() was called more than once');
        if (!d) fail('gr.export() needs a descriptor object');
        descriptor = d;
      });
    var fn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function('gr', 'pmt', '"use strict";\n' + String(source));
    } catch (e) {
      var parseError = e && e.message ? e.message : String(e);
      // `gr` and `pmt` are this function's own parameters, so `const pmt = ...`
      // does not shadow them -- it fails to parse, with a message that says
      // nothing about where the other declaration came from.
      if (/Identifier '(gr|pmt)' has already been declared/.test(parseError))
        parseError += ' — gr and pmt are injected into every block source; ' +
                      'use them directly rather than declaring them';
      fail('the block source did not parse: ' + parseError);
    }
    fn(gr, pmt);
    if (!descriptor)
      fail('the block source never called gr.export({...}) — a JS block ' +
           'registers itself with exactly one such call');
    return descriptor;
  }

  function evaluate(source) {
    var descriptor = evaluateSource(source);
    return { descriptor: descriptor, info: describeDescriptor(descriptor) };
  }

  function declarationProjection(info) {
    var keys = ['inputs', 'outputs', 'decim', 'interp', 'history', 'outputMultiple',
      'relativeRate', 'msgPortsIn', 'msgPortsOut', 'msgHandlerPorts',
      'tagPropagation', 'minOutputBuffers', 'maxNoutputItems'];
    var result = {};
    keys.forEach(function (key) {
      if (info[key] !== undefined) result[key] = info[key];
    });
    return result;
  }

  function firstDeclarationDifference(expected, actual) {
    var a = declarationProjection(expected), b = declarationProjection(actual);
    var keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b))));
    for (var i = 0; i < keys.length; i++)
      if (JSON.stringify(a[keys[i]]) !== JSON.stringify(b[keys[i]])) return keys[i];
    return '';
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

  function safeJson(value) {
    return JSON.stringify(value, function (_key, item) {
      return typeof item === 'bigint' ? item.toString() + 'n' : item;
    });
  }

  function readNitems(block, written, port) {
    port = Math.trunc(Number(port));
    var count = written ? block.info.outputs.length : block.info.inputs.length;
    if (port < 0 || port >= count)
      fail((written ? 'nitems_written' : 'nitems_read') + '(): no ' +
           (written ? 'output' : 'input') + ' port ' + port);
    var wordsPtr = _malloc(8);
    try {
      if (_gr_js_nitems(block.handle, written ? 1 : 0, port, wordsPtr) < 0)
        shimFailure(written ? 'nitems_written()' : 'nitems_read()');
      var words = GROWABLE_HEAP_U32(), base = wordsPtr >> 2;
      return counterNumber(words[base], words[base + 1],
        (written ? 'nitems_written(' : 'nitems_read(') + port + ')');
    } finally { _free(wordsPtr); }
  }

  function queryTags(block, port, start, end, key) {
    port = Math.trunc(Number(port));
    if (port < 0 || port >= block.info.inputs.length)
      fail('get_tags_in_range(): no input port ' + port);
    var sw = u64Words(start, 'tag range start');
    var ew = u64Words(end, 'tag range end');
    var keyHandle = key === undefined ? -1 : toPmt(key);
    var count = _gr_js_tags(block.handle, port, sw[0], sw[1], ew[0], ew[1], keyHandle);
    if (count < 0) shimFailure('get_tags_in_range()');
    var offsetPtr = _malloc(8), result = [];
    try {
      for (var i = 0; i < count; i++) {
        if (_gr_js_tag_offset(block.handle, i, offsetPtr) < 0) shimFailure('tag offset read');
        var words = GROWABLE_HEAP_U32(), base = offsetPtr >> 2;
        result.push({
          offset: counterNumber(words[base], words[base + 1], 'tag offset'),
          key: fromPmt(checkedHandle('tag key read', _gr_js_tag_field(block.handle, i, 0))),
          value: fromPmt(checkedHandle('tag value read', _gr_js_tag_field(block.handle, i, 1))),
          srcid: fromPmt(checkedHandle('tag source id read', _gr_js_tag_field(block.handle, i, 2))),
        });
      }
      return result;
    } finally { _free(offsetPtr); }
  }

  function bindLiveApis(block) {
    var self = block.self;
    self.message_port_pub = function (port, message) {
      port = portSymbol(port, 'message_port_pub()');
      var index = (block.info.msgPortsOut || []).indexOf(port);
      if (index < 0) fail('message_port_pub(): ' + port + ' is not a registered output message port');
      if (_gr_js_publish(block.handle, index, toPmt(message)) < 0)
        shimFailure('message_port_pub(' + port + ')');
    };
    self.nitems_read = function (port) { return readNitems(block, false, port); };
    self.nitems_written = function (port) { return readNitems(block, true, port); };
    self.get_tags_in_range = function (port, start, end, key) {
      return queryTags(block, port, start, end, key);
    };
    self.get_tags_in_window = function (port, start, end, key) {
      var base = readNitems(block, false, port);
      return queryTags(block, port, base + Number(start), base + Number(end), key);
    };
    self.add_item_tag = function (port, offset, key, value, srcid) {
      port = Math.trunc(Number(port));
      if (port < 0 || port >= block.info.outputs.length)
        fail('add_item_tag(): no output port ' + port);
      var ow = u64Words(offset, 'tag offset');
      var keyHandle = toPmt(key), valueHandle = toPmt(value);
      var srcHandle = srcid === undefined ? -1 : toPmt(srcid);
      if (_gr_js_add_tag(block.handle, port, ow[0], ow[1], keyHandle, valueHandle, srcHandle) < 0)
        shimFailure('add_item_tag()');
    };
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
    compile: function (handle, srcPtr, paramsPtr, infoPtr, errPtr, errCap) {
      var phase = 'compile';
      try {
        var d = evaluateSource(UTF8ToString(srcPtr));
        var expectedText = infoPtr ? UTF8ToString(infoPtr) : '';
        var expected = expectedText ? JSON.parse(expectedText) : describeDescriptor(d);
        var info = baseInfo(d);
        var self = Object.create(d);
        info.params.forEach(function (entry) { self[entry[0]] = entry[1]; });
        var overridesText = paramsPtr ? UTF8ToString(paramsPtr) : '';
        var overrides = overridesText ? JSON.parse(overridesText) : {};
        Object.keys(overrides).forEach(function (name) { self[name] = overrides[name]; });
        var block = {
          handle: handle, d: d, info: info, self: self,
          // Recorded by this.consume() and applied by C++ when the call returns.
          // GR's own consume() only moves a read pointer nothing reads until
          // general_work() is done, so recording it is not a deferral of anything
          // observable -- it just keeps the JS side free of exported shims.
          consumed: null,
          handlers: new Map(),
        };
        var finishDeclaration = bindDeclaration(self, info, block.handlers);
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
                       : (value && typeof value === 'object') ? safeJson(value)
                       : String(value));
          }
          if (block.log.length < 64) block.log.push(parts.join(' '));
        };
        bindLiveApis(block);
        blocks.set(handle, block);
        if (typeof d.init === 'function') {
          phase = 'init';
          d.init.call(self);
        }
        finishDeclaration();
        var difference = firstDeclarationDifference(expected, info);
        if (difference)
          fail('init() declared a different ' + difference + ' on the live instance; ' +
               'ports and scheduler declarations cannot depend on parameter values');
        // The factory's normalized interface is authoritative for port indices.
        block.info = expected;
        if (typeof d.start === 'function') {
          phase = 'start';
          d.start.call(self);
        }
        return 0;
      } catch (e) {
        blocks.delete(handle);
        setError(errPtr, errCap, phaseError(phase, e));
        return -1;
      }
    },

    /** One registered input message handler, on the block's scheduler thread. */
    message: function (handle, portIndex, messageHandle, errPtr, errCap) {
      var block = blocks.get(handle);
      if (!block) { setError(errPtr, errCap, new Error('this block was never compiled')); return -1; }
      try {
        var ports = block.info.msgHandlerPorts || [];
        if (portIndex < 0 || portIndex >= ports.length)
          fail('no JavaScript handler at message port index ' + portIndex);
        var handler = block.handlers.get(ports[portIndex]);
        if (typeof handler !== 'function') fail('the handler for ' + ports[portIndex] + ' was not installed');
        handler.call(block.self, fromPmt(messageHandle));
        return 0;
      } catch (e) {
        setError(errPtr, errCap, phaseError('message', e));
        return -2;
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
