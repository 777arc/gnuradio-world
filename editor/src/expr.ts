// A small Python-expression subset evaluator for GRC block parameters.
//
// Native GRC evaluates every parameter string with Python at generate time to
// turn expressions (`samp_rate/2`, `2*pi*fc`, `[1,2,3]`, `firdes.low_pass(...)`)
// into concrete values. This module does the same job in the browser without
// Python: it models the Python value semantics that the stock example .grc
// files actually rely on — true/floor division, `**`, complex `j` literals,
// list literals + repetition, string concat — plus a math/numpy/firdes registry.
//
// It is intentionally a *subset*: things that need a real GNU Radio runtime
// object (constellation objects, uhd.tune_request, lambdas) are out of reach;
// callers fall back to showing the raw expression for those.

export type Value = number | Complex | string | boolean | Value[] | null;

export class Complex {
  constructor(public re: number, public im: number) {}
}

export interface EvalOk { ok: true; value: Value }
export interface EvalErr { ok: false; error: string }
export type EvalResult = EvalOk | EvalErr;

export type Scope = Record<string, Value>;

// ---------------------------------------------------------------- lexer ----

type Tok =
  | { t: 'num'; v: number }
  | { t: 'imag'; v: number }          // complex literal like 3j
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'eof' };

const OPS2 = ['**', '//', '==', '!=', '<=', '>=', '<<', '>>'];
const OPS1 = '+-*/%()[]{},:.<>|&^~';

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string) => c >= '0' && c <= '9';
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // number (int/float/scientific), optional trailing j for imaginary
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.') { j++; while (j < n && isDigit(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (isDigit(src[k])) { k++; while (k < n && isDigit(src[k])) k++; j = k; }
      }
      const text = src.slice(i, j);
      if (src[j] === 'j' || src[j] === 'J') { toks.push({ t: 'imag', v: parseFloat(text) }); i = j + 1; }
      else { toks.push({ t: 'num', v: parseFloat(text) }); i = j; }
      continue;
    }
    // string literal
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1; let s = '';
      while (j < n && src[j] !== q) {
        if (src[j] === '\\' && j + 1 < n) { s += src[j + 1]; j += 2; }
        else { s += src[j]; j++; }
      }
      toks.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    // identifier / keyword
    if (isIdStart(c)) {
      let j = i + 1; while (j < n && isId(src[j])) j++;
      toks.push({ t: 'name', v: src.slice(i, j) }); i = j; continue;
    }
    // multi-char operators first
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (OPS1.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected character '${c}'`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

// --------------------------------------------------------------- parser ----
// AST nodes are small tagged objects; evaluated directly against a scope.

type Node =
  | { k: 'num'; v: number }
  | { k: 'imag'; v: number }
  | { k: 'str'; v: string }
  | { k: 'name'; v: string }
  | { k: 'list'; items: Node[] }
  | { k: 'tuple'; items: Node[] }
  | { k: 'unary'; op: string; e: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'attr'; e: Node; name: string }
  | { k: 'call'; fn: Node; args: Node[] }
  | { k: 'index'; e: Node; idx: Node | null; slice?: { lo: Node | null; hi: Node | null } };

class Parser {
  toks: Tok[]; p = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  peek(): Tok { return this.toks[this.p]; }
  next(): Tok { return this.toks[this.p++]; }
  isOp(v: string): boolean { const t = this.peek(); return t.t === 'op' && t.v === v; }
  eat(v: string) { if (!this.isOp(v)) throw new Error(`expected '${v}'`); this.p++; }

  parse(): Node {
    const e = this.expr();
    if (this.peek().t !== 'eof') throw new Error('trailing tokens');
    return e;
  }

  // precedence climbing: | ^ & << >> + - * / // % ** unary postfix
  expr(): Node { return this.binary(0); }

  private static readonly LEVELS: string[][] = [
    ['|'], ['^'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '//', '%'],
  ];
  binary(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    while (this.peek().t === 'op' && Parser.LEVELS[level].includes((this.peek() as any).v)) {
      const op = (this.next() as any).v as string;
      const right = this.binary(level + 1);
      left = { k: 'bin', op, a: left, b: right };
    }
    return left;
  }
  unary(): Node {
    if (this.isOp('-') || this.isOp('+') || this.isOp('~')) {
      const op = (this.next() as any).v as string;
      return { k: 'unary', op, e: this.unary() };
    }
    return this.power();
  }
  power(): Node {
    const base = this.postfix();
    if (this.isOp('**')) { this.next(); const exp = this.unary(); return { k: 'bin', op: '**', a: base, b: exp }; }
    return base;
  }
  postfix(): Node {
    let e = this.atom();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const t = this.next();
        if (t.t !== 'name') throw new Error('expected attribute name');
        e = { k: 'attr', e, name: t.v };
      } else if (this.isOp('(')) {
        this.next();
        const args: Node[] = [];
        if (!this.isOp(')')) {
          args.push(this.expr());
          while (this.isOp(',')) { this.next(); if (this.isOp(')')) break; args.push(this.expr()); }
        }
        this.eat(')');
        e = { k: 'call', fn: e, args };
      } else if (this.isOp('[')) {
        this.next();
        // subscript: index or slice lo:hi
        let lo: Node | null = null, hi: Node | null = null, isSlice = false;
        if (!this.isOp(':')) lo = this.expr();
        if (this.isOp(':')) { isSlice = true; this.next(); if (!this.isOp(']')) hi = this.expr(); }
        this.eat(']');
        e = isSlice ? { k: 'index', e, idx: null, slice: { lo, hi } } : { k: 'index', e, idx: lo };
      } else break;
    }
    return e;
  }
  atom(): Node {
    const t = this.peek();
    if (t.t === 'num') { this.next(); return { k: 'num', v: t.v }; }
    if (t.t === 'imag') { this.next(); return { k: 'imag', v: t.v }; }
    if (t.t === 'str') { this.next(); return { k: 'str', v: t.v }; }
    if (t.t === 'name') { this.next(); return { k: 'name', v: t.v }; }
    if (this.isOp('(')) {
      this.next();
      if (this.isOp(')')) { this.next(); return { k: 'tuple', items: [] }; }
      const first = this.expr();
      if (this.isOp(',')) {
        const items = [first];
        while (this.isOp(',')) { this.next(); if (this.isOp(')')) break; items.push(this.expr()); }
        this.eat(')'); return { k: 'tuple', items };
      }
      this.eat(')'); return first;               // plain grouping
    }
    if (this.isOp('[')) {
      this.next();
      const items: Node[] = [];
      if (!this.isOp(']')) {
        items.push(this.expr());
        while (this.isOp(',')) { this.next(); if (this.isOp(']')) break; items.push(this.expr()); }
      }
      this.eat(']'); return { k: 'list', items };
    }
    throw new Error('unexpected token');
  }
}

// ------------------------------------------------------- value helpers ----

function toC(v: Value): Complex {
  if (v instanceof Complex) return v;
  if (typeof v === 'number') return new Complex(v, 0);
  if (typeof v === 'boolean') return new Complex(v ? 1 : 0, 0);
  throw new Error('not a number');
}
function numish(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Complex && v.im === 0) return v.re;
  throw new Error('expected a real number');
}
function simplifyC(c: Complex): Value { return c.im === 0 ? c.re : c; }

function add(a: Value, b: Value): Value {
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  if (a instanceof Complex || b instanceof Complex) { const x = toC(a), y = toC(b); return simplifyC(new Complex(x.re + y.re, x.im + y.im)); }
  return numish(a) + numish(b);
}
function sub(a: Value, b: Value): Value {
  if (a instanceof Complex || b instanceof Complex) { const x = toC(a), y = toC(b); return simplifyC(new Complex(x.re - y.re, x.im - y.im)); }
  return numish(a) - numish(b);
}
function mul(a: Value, b: Value): Value {
  // Python sequence repetition: int * list / list * int, int * str / str * int
  if (Array.isArray(a) && typeof b === 'number') return repeat(a, b);
  if (Array.isArray(b) && typeof a === 'number') return repeat(b, a);
  if (typeof a === 'string' && typeof b === 'number') return a.repeat(Math.max(0, Math.trunc(b)));
  if (typeof b === 'string' && typeof a === 'number') return b.repeat(Math.max(0, Math.trunc(a)));
  if (a instanceof Complex || b instanceof Complex) {
    const x = toC(a), y = toC(b);
    return simplifyC(new Complex(x.re * y.re - x.im * y.im, x.re * y.im + x.im * y.re));
  }
  return numish(a) * numish(b);
}
function repeat(arr: Value[], k: number): Value[] {
  const out: Value[] = []; const c = Math.max(0, Math.trunc(k));
  for (let i = 0; i < c; i++) out.push(...arr);
  return out;
}
function div(a: Value, b: Value): Value {
  if (a instanceof Complex || b instanceof Complex) {
    const x = toC(a), y = toC(b); const d = y.re * y.re + y.im * y.im;
    return simplifyC(new Complex((x.re * y.re + x.im * y.im) / d, (x.im * y.re - x.re * y.im) / d));
  }
  return numish(a) / numish(b);                 // Python 3 true division
}
function floordiv(a: Value, b: Value): Value { return Math.floor(numish(a) / numish(b)); }
function mod(a: Value, b: Value): Value { const x = numish(a), y = numish(b); return ((x % y) + y) % y; }
function pow(a: Value, b: Value): Value {
  if (a instanceof Complex || b instanceof Complex) return cpow(toC(a), toC(b));
  const x = numish(a), y = numish(b);
  if (x < 0 && !Number.isInteger(y)) return cpow(new Complex(x, 0), new Complex(y, 0)); // Python -> complex
  return Math.pow(x, y);
}
function cpow(a: Complex, b: Complex): Value {
  // exp(b * log a)
  const r = Math.hypot(a.re, a.im), theta = Math.atan2(a.im, a.re);
  const logRe = Math.log(r), logIm = theta;
  const re = b.re * logRe - b.im * logIm, im = b.re * logIm + b.im * logRe;
  const ex = Math.exp(re);
  return simplifyC(new Complex(ex * Math.cos(im), ex * Math.sin(im)));
}

// ------------------------------------------------------------ evaluator ----

class Evaluator {
  constructor(private scope: Scope) {}

  eval(n: Node): Value {
    switch (n.k) {
      case 'num': return n.v;
      case 'imag': return simplifyC(new Complex(0, n.v));
      case 'str': return n.v;
      case 'list': return n.items.map(e => this.eval(e));
      case 'tuple': return n.items.map(e => this.eval(e));   // tuples modeled as arrays
      case 'name': return this.name(n.v);
      case 'unary': {
        const v = this.eval(n.e);
        if (n.op === '+') return v;
        if (n.op === '~') return ~numish(v);
        if (v instanceof Complex) return new Complex(-v.re, -v.im);
        return -numish(v);
      }
      case 'bin': return this.bin(n.op, this.eval(n.a), this.eval(n.b));
      case 'attr': return this.attr(n);
      case 'index': return this.index(n);
      case 'call': return this.call(n);
    }
  }

  private bin(op: string, a: Value, b: Value): Value {
    switch (op) {
      case '+': return add(a, b);
      case '-': return sub(a, b);
      case '*': return mul(a, b);
      case '/': return div(a, b);
      case '//': return floordiv(a, b);
      case '%': return mod(a, b);
      case '**': return pow(a, b);
      case '<<': return numish(a) << numish(b);
      case '>>': return numish(a) >> numish(b);
      case '&': return numish(a) & numish(b);
      case '|': return numish(a) | numish(b);
      case '^': return numish(a) ^ numish(b);
    }
    throw new Error(`operator '${op}' unsupported`);
  }

  private name(id: string): Value {
    if (id in this.scope) return this.scope[id];
    if (id === 'True') return true;
    if (id === 'False') return false;
    if (id === 'None') return null;
    if (id === 'pi') return Math.PI;
    if (id === 'e') return Math.E;
    if (id in NAMESPACES || id in BUILTINS) return { __ns: id } as any; // resolved by attr/call
    throw new Error(`name '${id}' is not defined`);
  }

  private attr(n: Node & { k: 'attr' }): Value {
    // namespace constant/function access, e.g. math.pi, window.WIN_HANN
    const base = n.e;
    if (base.k === 'name' && base.v in NAMESPACES) {
      const ns = NAMESPACES[base.v];
      if (n.name in ns) return ns[n.name];
      return { __ns: base.v, __member: n.name } as any;   // a function, resolved by call()
    }
    // attribute on a value we don't model
    throw new Error(`attribute '${n.name}' unsupported`);
  }

  private index(n: Node & { k: 'index' }): Value {
    const target = this.eval(n.e);
    const seq = Array.isArray(target) ? target : typeof target === 'string' ? target.split('') : null;
    if (!seq) throw new Error('value is not subscriptable');
    const L = seq.length;
    const norm = (i: number) => (i < 0 ? i + L : i);
    if (n.slice) {
      const lo = n.slice.lo ? norm(numish(this.eval(n.slice.lo))) : 0;
      const hi = n.slice.hi ? norm(numish(this.eval(n.slice.hi))) : L;
      const part = seq.slice(Math.max(0, lo), Math.max(0, hi));
      return typeof target === 'string' ? (part as string[]).join('') : (part as Value[]);
    }
    const i = norm(numish(this.eval(n.idx!)));
    if (i < 0 || i >= L) throw new Error('index out of range');
    return seq[i];
  }

  private call(n: Node & { k: 'call' }): Value {
    const args = n.args.map(a => this.eval(a));
    // builtin: bare name
    if (n.fn.k === 'name' && n.fn.v in BUILTINS) return BUILTINS[n.fn.v](args);
    // namespaced: math.sqrt(...), firdes.low_pass(...)
    if (n.fn.k === 'attr' && n.fn.e.k === 'name') {
      const nsName = n.fn.e.v, member = n.fn.name;
      const ns = NS_FUNCS[nsName];
      if (ns && member in ns) return ns[member](args);
      throw new Error(`${nsName}.${member}() unsupported`);
    }
    throw new Error('call target unsupported');
  }
}

// --------------------------------------------------- registries / shims ----

// Namespace *constants* (attribute access without a call).
const NAMESPACES: Record<string, Record<string, Value>> = {
  math: { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, inf: Infinity },
  cmath: { pi: Math.PI, e: Math.E },
  numpy: { pi: Math.PI, e: Math.E, inf: Infinity },
  np: { pi: Math.PI, e: Math.E, inf: Infinity },
  // GNU Radio window ids (gr::fft::window::win_type).
  window: {
    WIN_NONE: -1, WIN_HAMMING: 0, WIN_HANN: 1, WIN_HANNING: 1, WIN_BLACKMAN: 2,
    WIN_RECTANGULAR: 3, WIN_KAISER: 4, WIN_BLACKMAN_hARRIS: 5, WIN_BLACKMAN_HARRIS: 5,
    WIN_BARTLETT: 6, WIN_FLATTOP: 7,
  },
  filter: {},
};

// A couple of common enum namespaces whose members we keep symbolic (they are
// enum-typed params, not numbers — callers usually don't evaluate them, but if
// one is referenced we return the dotted name so display stays meaningful).
for (const nsName of ['analog', 'digital', 'gr', 'qtgui', 'blocks', 'fft', 'trellis']) {
  NAMESPACES[nsName] = new Proxy({}, { has: () => true, get: (_t, k) => `${nsName}.${String(k)}` }) as any;
}

// Vector helpers.
const asVec = (v: Value): number[] => {
  if (Array.isArray(v)) return v.map(x => numish(x));
  return [numish(v)];
};

function elementwise(fn: (x: number) => number) {
  return (args: Value[]): Value => {
    const a = args[0];
    if (Array.isArray(a)) return a.map(x => fn(numish(x)));
    if (a instanceof Complex) throw new Error('complex not supported here');
    return fn(numish(a));
  };
}

const BUILTINS: Record<string, (args: Value[]) => Value> = {
  len: a => (Array.isArray(a[0]) ? a[0].length : typeof a[0] === 'string' ? (a[0] as string).length : (() => { throw new Error('len() of non-sequence'); })()),
  int: a => Math.trunc(numish(a[0])),
  float: a => numish(a[0]),
  bool: a => !!a[0] && a[0] !== 0,
  str: a => formatValue(a[0]),
  abs: a => (a[0] instanceof Complex ? Math.hypot(a[0].re, a[0].im) : Math.abs(numish(a[0]))),
  round: a => (a.length > 1 ? Number(numish(a[0]).toFixed(numish(a[1]))) : Math.round(numish(a[0]))),
  min: a => Math.min(...flat(a)),
  max: a => Math.max(...flat(a)),
  sum: a => flat(a).reduce((s, x) => s + x, 0),
  pow: a => pow(a[0], a[1]),
  complex: a => simplifyC(new Complex(numish(a[0] ?? 0), numish(a[1] ?? 0))),
  range: a => {
    let lo = 0, hi = 0, st = 1;
    if (a.length === 1) hi = numish(a[0]);
    else { lo = numish(a[0]); hi = numish(a[1]); if (a.length > 2) st = numish(a[2]); }
    const out: number[] = [];
    if (st > 0) for (let i = lo; i < hi; i += st) out.push(i);
    else for (let i = lo; i > hi; i += st) out.push(i);
    return out;
  },
  list: a => (Array.isArray(a[0]) ? a[0].slice() : typeof a[0] === 'string' ? (a[0] as string).split('') : [a[0]]),
};
function flat(args: Value[]): number[] {
  if (args.length === 1 && Array.isArray(args[0])) return asVec(args[0]);
  return args.map(x => numish(x));
}

// numpy shim (the array-returning members the examples use).
const npFuncs: Record<string, (args: Value[]) => Value> = {
  array: a => (Array.isArray(a[0]) ? a[0].slice() : [a[0]]),
  arange: a => {
    let lo = 0, hi = 0, st = 1;
    if (a.length === 1) hi = numish(a[0]);
    else { lo = numish(a[0]); hi = numish(a[1]); if (a.length > 2) st = numish(a[2]); }
    const out: number[] = [];
    if (st > 0) for (let x = lo; x < hi - 1e-12; x += st) out.push(x);
    else for (let x = lo; x > hi + 1e-12; x += st) out.push(x);
    return out;
  },
  linspace: a => {
    const lo = numish(a[0]), hi = numish(a[1]), num = a.length > 2 ? Math.trunc(numish(a[2])) : 50;
    if (num <= 1) return [lo];
    const out: number[] = []; const step = (hi - lo) / (num - 1);
    for (let i = 0; i < num; i++) out.push(lo + step * i); return out;
  },
  zeros: a => new Array(Math.trunc(numish(a[0]))).fill(0),
  ones: a => new Array(Math.trunc(numish(a[0]))).fill(1),
  sqrt: elementwise(Math.sqrt),
  exp: elementwise(Math.exp),
  log: elementwise(Math.log),
  log10: elementwise(Math.log10),
  log2: elementwise(Math.log2),
  sin: elementwise(Math.sin),
  cos: elementwise(Math.cos),
  tan: elementwise(Math.tan),
  square: elementwise(x => x * x),
  abs: a => (Array.isArray(a[0]) ? a[0].map(x => (x instanceof Complex ? Math.hypot(x.re, x.im) : Math.abs(numish(x)))) : a[0] instanceof Complex ? Math.hypot(a[0].re, a[0].im) : Math.abs(numish(a[0]))),
  float32: a => a[0],
  float64: a => a[0],
  real: a => (a[0] instanceof Complex ? a[0].re : numish(a[0])),
  imag: a => (a[0] instanceof Complex ? a[0].im : 0),
  conj: a => (Array.isArray(a[0]) ? a[0].map(x => (x instanceof Complex ? new Complex(x.re, -x.im) : x)) : a[0] instanceof Complex ? new Complex(a[0].re, -a[0].im) : a[0]),
  angle: a => (Array.isArray(a[0]) ? a[0].map(x => (x instanceof Complex ? Math.atan2(x.im, x.re) : (numish(x) < 0 ? Math.PI : 0))) : a[0] instanceof Complex ? Math.atan2(a[0].im, a[0].re) : (numish(a[0]) < 0 ? Math.PI : 0)),
  mean: a => { const v = asVec(a[0]); return v.reduce((s, x) => s + x, 0) / (v.length || 1); },
  sum: a => asVec(a[0]).reduce((s, x) => s + x, 0),
  dot: a => { const x = asVec(a[0]), y = asVec(a[1]); return x.reduce((s, xi, i) => s + xi * (y[i] ?? 0), 0); },
  pi: () => Math.PI,
};

// math module (scalar).
const mathFuncs: Record<string, (args: Value[]) => Value> = {
  sqrt: a => Math.sqrt(numish(a[0])),
  exp: a => Math.exp(numish(a[0])),
  log: a => (a.length > 1 ? Math.log(numish(a[0])) / Math.log(numish(a[1])) : Math.log(numish(a[0]))),
  log10: a => Math.log10(numish(a[0])),
  log2: a => Math.log2(numish(a[0])),
  pow: a => Math.pow(numish(a[0]), numish(a[1])),
  sin: a => Math.sin(numish(a[0])), cos: a => Math.cos(numish(a[0])), tan: a => Math.tan(numish(a[0])),
  asin: a => Math.asin(numish(a[0])), acos: a => Math.acos(numish(a[0])), atan: a => Math.atan(numish(a[0])),
  atan2: a => Math.atan2(numish(a[0]), numish(a[1])),
  sinh: a => Math.sinh(numish(a[0])), cosh: a => Math.cosh(numish(a[0])), tanh: a => Math.tanh(numish(a[0])),
  floor: a => Math.floor(numish(a[0])), ceil: a => Math.ceil(numish(a[0])),
  fabs: a => Math.abs(numish(a[0])), trunc: a => Math.trunc(numish(a[0])),
  factorial: a => { let f = 1; for (let i = 2; i <= numish(a[0]); i++) f *= i; return f; },
  gcd: a => { let x = Math.abs(numish(a[0])), y = Math.abs(numish(a[1])); while (y) { [x, y] = [y, x % y]; } return x; },
  radians: a => numish(a[0]) * Math.PI / 180, degrees: a => numish(a[0]) * 180 / Math.PI,
  hypot: a => Math.hypot(...a.map(numish)),
};

// firdes shim — the filter designers the examples use. Real GNU Radio computes
// these in C++ at generate time; these match the standard formulas closely
// enough for the editor's value preview (exact taps come from the C++ runner).
const firdesFuncs: Record<string, (args: Value[]) => Value> = {
  low_pass: a => lowPass(numish(a[0]), numish(a[1]), numish(a[2]), numish(a[3]), a.length > 4 ? numish(a[4]) : 0),
  low_pass_2: a => lowPass(numish(a[0]), numish(a[1]), numish(a[2]), numish(a[3]), a.length > 5 ? numish(a[5]) : 0),
  root_raised_cosine: a => rrc(numish(a[0]), numish(a[1]), numish(a[2]), numish(a[3]), Math.trunc(numish(a[4]))),
  window: a => windowFn(numish(a[0]), Math.trunc(numish(a[1]))),
};

function windowFn(type: number, ntaps: number): number[] {
  const w = new Array(Math.max(0, ntaps)).fill(0);
  const M = ntaps - 1;
  for (let n = 0; n < ntaps; n++) {
    switch (type) {
      case 1: w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / M); break;              // Hann
      case 0: w[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M); break;            // Hamming
      case 2: w[n] = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / M) + 0.08 * Math.cos((4 * Math.PI * n) / M); break; // Blackman
      case 3: w[n] = 1; break;                                                        // Rectangular
      default: w[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M);                  // fallback Hamming
    }
  }
  return w;
}
function lowPass(gain: number, fs: number, cutoff: number, transition: number, winType = 0): number[] {
  // ntaps from transition width (GR uses a window-dependent factor; ~4 for Hamming).
  const ntaps0 = Math.ceil((3.3 * fs) / transition);
  const ntaps = ntaps0 % 2 === 0 ? ntaps0 + 1 : ntaps0;
  const w = windowFn(winType, ntaps);
  const M = (ntaps - 1) / 2; const fwT0 = (2 * Math.PI * cutoff) / fs;
  const taps = new Array(ntaps).fill(0); let sum = 0;
  for (let n = 0; n < ntaps; n++) {
    const m = n - M;
    const h = m === 0 ? fwT0 / Math.PI : Math.sin(fwT0 * m) / (Math.PI * m);
    taps[n] = h * w[n]; sum += taps[n];
  }
  for (let n = 0; n < ntaps; n++) taps[n] = (taps[n] * gain) / sum;
  return taps;
}
function rrc(gain: number, fs: number, symRate: number, alpha: number, ntaps: number): number[] {
  const taps = new Array(ntaps).fill(0);
  const spb = fs / symRate;
  for (let i = 0; i < ntaps; i++) {
    const x1 = Math.PI * (i - ntaps / 2) / spb;
    let num: number, den: number;
    const x2 = (4 * alpha) / Math.PI * ((i - ntaps / 2) / spb);
    const x3 = x2 * x2 - 1;
    if (Math.abs(x3) >= 1e-9) {
      if (i !== Math.trunc(ntaps / 2)) num = Math.cos((1 + alpha) * x1) + Math.sin((1 - alpha) * x1) / (4 * alpha * (i - ntaps / 2) / spb);
      else num = Math.cos((1 + alpha) * x1) + (1 - alpha) * Math.PI / (4 * alpha);
      den = x3 * Math.PI;
    } else { // l'Hopital limit
      if (alpha === 1) { taps[i] = -1; continue; }
      const x = (1 + alpha) * x1, y = (1 - alpha) * x1;
      num = Math.cos(x) + Math.sin(y) / (4 * alpha * (i - ntaps / 2) / spb || 1);
      den = -2 * Math.PI * (i - ntaps / 2) / spb;
    }
    taps[i] = (4 * alpha * num) / den;
  }
  let s = 0; for (const t of taps) s += t * t;
  const norm = gain / Math.sqrt(s || 1);
  return taps.map(t => t * norm);
}

const NS_FUNCS: Record<string, Record<string, (args: Value[]) => Value>> = {
  math: mathFuncs, cmath: mathFuncs,
  numpy: npFuncs, np: npFuncs,
  firdes: firdesFuncs,
};

// ------------------------------------------------------------ public API ----

export function evaluate(src: string, scope: Scope = {}): EvalResult {
  try {
    const ast = new Parser(lex(src)).parse();
    const value = new Evaluator(scope).eval(ast);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Format a value for compact on-block display (mirrors GRC's short forms).
export function formatValue(v: Value): string {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return formatNumber(v);
  if (v instanceof Complex) {
    const re = formatNumber(v.re), sign = v.im < 0 ? '-' : '+';
    return `${re}${sign}${formatNumber(Math.abs(v.im))}j`;
  }
  if (Array.isArray(v)) {
    const MAX = 8;
    const parts = v.slice(0, MAX).map(formatValue);
    if (v.length > MAX) parts.push(`…(${v.length})`);
    return `[${parts.join(', ')}]`;
  }
  return String(v);
}
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : n < 0 ? '-inf' : 'nan';
  if (Number.isInteger(n)) return String(n);
  // trim long floats but keep meaningful precision (10 significant digits,
  // trailing zeros dropped) so results stay accurate without being unwieldy.
  return String(Number(n.toPrecision(10)));
}

// Serialize an evaluated value into a GRC-style parameter string for the runner
// (full precision, unlike the compact formatValue used on block faces). The
// result is re-parseable by the runner's numeric/vector coercion — e.g. a
// resolved firdes call becomes a concrete `[t0, t1, …]` taps literal.
export function serializeForRunner(v: Value, complexAsPair = false): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? 'inf' : '-inf';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v === null) return 'None';
  if (typeof v === 'string') return v;
  if (v instanceof Complex) {
    if (complexAsPair) return `[${String(v.re)}, ${String(v.im)}]`;
    const sign = v.im < 0 ? '-' : '+';
    return `${String(v.re)}${sign}${String(Math.abs(v.im))}j`;
  }
  if (Array.isArray(v))
    return `[${v.map(item => serializeForRunner(item, complexAsPair)).join(', ')}]`;
  return String(v);
}

// Build a variable scope from the flowgraph's variable blocks. `variable`
// blocks and the `variable_qtgui_*` controls both publish a value under their
// block name. Values may reference one another, so resolve to a fixpoint.
export interface VarBlock { id: string; name: string; params: Record<string, any> }
export function buildScope(blocks: VarBlock[]): Scope {
  const isVar = (b: VarBlock) => b.id === 'variable' || b.id.startsWith('variable_');
  const raw = new Map<string, string>();
  for (const b of blocks) {
    if (!isVar(b)) continue;
    const name = String(b.name || '').trim();
    if (!name) continue;
    raw.set(name, String(b.params?.value ?? '').trim());
  }
  const scope: Scope = {};
  // iterate to a fixpoint so variables can reference earlier/later ones
  for (let pass = 0; pass < raw.size + 1; pass++) {
    let progress = false;
    for (const [name, src] of raw) {
      if (name in scope || !src) continue;
      const r = evaluate(src, scope);
      if (r.ok) { scope[name] = r.value; progress = true; }
    }
    if (!progress) break;
  }
  return scope;
}
