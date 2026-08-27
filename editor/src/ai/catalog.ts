import type { Inst } from '../graph-model';
import type { ResolvedPort, RunnableDef } from '../block-defs';

export interface CatalogEntry {
  id: string;
  label: string;
  category: string;
  javascript?: boolean;
  /** Reaches a physical device: needs one present, plus a human click to run. */
  hardware?: boolean;
}

export interface CatalogDeps {
  entries(): CatalogEntry[];
  definition(id: string): RunnableDef | undefined;
  ports(id: string, kind: 'in' | 'out'): ResolvedPort[];
}

/**
 * The whole runnable catalog as system-prompt text, grouped so each category is
 * named once rather than restated on all of its blocks. Same ids, labels and
 * categories as one line each; about a quarter fewer tokens, resent every round.
 */
export function runnableIndex(entries: CatalogEntry[]): string {
  const byCategory = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category);
    if (list) list.push(entry);
    else byCategory.set(entry.category, [entry]);
  }
  return [...byCategory.keys()].sort().map(category =>
    `${category}:\n${byCategory.get(category)!
      .map(entry => `  ${entry.id} | ${entry.label}` +
        `${entry.javascript ? ' | JavaScript' : ''}` +
        `${entry.hardware ? ' | HARDWARE: only if the user asked for this device' : ''}`)
      .join('\n')}`).join('\n');
}

function score(entry: CatalogEntry, words: string[]): number {
  const id = entry.id.toLowerCase();
  const label = entry.label.toLowerCase();
  const category = entry.category.toLowerCase();
  let total = 0;
  for (const word of words) {
    if (id === word || label === word) total += 100;
    else if (id.startsWith(word) || label.startsWith(word)) total += 35;
    else if (id.includes(word)) total += 20;
    else if (label.includes(word)) total += 15;
    else if (category.includes(word)) total += 5;
    else return 0;
  }
  return total;
}

export function searchCatalog(entries: CatalogEntry[], query: string, limit = 20): CatalogEntry[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return entries.slice(0, limit);
  return entries.map(entry => ({ entry, rank: score(entry, words) }))
    .filter(item => item.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.entry.label.localeCompare(b.entry.label))
    .slice(0, limit).map(item => item.entry);
}

/**
 * A few blocks carry many kilobytes of doxygen prose — `variable_constellation`
 * alone is 8.7 KB — and every tool result stays in the transcript for the rest
 * of the turn. Truncate to the part that describes what the block does, and say
 * inline how to ask for the rest.
 */
export const API_DOC_LIMIT = 1000;

function clampApiDocs(text: string, full: boolean): string {
  if (full || text.length <= API_DOC_LIMIT) return text;
  const cut = text.lastIndexOf('\n', API_DOC_LIMIT);
  const kept = text.slice(0, cut > API_DOC_LIMIT * 0.6 ? cut : API_DOC_LIMIT);
  return `${kept}\n… ${text.length - kept.length} more characters; call describe_block again with full_docs: true to read all of it`;
}

export function describeBlock(
  deps: CatalogDeps, id: string, fullDocs = false,
): Record<string, unknown> {
  const def = deps.definition(id);
  const hardware = deps.entries().find(entry => entry.id === id)?.hardware;
  if (!def) throw new Error(`block "${id}" is not runnable in this WebAssembly build`);
  const params = def.params.map(param => ({
    id: param.id,
    label: param.label,
    dtype: param.dtype || param.type,
    default: param.def,
    options: param.options?.map((value, index) => ({
      value, label: param.optionLabels?.[index] || value,
    })),
  }));
  const ports = (kind: 'in' | 'out') => deps.ports(id, kind).map((port, index) => ({
    index,
    id: port.id,
    label: port.name,
    domain: port.domain,
    dtype: port.dtype,
    optional: port.optional,
  }));
  return {
    id,
    label: def.label,
    ...(hardware ? { hardware: 'Reaches a physical device. It needs that device ' +
      'plugged in and a human permission click, so a flowgraph built around it ' +
      'cannot run on its own. Use it only when the user asked for this hardware; ' +
      'otherwise use a hosted recording or a simulated source.' } : {}),
    parameters: params,
    inputs: ports('in'),
    outputs: ports('out'),
    documentation: def.documentation || '',
    api_documentation: clampApiDocs(def.apiDocumentation || '', fullDocs),
    wiki_url: def.wikiUrl || '',
  };
}

/**
 * `describe_block` without the prose, for the block types already on the canvas:
 * those go into every user message, and the parameter contract is the part a
 * turn needs before it can edit or explain anything. Derived from the same
 * function rather than a parallel one, so a field added there appears here.
 */
export function briefBlock(deps: CatalogDeps, id: string): Record<string, unknown> {
  const { documentation, api_documentation, wiki_url, ...brief } = describeBlock(deps, id);
  return brief;
}

export function nonDefaultParams(inst: Inst, def: RunnableDef): Record<string, unknown> {
  return Object.fromEntries(def.params
    .filter(param => JSON.stringify(inst.params[param.id]) !== JSON.stringify(param.def))
    .map(param => [param.id, inst.params[param.id]]));
}
