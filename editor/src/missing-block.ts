import type { ResolvedPort, RunnableDef } from './block-defs';
import type { Inst } from './graph-model';

// GTK GRC's core/blocks/dummy.py: preserve the original key and parameters,
// show "Missing Block", and create a '?' port for each connected endpoint.
export function missingBlockDefinition(inst: Inst): RunnableDef {
  return {
    label: 'Missing Block', inputs: inst.missing!.in.length, outputs: inst.missing!.out.length,
    documentation: `Block "${inst.id}" is not supported in GNU Radio World. ` +
      'Its parameters and connections are preserved when saving.',
    params: Object.entries(inst.params).map(([id, value]) => ({
      id, label: id, type: 'string', def: value, hide: 'part',
    })),
  };
}

export function missingPortIndex(inst: Inst, kind: 'in' | 'out', token: string): number {
  const ids = inst.missing![kind];
  const index = ids.indexOf(token);
  if (index >= 0) return index;
  return ids.push(token) - 1;
}

export function missingPorts(inst: Inst, kind: 'in' | 'out'): ResolvedPort[] {
  return inst.missing![kind].map(id => ({
    id, name: '?', dtype: '', vlen: '',
    domain: /^\d+$/.test(id) ? 'stream' : 'message',
    streamIndex: /^\d+$/.test(id) ? Number(id) : -1,
    optional: true, hidden: false,
  }));
}
