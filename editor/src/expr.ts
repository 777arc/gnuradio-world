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

// A numpy array, as distinct from a Python list.
//
// The two disagree about arithmetic and the difference is not cosmetic:
// `numpy.array([1,2,3]) * 2` is [2,4,6] and `[1,2,3] * 2` is [1,2,3,1,2,3].
// Both spellings appear in taps parameters, and modelling numpy's as a plain
// list silently produced a vector of the wrong length *and* the wrong values.
// Subclassing Array keeps every Array.isArray() path in this file working.
export class NdArray extends Array<Value> {}
const nd = (items: Value[]): NdArray => NdArray.from(items) as NdArray;

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

const RADIX_PREFIXES: Record<string, number> = { x: 16, o: 8, b: 2 };

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
    // Python's non-decimal integer literals: 0x1f, 0o17, 0b1011. GRC reaches for
    // hex whenever a parameter is address- or mask-shaped -- gr-ieee802-11 writes
    // its MAC addresses as `[0x23, 0x23, ...]` -- so without these a block's own
    // default expression would not evaluate. A prefix with no digits after it
    // falls through to the decimal path and fails there, as it does in Python.
    if (c === '0' && RADIX_PREFIXES[src[i + 1]?.toLowerCase()]) {
      const radix = RADIX_PREFIXES[src[i + 1].toLowerCase()];
      let j = i + 2;
      while (j < n && parseInt(src[j], radix) >= 0) j++;
      if (j > i + 2) {
        toks.push({ t: 'num', v: parseInt(src.slice(i + 2, j), radix) });
        i = j;
        continue;
      }
    }
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
    // string literal. Python's escape sequences are decoded rather than having
    // the backslash dropped: `"\\n"` is a newline, not the letter n. A GRC
    // parameter that carries a delimiter or a separator says so this way, and
    // handing the runner a literal 'n' is a wrong value it cannot detect.
    // An unrecognised escape keeps the character, as Python does.
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1; let s = '';
      while (j < n && src[j] !== q) {
        if (src[j] !== '\\' || j + 1 >= n) { s += src[j]; j++; continue; }
        const e = src[j + 1];
        j += 2;
        if (e === 'n') s += '\n';
        else if (e === 't') s += '\t';
        else if (e === 'r') s += '\r';
        else if (e === '0') s += '\0';
        else if (e === 'a') s += '\x07';
        else if (e === 'b') s += '\b';
        else if (e === 'f') s += '\f';
        else if (e === 'v') s += '\v';
        else if (e === '\n') { /* a line continuation contributes nothing */ }
        else if (e === 'x' || e === 'u' || e === 'U') {
          const width = e === 'x' ? 2 : e === 'u' ? 4 : 8;
          const digits = src.slice(j, j + width);
          const code = /^[0-9a-fA-F]+$/.test(digits) && digits.length === width
            ? parseInt(digits, 16) : NaN;
          // Python raises on a malformed \x/\u; keeping the raw text is the
          // gentler answer for a parameter that is only being previewed.
          if (Number.isNaN(code) || code > 0x10ffff) s += '\\' + e;
          else { s += String.fromCodePoint(code); j += width; }
        }
        else s += e;
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
// numish() plus Python's string conversions ('1.5', 'inf', '-inf', 'nan'), for
// the builtins that accept one.
function numeric(v: Value): number {
  if (typeof v !== 'string') return numish(v);
  const text = v.trim();
  // Python spells the non-finite literals `inf`/`-inf`/`nan`; JS wants `Infinity`.
  const value = text ? Number(text.replace(/^([+-]?)inf(inity)?$/i, '$1Infinity')) : NaN;
  if (Number.isNaN(value) && !/^nan$/i.test(text))
    throw new Error(`could not convert string to float: '${v}'`);
  return value;
}
function simplifyC(c: Complex): Value { return c.im === 0 ? c.re : c; }

// ---- bitwise operands, in Python's integer semantics ----
// BigInt rather than JS's implicit int32 coercion. The result comes back as a
// Number, so a value past 2^53 loses precision -- which every other number in
// this evaluator does too, and which is a far narrower failure than wrapping
// every mask into 32 signed bits.
function toBits(v: Value, op: string): bigint {
  const x = numish(v);
  if (!Number.isInteger(x))
    throw new Error(`unsupported operand type for ${op}: a float has no bits`);
  return BigInt(x);
}
const fromBits = (v: bigint): number => Number(v);
function bitwise(a: Value, b: Value, op: string,
                 apply: (x: bigint, y: bigint) => bigint): Value {
  if (anyNd(a, b)) return broadcast((x, y) => bitwise(x, y, op, apply), a, b);
  return fromBits(apply(toBits(a, op), toBits(b, op)));
}
function shifted(a: Value, b: Value, op: string): Value {
  if (anyNd(a, b)) return broadcast((x, y) => shifted(x, y, op), a, b);
  const count = toBits(b, op);
  if (count < 0n) throw new Error('negative shift count');
  return fromBits(op === '<<' ? toBits(a, op) << count : toBits(a, op) >> count);
}

// numpy broadcasting for the one shape this evaluator models: a 1-D array
// against a scalar, or against another sequence of the same length. Entered
// only when at least one side is an NdArray, so `op` re-enters on scalars and
// takes its ordinary path.
function broadcast(op: (x: Value, y: Value) => Value, a: Value, b: Value): Value {
  const av = Array.isArray(a) ? a : null;
  const bv = Array.isArray(b) ? b : null;
  if (av && bv) {
    if (av.length !== bv.length)
      throw new Error(`operands could not be broadcast together with shapes ` +
        `(${av.length},) (${bv.length},)`);
    return nd(av.map((x, i) => op(x, bv[i])));
  }
  if (av) return nd(av.map(x => op(x, b)));
  return nd((bv as Value[]).map(y => op(a, y)));
}
const anyNd = (a: Value, b: Value) => a instanceof NdArray || b instanceof NdArray;

function add(a: Value, b: Value): Value {
  if (anyNd(a, b)) return broadcast(add, a, b);
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  if (a instanceof Complex || b instanceof Complex) { const x = toC(a), y = toC(b); return simplifyC(new Complex(x.re + y.re, x.im + y.im)); }
  return numish(a) + numish(b);
}
function sub(a: Value, b: Value): Value {
  if (anyNd(a, b)) return broadcast(sub, a, b);
  if (a instanceof Complex || b instanceof Complex) { const x = toC(a), y = toC(b); return simplifyC(new Complex(x.re - y.re, x.im - y.im)); }
  return numish(a) - numish(b);
}
function mul(a: Value, b: Value): Value {
  // A numpy array multiplies elementwise; only a *list* repeats.
  if (anyNd(a, b)) return broadcast(mul, a, b);
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
  if (anyNd(a, b)) return broadcast(div, a, b);
  if (a instanceof Complex || b instanceof Complex) {
    const x = toC(a), y = toC(b); const d = y.re * y.re + y.im * y.im;
    return simplifyC(new Complex((x.re * y.re + x.im * y.im) / d, (x.im * y.re - x.re * y.im) / d));
  }
  return numish(a) / numish(b);                 // Python 3 true division
}
function floordiv(a: Value, b: Value): Value {
  if (anyNd(a, b)) return broadcast(floordiv, a, b);
  return Math.floor(numish(a) / numish(b));
}
function mod(a: Value, b: Value): Value {
  if (anyNd(a, b)) return broadcast(mod, a, b);
  const x = numish(a), y = numish(b); return ((x % y) + y) % y;
}
function pow(a: Value, b: Value): Value {
  if (anyNd(a, b)) return broadcast(pow, a, b);
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
        if (n.op === '~') return fromBits(~toBits(v, '~'));
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
      // Python's bitwise operators are integer-only and arbitrary-precision;
      // JavaScript's coerce to *signed 32 bits*, which made
      // `0xffffffff & 0xdeadbeef` negative and `1 << 40` come out as 256.
      // A parameter written as a mask is exactly where GRC reaches for hex.
      case '<<': return shifted(a, b, '<<');
      case '>>': return shifted(a, b, '>>');
      case '&': return bitwise(a, b, '&', (x, y) => x & y);
      case '|': return bitwise(a, b, '|', (x, y) => x | y);
      case '^': return bitwise(a, b, '^', (x, y) => x ^ y);
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
  // GNU Radio window ids, the complete gr::fft::window::win_type enum
  // (gr-fft/include/gnuradio/fft/window.h). All of them, because windowBuild()
  // below implements all of them: a constant this table is missing evaluates to
  // "not defined" and a window windowBuild() is missing would silently design
  // somebody else's filter.
  window: {
    WIN_NONE: -1, WIN_HAMMING: 0, WIN_HANN: 1, WIN_HANNING: 1, WIN_BLACKMAN: 2,
    WIN_RECTANGULAR: 3, WIN_KAISER: 4, WIN_BLACKMAN_hARRIS: 5, WIN_BLACKMAN_HARRIS: 5,
    WIN_BARTLETT: 6, WIN_FLATTOP: 7, WIN_NUTTALL: 8, WIN_BLACKMAN_NUTTALL: 8,
    WIN_NUTTALL_CFD: 9, WIN_WELCH: 10, WIN_PARZEN: 11, WIN_EXPONENTIAL: 12,
    WIN_RIEMANN: 13, WIN_GAUSSIAN: 14, WIN_TUKEY: 15,
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
    if (Array.isArray(a)) return nd(a.map(x => fn(numish(x))));
    if (a instanceof Complex) throw new Error('complex not supported here');
    return fn(numish(a));
  };
}

const BUILTINS: Record<string, (args: Value[]) => Value> = {
  len: a => (Array.isArray(a[0]) ? a[0].length : typeof a[0] === 'string' ? (a[0] as string).length : (() => { throw new Error('len() of non-sequence'); })()),
  int: a => Math.trunc(numeric(a[0])),
  // Python's float() parses a string too, which is the only way to write an
  // infinity as a literal: GRC's QT GUI Numeric Entry defaults its Maximum value
  // to `float("inf")`, and a parameter that does not evaluate blocks the Run
  // button rather than reaching the runner.
  float: a => numeric(a[0]),
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

// numpy shim (the array-returning members the examples use). Everything here
// that yields a sequence yields an NdArray, so the result keeps numpy's
// elementwise arithmetic instead of degrading into a Python list.
const npFuncs: Record<string, (args: Value[]) => Value> = {
  array: a => (Array.isArray(a[0]) ? nd(a[0].slice()) : nd([a[0]])),
  arange: a => {
    let lo = 0, hi = 0, st = 1;
    if (a.length === 1) hi = numish(a[0]);
    else { lo = numish(a[0]); hi = numish(a[1]); if (a.length > 2) st = numish(a[2]); }
    const out: number[] = [];
    if (st > 0) for (let x = lo; x < hi - 1e-12; x += st) out.push(x);
    else for (let x = lo; x > hi + 1e-12; x += st) out.push(x);
    return nd(out);
  },
  linspace: a => {
    const lo = numish(a[0]), hi = numish(a[1]), num = a.length > 2 ? Math.trunc(numish(a[2])) : 50;
    if (num <= 1) return nd([lo]);
    const out: number[] = []; const step = (hi - lo) / (num - 1);
    for (let i = 0; i < num; i++) out.push(lo + step * i); return nd(out);
  },
  zeros: a => nd(new Array(Math.trunc(numish(a[0]))).fill(0)),
  ones: a => nd(new Array(Math.trunc(numish(a[0]))).fill(1)),
  sqrt: elementwise(Math.sqrt),
  exp: elementwise(Math.exp),
  log: elementwise(Math.log),
  log10: elementwise(Math.log10),
  log2: elementwise(Math.log2),
  sin: elementwise(Math.sin),
  cos: elementwise(Math.cos),
  tan: elementwise(Math.tan),
  square: elementwise(x => x * x),
  abs: a => (Array.isArray(a[0]) ? nd(a[0].map(x => (x instanceof Complex ? Math.hypot(x.re, x.im) : Math.abs(numish(x))))) : a[0] instanceof Complex ? Math.hypot(a[0].re, a[0].im) : Math.abs(numish(a[0]))),
  float32: a => (Array.isArray(a[0]) ? nd(a[0].slice()) : a[0]),
  float64: a => (Array.isArray(a[0]) ? nd(a[0].slice()) : a[0]),
  real: a => (Array.isArray(a[0]) ? nd(a[0].map(x => (x instanceof Complex ? x.re : numish(x)))) : a[0] instanceof Complex ? a[0].re : numish(a[0])),
  imag: a => (Array.isArray(a[0]) ? nd(a[0].map(x => (x instanceof Complex ? x.im : 0))) : a[0] instanceof Complex ? a[0].im : 0),
  conj: a => (Array.isArray(a[0]) ? nd(a[0].map(x => (x instanceof Complex ? new Complex(x.re, -x.im) : x))) : a[0] instanceof Complex ? new Complex(a[0].re, -a[0].im) : a[0]),
  angle: a => (Array.isArray(a[0]) ? nd(a[0].map(x => (x instanceof Complex ? Math.atan2(x.im, x.re) : (numish(x) < 0 ? Math.PI : 0)))) : a[0] instanceof Complex ? Math.atan2(a[0].im, a[0].re) : (numish(a[0]) < 0 ? Math.PI : 0)),
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

// firdes shim — the filter designers the examples use. These are not merely a
// preview: `resolveParamsForRun` evaluates every expression here and ships the
// resulting tap list to the runner, which cannot evaluate Python itself. So a
// formula that is only approximately right produces a filter that is actually
// wrong in the running flowgraph — and the same flowgraph can hold a Low Pass
// Filter block, whose taps the *runner* designs with the real
// gr::filter::firdes, so an approximation here makes two blocks given identical
// arguments disagree. Port gr-filter/lib/firdes.cc and gr-fft/lib/window.cc
// faithfully; nothing below is allowed to be "close enough".
const WIN_HAMMING = 0;
// firdes.h's default for the Kaiser/Exponential/Gaussian/Tukey parameter.
const DEFAULT_WIN_PARAM = 6.76;
// window.h's INVALID_WIN_PARAM: what firdes::window() passes when the caller
// gave no parameter, and what makes a window that needs one throw.
const INVALID_WIN_PARAM = -1;

const firdesFuncs: Record<string, (args: Value[]) => Value> = {
  low_pass: a => firdesLowPass(
    numish(a[0]), numish(a[1]), numish(a[2]), numish(a[3]),
    a.length > 4 ? numish(a[4]) : WIN_HAMMING,
    a.length > 5 ? numish(a[5]) : DEFAULT_WIN_PARAM),
  // low_pass_2's fifth argument is the required stopband attenuation, which is
  // what sets its tap count; the window is the *sixth*. Reading the window out
  // of the fifth position (as this did) both ignored the attenuation and
  // designed with whatever window id the attenuation happened to collide with.
  low_pass_2: a => firdesLowPass2(
    numish(a[0]), numish(a[1]), numish(a[2]), numish(a[3]), numish(a[4]),
    a.length > 5 ? numish(a[5]) : WIN_HAMMING,
    a.length > 6 ? numish(a[6]) : DEFAULT_WIN_PARAM),
  root_raised_cosine: a => rrc(numish(a[0]), numish(a[1]), numish(a[2]), numish(a[3]), Math.trunc(numish(a[4]))),
  window: a => windowBuild(
    numish(a[0]), Math.trunc(numish(a[1])),
    a.length > 2 ? numish(a[2]) : INVALID_WIN_PARAM),
};

// ---- gr-fft/lib/window.cc -------------------------------------------------
// Every branch of window::build(), because low_pass()'s tap *count* is a
// function of the window type (through max_attenuation) and its shape is a
// function of the window itself. Falling back to Hamming for a window that is
// not implemented — which is what this file used to do for Kaiser,
// Blackman-Harris, Bartlett and Flattop — designs a different filter than GNU
// Radio does, without a word. An unimplemented id throws instead, exactly as
// window::build()'s `default:` does.

// window::Izero — modified Bessel function of the first kind, order 0.
function izero(x: number): number {
  const EPSILON = 1e-21;
  let sum = 1, u = 1, n = 1;
  const halfx = x / 2;
  do {
    let temp = halfx / n;
    n += 1;
    temp *= temp;
    u *= temp;
    sum += u;
  } while (u >= EPSILON * sum);
  return sum;
}

const midn = (ntaps: number) => ntaps / 2;
const midm1 = (ntaps: number) => (ntaps - 1) / 2;
const midp1 = (ntaps: number) => (ntaps + 1) / 2;
const winFreq = (ntaps: number) => (2 * Math.PI) / ntaps;

// window::coswindow, whose 3-, 4- and 5-coefficient overloads are one series
// with alternating signs: c0 - c1 cos(x) + c2 cos(2x) - c3 cos(3x) + c4 cos(4x).
function coswindow(ntaps: number, c: number[]): number[] {
  const taps = new Array<number>(ntaps).fill(0);
  const M = ntaps - 1;
  for (let n = 0; n < ntaps; n++) {
    const x = (2 * Math.PI * n) / M;
    let value = c[0];
    for (let k = 1; k < c.length; k++)
      value += (k % 2 ? -1 : 1) * c[k] * Math.cos(k * x);
    taps[n] = value;
  }
  return taps;
}

function rectangularWindow(ntaps: number): number[] {
  return new Array<number>(ntaps).fill(1);
}
function hammingWindow(ntaps: number): number[] {
  const taps = new Array<number>(ntaps).fill(0);
  const M = ntaps - 1;
  for (let n = 0; n < ntaps; n++) taps[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M);
  return taps;
}
function hannWindow(ntaps: number): number[] {
  const taps = new Array<number>(ntaps).fill(0);
  const M = ntaps - 1;
  for (let n = 0; n < ntaps; n++) taps[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / M);
  return taps;
}
function blackmanHarrisWindow(ntaps: number, atten = 92): number[] {
  switch (atten) {
    case 61: return coswindow(ntaps, [0.42323, 0.49755, 0.07922]);
    case 67: return coswindow(ntaps, [0.44959, 0.49364, 0.05677]);
    case 74: return coswindow(ntaps, [0.40271, 0.49703, 0.09392, 0.00183]);
    case 92: return coswindow(ntaps, [0.35875, 0.48829, 0.14128, 0.01168]);
  }
  throw new Error('window::blackman_harris: unknown attenuation value (must be 61, 67, 74, or 92)');
}
function kaiserWindow(ntaps: number, beta: number): number[] {
  if (beta < 0) throw new Error('window::kaiser: beta must be >= 0');
  const taps = new Array<number>(ntaps).fill(0);
  const ibeta = 1 / izero(beta);
  const inm1 = 1 / (ntaps - 1);
  // First and last are lifted out of the loop upstream too: sqrt(1 - t*t) with
  // |t| = 1 + epsilon is the floating-point hazard that gnuradio#1348 was about.
  taps[0] = ibeta;
  for (let i = 1; i < ntaps - 1; i++) {
    const temp = 2 * i * inm1 - 1;
    taps[i] = izero(beta * Math.sqrt(1 - temp * temp)) * ibeta;
  }
  taps[ntaps - 1] = ibeta;
  return taps;
}
function bartlettWindow(ntaps: number): number[] {
  const taps = new Array<number>(ntaps).fill(0);
  const M = ntaps - 1;
  const half = Math.trunc(ntaps / 2);
  for (let n = 0; n < half; n++) taps[n] = (2 * n) / M;
  for (let n = half; n < ntaps; n++) taps[n] = 2 - (2 * n) / M;
  return taps;
}
function flattopWindow(ntaps: number): number[] {
  const scale = 4.63867;
  return coswindow(ntaps,
    [1.0 / scale, 1.93 / scale, 1.29 / scale, 0.388 / scale, 0.028 / scale]);
}
function welchWindow(ntaps: number): number[] {
  const taps = new Array<number>(ntaps).fill(0);
  const m1 = midm1(ntaps), p1 = midp1(ntaps);
  for (let i = 0; i < midn(ntaps) + 1; i++) {
    taps[i] = 1.0 - Math.pow((i - m1) / p1, 2);
    taps[ntaps - i - 1] = taps[i];
  }
  return taps;
}
function parzenWindow(ntaps: number): number[] {
  const taps = new Array<number>(ntaps).fill(0);
  const m1 = midm1(ntaps), m = midn(ntaps);
  let i = Math.trunc(ntaps / 4);
  for (; i < Math.trunc((3 * ntaps) / 4); i++)
    taps[i] = 1.0 - 6.0 * Math.pow((i - m1) / m, 2.0) * (1.0 - Math.abs(i - m1) / m);
  for (; i < ntaps; i++) {
    taps[i] = 2.0 * Math.pow(1.0 - Math.abs(i - m1) / m, 3.0);
    taps[ntaps - i - 1] = taps[i];
  }
  return taps;
}
function exponentialWindow(ntaps: number, d: number): number[] {
  if (d < 0) throw new Error('window::exponential: d must be >= 0');
  const m1 = midm1(ntaps);
  const p = 1.0 / ((8.69 * ntaps) / (2.0 * d));
  const taps = new Array<number>(ntaps).fill(0);
  for (let i = 0; i < midn(ntaps) + 1; i++) {
    taps[i] = Math.exp(-Math.abs(i - m1) * p);
    taps[ntaps - i - 1] = taps[i];
  }
  return taps;
}
function riemannWindow(ntaps: number): number[] {
  const sr1 = winFreq(ntaps);
  const mid = midn(ntaps);
  const taps = new Array<number>(ntaps).fill(0);
  for (let i = 0; i < mid; i++) {
    if (i === midn(ntaps)) {
      taps[i] = 1.0;
      taps[ntaps - i - 1] = 1.0;
    } else {
      const cx = sr1 * (i - mid);
      taps[i] = Math.sin(cx) / cx;
      taps[ntaps - i - 1] = Math.sin(cx) / cx;
    }
  }
  return taps;
}
function tukeyWindow(ntaps: number, alpha: number): number[] {
  if (alpha < 0 || alpha > 1) throw new Error('window::tukey: alpha must be between 0 and 1');
  const N = ntaps - 1;
  const aN = alpha * N;
  const p1 = aN / 2.0;
  const mid = midn(ntaps);
  const taps = new Array<number>(ntaps).fill(0);
  for (let i = 0; i < mid; i++) {
    if (Math.abs(i) < p1) {
      taps[i] = 0.5 * (1.0 - Math.cos((2 * Math.PI * i) / aN));
      taps[ntaps - 1 - i] = taps[i];
    } else {
      taps[i] = 1.0;
      taps[ntaps - i - 1] = 1.0;
    }
  }
  return taps;
}
function gaussianWindow(ntaps: number, sigma: number): number[] {
  if (sigma <= 0) throw new Error('window::gaussian: sigma must be > 0');
  const a = 2 * sigma * sigma;
  const m1 = midm1(ntaps);
  const taps = new Array<number>(ntaps).fill(0);
  for (let i = 0; i < midn(ntaps); i++) {
    const N = i - m1;
    taps[i] = Math.exp(-((N * N) / a));
    taps[ntaps - 1 - i] = taps[i];
  }
  return taps;
}

// window::build(type, ntaps, param) with normalize=false, which is the default
// and what firdes::window() asks for.
function windowBuild(type: number, ntaps: number, param = INVALID_WIN_PARAM): number[] {
  if (!Number.isFinite(ntaps) || ntaps < 1)
    throw new Error('window::build: ntaps must be a positive integer');
  switch (type) {
    case 3: return rectangularWindow(ntaps);              // WIN_RECTANGULAR
    case 0: return hammingWindow(ntaps);                  // WIN_HAMMING
    case 1: return hannWindow(ntaps);                     // WIN_HANN / WIN_HANNING
    case 2: return coswindow(ntaps, [0.42, 0.5, 0.08]);   // WIN_BLACKMAN
    case 5: return blackmanHarrisWindow(ntaps);           // WIN_BLACKMAN_hARRIS
    case 4: return kaiserWindow(ntaps, param);            // WIN_KAISER
    case 6: return bartlettWindow(ntaps);                 // WIN_BARTLETT
    case 7: return flattopWindow(ntaps);                  // WIN_FLATTOP
    case 8:                                               // WIN_NUTTALL
      return coswindow(ntaps, [0.3635819, 0.4891775, 0.1365995, 0.0106411]);
    case 9:                                               // WIN_NUTTALL_CFD
      return coswindow(ntaps, [0.355768, 0.487396, 0.144232, 0.012604]);
    case 10: return welchWindow(ntaps);                   // WIN_WELCH
    case 11: return parzenWindow(ntaps);                  // WIN_PARZEN
    case 12: return exponentialWindow(ntaps, param);      // WIN_EXPONENTIAL
    case 13: return riemannWindow(ntaps);                 // WIN_RIEMANN
    case 14: return gaussianWindow(ntaps, param);         // WIN_GAUSSIAN
    case 15: return tukeyWindow(ntaps, param);            // WIN_TUKEY
  }
  throw new Error('window::build: type out of range');
}

// window::max_attenuation — the dB figure that, through compute_ntaps below,
// decides how many taps a window-method filter gets.
function maxAttenuation(type: number, param: number): number {
  switch (type) {
    case 0: return 53;     // Hamming
    case 1: return 44;     // Hann
    case 2: return 74;     // Blackman
    case 3: return 21;     // Rectangular
    case 4: return param / 0.1102 + 8.7;   // Kaiser, linear approximation
    case 5: return 92;     // Blackman-Harris
    case 6: return 27;     // Bartlett
    case 7: return 93;     // Flattop
    case 8: return 114;    // Nuttall
    case 9: return 112;    // Nuttall CFD
    case 10: return 31;    // Welch
    case 11: return 56;    // Parzen
    case 12: return 26;    // Exponential
    case 13: return 39;    // Riemann
    case 14: return 100;   // Gaussian, not meaningful but has to be something
    case 15:               // Tukey, piecewise linear fit
      if (param > 0.9) return (param - 0.9) * 135 + 30.5;
      if (param > 0.7) return (param - 0.6) * 20 + 24;
      return param * 5 + 21;
  }
  throw new Error('window::max_attenuation: unknown window type provided.');
}

// ---- gr-filter/lib/firdes.cc ----------------------------------------------

// (int) truncates toward zero, then an even count is made odd. Both matter:
// ceil() instead of trunc() shifts every filter by two taps.
const oddTaps = (n: number) => (Math.trunc(n) % 2 === 0 ? Math.trunc(n) + 1 : Math.trunc(n));

// firdes::compute_ntaps. The 22.0 and the window's own max_attenuation are the
// whole formula (Herrmann/harris); there is no window-independent constant that
// approximates it, which is what the 3.3 here used to assume.
function computeNtaps(fs: number, transition: number, winType: number, param: number): number {
  return oddTaps((maxAttenuation(winType, param) * fs) / (22.0 * transition));
}
// firdes::compute_ntaps_windes — the same, from a stopband attenuation the
// caller states outright rather than one implied by the window.
function computeNtapsWindes(fs: number, transition: number, attenuationDb: number): number {
  return oddTaps((attenuationDb * fs) / (22.0 * transition));
}

function sanityCheck1f(fs: number, fa: number, transition: number): void {
  if (!(fs > 0.0)) throw new Error('firdes check failed: sampling_freq > 0');
  if (!(fa > 0.0) || fa > fs / 2)
    throw new Error('firdes check failed: 0 < fa <= sampling_freq / 2');
  if (!(transition > 0.0)) throw new Error('firdes check failed: transition_width > 0');
}

// The body both low_pass forms share: a windowed sinc normalised so the gain at
// DC is exactly `gain`. fmax is taps[M] + 2*sum(upper half) rather than the
// plain sum, which is the same number for a symmetric filter and is how
// firdes.cc spells it.
function lowPassTaps(gain: number, fs: number, cutoff: number, ntaps: number,
                     winType: number, param: number): number[] {
  const w = windowBuild(winType, ntaps, param);
  const taps = new Array<number>(ntaps).fill(0);
  const M = Math.trunc((ntaps - 1) / 2);
  const fwT0 = (2 * Math.PI * cutoff) / fs;
  for (let n = -M; n <= M; n++) {
    taps[n + M] = n === 0
      ? (fwT0 / Math.PI) * w[n + M]
      : (Math.sin(n * fwT0) / (n * Math.PI)) * w[n + M];
  }
  let fmax = taps[M];
  for (let n = 1; n <= M; n++) fmax += 2 * taps[n + M];
  const scale = gain / fmax;
  for (let i = 0; i < ntaps; i++) taps[i] *= scale;
  return taps;
}

function firdesLowPass(gain: number, fs: number, cutoff: number, transition: number,
                       winType = WIN_HAMMING, param = DEFAULT_WIN_PARAM): number[] {
  sanityCheck1f(fs, cutoff, transition);
  return lowPassTaps(gain, fs, cutoff,
    computeNtaps(fs, transition, winType, param), winType, param);
}

function firdesLowPass2(gain: number, fs: number, cutoff: number, transition: number,
                        attenuationDb: number,
                        winType = WIN_HAMMING, param = DEFAULT_WIN_PARAM): number[] {
  sanityCheck1f(fs, cutoff, transition);
  return lowPassTaps(gain, fs, cutoff,
    computeNtapsWindes(fs, transition, attenuationDb), winType, param);
}

// firdes::root_raised_cosine, transcribed from gr-filter/lib/firdes.cc. Two
// details are load-bearing and were wrong here before: `x2` has no factor of pi
// (a spurious one moves the x2*x2 == 1 singularity, so the tails diverge instead
// of decaying — the taps stopped being a root-raised-cosine at all), and the
// taps are normalised by their *sum*, not their energy, so each branch of a
// polyphase clock sync ends up with the DC gain the caller asked for.
function rrc(gain: number, fs: number, symRate: number, alpha: number, ntaps: number): number[] {
  ntaps |= 1; // GNU Radio forces an odd tap count
  const spb = fs / symRate; // samples per symbol
  const half = Math.trunc(ntaps / 2);
  const taps = new Array(ntaps).fill(0);
  let scale = 0;
  for (let i = 0; i < ntaps; i++) {
    const xindx = i - half;
    const x1 = Math.PI * xindx / spb;
    let x2 = 4 * alpha * xindx / spb;
    let x3 = x2 * x2 - 1;
    let num: number, den: number;
    if (Math.abs(x3) >= 0.000001) { // avoid rounding errors
      if (i !== half) num = Math.cos((1 + alpha) * x1) + Math.sin((1 - alpha) * x1) / (4 * alpha * xindx / spb);
      else num = Math.cos((1 + alpha) * x1) + (1 - alpha) * Math.PI / (4 * alpha);
      den = x3 * Math.PI;
    } else { // l'Hopital limit
      if (alpha === 1) { taps[i] = -1; scale += -1; continue; }
      x3 = (1 - alpha) * x1;
      x2 = (1 + alpha) * x1;
      num = Math.sin(x2) * (1 + alpha) * Math.PI
        - Math.cos(x3) * ((1 - alpha) * Math.PI * spb) / (4 * alpha * xindx)
        + Math.sin(x3) * spb * spb / (4 * alpha * xindx * xindx);
      den = -32 * Math.PI * alpha * alpha * xindx / spb;
    }
    taps[i] = 4 * alpha * num / den;
    scale += taps[i];
  }
  return taps.map(t => t * gain / scale);
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
  // The id prefix, plus the one control whose id predates the convention. Same
  // rule as `is_variable_control()` in runner/src/grc_lower.hpp and
  // VARIABLE_CONTROL_IDS in validation.ts.
  const isVar = (b: VarBlock) => b.id === 'variable' || b.id.startsWith('variable_') ||
    b.id === 'qtgui_msgdigitalnumbercontrol';
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

// Bare variable references in `src` that the flowgraph does not define.
//
// Native GRC evaluates every parameter against a namespace built from the
// flowgraph, so a value of `samp_rate` with no `samp_rate` variable is a hard
// error there ("name 'samp_rate' is not defined"). The editor evaluates only
// the parameters it has to (see resolveParamsForRun), so without this check an
// undefined name in a `raw` or vector parameter reaches the runner as literal
// text and is silently coerced to zero.
//
// Only a *bare* name counts. The base of an attribute access or a call —
// `analog.GR_COS_WAVE`, `digital.constellation_bpsk()` — names a module this
// evaluator does not model rather than a flowgraph variable, and reporting
// those would refuse flowgraphs that run.
export function undefinedNames(src: string, scope: Scope = {}): string[] {
  let ast: Node;
  try { ast = new Parser(lex(src)).parse(); } catch { return []; }
  const found = new Set<string>();
  const known = (id: string) => id in scope || id in NAMESPACES || id in BUILTINS ||
    id === 'True' || id === 'False' || id === 'None' || id === 'pi' || id === 'e';
  const walk = (n: Node): void => {
    switch (n.k) {
      case 'name': if (!known(n.v)) found.add(n.v); return;
      // A namespace-looking base is left alone, whether or not it resolves.
      case 'attr': if (n.e.k !== 'name') walk(n.e); return;
      case 'call':
        if (n.fn.k !== 'name') walk(n.fn);
        n.args.forEach(walk);
        return;
      case 'list': case 'tuple': n.items.forEach(walk); return;
      case 'unary': walk(n.e); return;
      case 'bin': walk(n.a); walk(n.b); return;
      case 'index':
        walk(n.e);
        if (n.idx) walk(n.idx);
        if (n.slice?.lo) walk(n.slice.lo);
        if (n.slice?.hi) walk(n.slice.hi);
        return;
      default: return;
    }
  };
  walk(ast);
  return [...found];
}
