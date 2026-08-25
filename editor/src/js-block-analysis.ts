import { parser } from '@lezer/javascript';

export interface JsSourceWarning {
  code: string;
  message: string;
  line: number;
  column: number;
}

interface NodeInfo {
  name: string;
  from: number;
  to: number;
  depth: number;
  parents: string[];
}

const position = (source: string, offset: number) => {
  const head = source.slice(0, offset);
  const line = head.split('\n').length;
  const last = head.lastIndexOf('\n');
  return { line, column: offset - last };
};

/**
 * Conservative JS Block-specific warnings. Descriptor validation remains the
 * authority and these never reject source: each catches a known quiet failure
 * or performance trap while avoiding style advice Graham cannot act on.
 */
export function analyzeJsSource(source: string): JsSourceWarning[] {
  const nodes: NodeInfo[] = [];
  const tree = parser.parse(source);
  const cursor = tree.cursor();
  const walk = (depth: number, parents: string[]) => {
    const node = { name: cursor.name, from: cursor.from, to: cursor.to, depth, parents };
    nodes.push(node);
    if (cursor.firstChild()) {
      do walk(depth + 1, [...parents, node.name]); while (cursor.nextSibling());
      cursor.parent();
    }
  };
  walk(0, []);

  const warnings: JsSourceWarning[] = [];
  const seen = new Set<string>();
  const warn = (code: string, message: string, offset: number) => {
    const at = position(source, offset);
    const key = `${code}:${at.line}:${at.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push({ code, message, ...at });
  };

  for (const node of nodes) {
    const text = source.slice(node.from, node.to);
    if (node.name === '⚠')
      warn('parse-error', 'The JavaScript parser found incomplete or invalid syntax.', node.from);

    // A Script child is top-level. A mutable binding there is constructed once
    // per evaluation rather than once per block instance; start()/this is the
    // contract for state that changes while the graph runs.
    if (node.name === 'VariableDeclaration' && node.depth === 1 && /^\s*(?:let|var)\b/.test(text))
      warn('top-level-state',
        'Mutable top-level state is evaluated twice and is not per-instance; initialize it in start() or store it on this.',
        node.from);

    if (node.name === 'AssignmentExpression' &&
        /^\s*this\.[A-Za-z_$][\w$]*\s*=\s*(?:input|output)\s*\[/.test(text))
      warn('cached-buffer-view',
        'Do not retain an input/output typed-array view on this; views must be used only during the current call.',
        node.from);

    if (node.name === 'CallExpression' && /^\s*console\.log\s*\(/.test(text))
      warn('console-log',
        'console.log() from a scheduler worker reaches only devtools; use this.log() for the flowgraph console.',
        node.from);

    if (node.name === 'ImportDeclaration' ||
        (node.name === 'CallExpression' && /^\s*(?:require|importScripts|fetch)\s*\(/.test(text)))
      warn('unsupported-import',
        'JS Blocks have no module graph or network-import contract; keep the block self-contained.',
        node.from);

    const insideLoop = node.parents.some(parent =>
      parent === 'ForStatement' || parent === 'WhileStatement' || parent === 'DoStatement');
    if (insideLoop && (node.name === 'NewExpression' ||
        node.name === 'ArrayExpression' || node.name === 'ObjectExpression'))
      warn('hot-allocation',
        'This allocation is inside a loop and may dominate a hot work() path; reuse scalar locals or per-instance state when practical.',
        node.from);
  }

  if (/\bgeneralWork\s*\(/.test(source) && !/\bthis\.consume\s*\(/.test(source))
    warn('missing-consume',
      'generalWork() consumes nothing automatically; call this.consume(port, n) on every progress path.',
      source.search(/\bgeneralWork\s*\(/));

  return warnings.sort((a, b) => a.line - b.line || a.column - b.column);
}
