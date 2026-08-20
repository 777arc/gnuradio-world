import type { Inst } from '../graph-model';
import type { ResolvedPort, RunnableDef } from '../block-defs';

export interface CatalogEntry {
  id: string;
  label: string;
  category: string;
}

export interface CatalogDeps {
  entries(): CatalogEntry[];
  definition(id: string): RunnableDef | undefined;
  ports(id: string, kind: 'in' | 'out'): ResolvedPort[];
}

export function runnableIndex(entries: CatalogEntry[]): string {
  return entries.map(entry => `${entry.id} | ${entry.label} | ${entry.category}`).join('\n');
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

export function describeBlock(deps: CatalogDeps, id: string): Record<string, unknown> {
  const def = deps.definition(id);
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
    parameters: params,
    inputs: ports('in'),
    outputs: ports('out'),
    documentation: def.documentation || '',
    api_documentation: def.apiDocumentation || '',
    wiki_url: def.wikiUrl || '',
  };
}

export function nonDefaultParams(inst: Inst, def: RunnableDef): Record<string, unknown> {
  return Object.fromEntries(def.params
    .filter(param => JSON.stringify(inst.params[param.id]) !== JSON.stringify(param.def))
    .map(param => [param.id, inst.params[param.id]]));
}
