// Native GNU Radio Companion (.grc) YAML serialization.
//
// GRC flowgraphs are YAML with a specific shape (see grc/core/FlowGraph.py
// export_data and grc/core/io/yaml.py GRCDumper). This module emits and parses
// that format so the web editor's saved files are readable by desktop GRC and
// vice-versa. The dumper reproduces PyYAML SafeDumper's conventions closely:
// 4-space indent, block-style maps, flow-style `coordinate` and `connections`,
// and PyYAML's plain/single-quoted scalar choice.

import { load as yamlLoad } from 'js-yaml';

export type GrcScalar = string | number | boolean;
export interface GrcDoc {
  options: { parameters: Record<string, GrcScalar>; states: Record<string, any> };
  blocks: Array<{ name: string; id: string; parameters: Record<string, GrcScalar>; states: Record<string, any> }>;
  connections: Array<Array<GrcScalar> | Record<string, GrcScalar>>;
  metadata: Record<string, GrcScalar>;
}

// ---- scalar emission (matches PyYAML SafeDumper plain/single-quote choice) ----

// Words PyYAML's implicit resolver would read back as a non-string type; such a
// string must be quoted to survive a round-trip as a string.
const NON_STRING = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF)$/;
const INT_RE = /^[-+]?(?:0b[0-1_]+|0x[0-9a-fA-F_]+|0o?[0-7_]+|(?:0|[1-9][0-9_]*))$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9][0-9_]*(?:\.[0-9_]*)?)(?:[eE][-+]?[0-9]+)?$/;
const INF_NAN = /^[-+]?(?:\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)$/;

function plainAllowed(s: string, flow: boolean): boolean {
  if (s === '') return false;
  if (NON_STRING.test(s) || INT_RE.test(s) || FLOAT_RE.test(s) || INF_NAN.test(s)) return false;
  // Leading indicator characters that are never allowed to start a plain scalar.
  if (/^[?:\-]$/.test(s[0]) === false && /^[,\[\]{}#&*!|>'"%@`]/.test(s)) return false;
  // '-', '?' and ':' are only indicators when followed by a space (or at EOL).
  if (/^[?:\-](?:\s|$)/.test(s)) return false;
  if (/^\s|\s$/.test(s)) return false;          // leading/trailing whitespace
  if (s.includes(': ') || s.endsWith(':')) return false;
  if (s.includes(' #')) return false;
  if (flow && /[,\[\]{}]/.test(s)) return false; // flow indicators inside flow context
  // Non-printable or non-ASCII: PyYAML (allow_unicode=False, as GRC uses) must
  // escape these in a double-quoted scalar, so they can't be plain.
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(s)) return false;
  return true;
}

function quoteSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// PyYAML double-quoted escaping for chars outside printable ASCII (matches its
// allow_unicode=False output: \xXX / \uXXXX / \UXXXXXXXX plus the named escapes).
function quoteDouble(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x00) out += '\\0';
    else if (c === 0x07) out += '\\a';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0b) out += '\\v';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x1b) out += '\\e';
    else if (c === 0x85) out += '\\N';
    else if (c === 0xa0) out += '\\_';
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else if (c <= 0xff) out += '\\x' + c.toString(16).toUpperCase().padStart(2, '0');
    else if (c <= 0xffff) out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    else out += '\\U' + c.toString(16).toUpperCase().padStart(8, '0');
  }
  return out + '"';
}

const hasNonAscii = (s: string): boolean => /[^\x20-\x7e]/.test(s);

export function emitScalar(v: GrcScalar, flow = false): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '.nan';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = v;
  if (plainAllowed(s, flow)) return s;
  return hasNonAscii(s) ? quoteDouble(s) : quoteSingle(s);
}

// ---- dumper ----

const isScalar = (v: any): v is GrcScalar =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isFlowArray = (v: any): boolean => Array.isArray(v) && v.every(isScalar);

function emitFlow(arr: GrcScalar[]): string {
  return '[' + arr.map(e => emitScalar(e, true)).join(', ') + ']';
}

function emitMapping(obj: Record<string, any>, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const [k, v] of Object.entries(obj)) {
    if (isScalar(v)) out.push(`${pad}${k}: ${emitScalar(v)}`);
    else if (isFlowArray(v)) out.push(`${pad}${k}: ${emitFlow(v)}`);
    else if (Array.isArray(v)) {                 // block sequence
      out.push(`${pad}${k}:`);
      for (const item of v) emitSeqItem(item, indent, out);
    } else {                                      // nested mapping
      out.push(`${pad}${k}:`);
      emitMapping(v, indent + 4, out);
    }
  }
}

function emitSeqItem(item: any, dashIndent: number, out: string[]): void {
  const pad = ' '.repeat(dashIndent);
  if (isScalar(item)) { out.push(`${pad}- ${emitScalar(item)}`); return; }
  if (isFlowArray(item)) { out.push(`${pad}- ${emitFlow(item)}`); return; }
  // A mapping item: first key shares the dash line, rest indented under it.
  const contentIndent = dashIndent + 4;
  const sub: string[] = [];
  emitMapping(item, contentIndent, sub);
  const dashPrefix = pad + '-' + ' '.repeat(contentIndent - dashIndent - 1);
  sub[0] = dashPrefix + sub[0].slice(contentIndent);
  out.push(...sub);
}

export function dumpGrc(doc: GrcDoc): string {
  const out: string[] = [];
  emitMapping(doc as unknown as Record<string, any>, 0, out);
  return out.join('\n') + '\n';
}

// ---- parsing ----
// Desktop .grc files vary (2- vs 4-space indent, block scalars, comments), so
// parse with js-yaml for robustness rather than a bespoke reader. GRC values are
// all scalars we normalize to strings on import (see main.ts).
export function parseGrc(text: string): any {
  const doc = yamlLoad(text);
  if (!doc || typeof doc !== 'object')
    throw new Error('not a GNU Radio .grc flowgraph');
  return doc;
}
