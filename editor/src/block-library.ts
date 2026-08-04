import { RUNNABLE, type ParamDef, type PortTemplate } from './block-defs';

// Numeric GRC fields may also contain a variable ID or expression.
export function numericOrExpression(value: string): number | string {
  const text = value.trim();
  if (!text) return '';
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
}

export function generatedDefault(p: any): any {
  const value = (p.dtype === 'enum' && (p.default === undefined || p.default === ''))
    ? (p.options?.[0] ?? '') : (p.default ?? '');
  if (p.dtype === 'bool') {
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    return String(value).trim().toLowerCase() === 'true' ? 'True' : 'False';
  }
  if (['int', 'real', 'float', 'hex'].includes(String(p.dtype)))
    return numericOrExpression(String(value));
  return String(value);
}

export function multiplicity(value: any, defaults: Record<string, any>): number {
  const text = String(value ?? '1').trim();
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct >= 1 ? Math.trunc(direct) : 1;
  const match = text.match(/^\$\{\s*([A-Za-z_]\w*)\s*\}$/);
  if (!match) return 1;
  const number = Number(defaults[match[1]]);
  return Number.isFinite(number) && number >= 1 ? Math.trunc(number) : 1;
}

export function installGeneratedBlocks(blocks: any[]) {
  for (const block of blocks) {
    if (!block.runnable) continue;
    const documentation = String(block.documentation || '').trim();
    const apiDocumentation = String(block.api_documentation || '').trim();
    const wikiUrl = String(block.wiki_url || '').trim();
    const params: ParamDef[] = (block.params || []).map((p: any) => ({
      id: String(p.id), label: String(p.label || p.id),
      type: p.dtype === 'enum' || p.dtype === 'bool' ? 'enum' :
        ['int', 'real', 'float', 'hex'].includes(String(p.dtype)) ? 'number' : 'string',
      raw: String(p.dtype) === 'raw',
      dtype: p.dtype ? String(p.dtype) : undefined,
      hide: p.hide ? String(p.hide) : 'none',
      def: generatedDefault(p),
      options: p.options ? p.options.map(String) :
        p.dtype === 'bool' ? ['True', 'False'] : undefined,
      optionLabels: p.option_labels ? p.option_labels.map(String) : undefined,
      optionAttributes: p.option_attributes
        ? Object.fromEntries(Object.entries(p.option_attributes)
            .map(([name, values]) => [name, (values as any[]).map(String)]))
        : undefined,
      // "General" is the default tab; those params belong on the block face
      // (like GRC's default category), so only carry a real, non-General
      // category so geom()/the face renderer doesn't hide every param.
      category: p.category && p.category !== 'General' ? p.category : undefined,
    }));
    const defaults: Record<string, any> = {};
    params.forEach(p => defaults[p.id] = p.def);
    const portBaseName = (port: any, kind: 'in' | 'out', streamIndex: number) => {
      const domain = String(port.domain || 'stream');
      const id = String(port.id || (domain === 'stream' ? streamIndex : ''));
      return String(port.label || (/^\d+$/.test(id) ? kind : id) || kind);
    };
    const expandPorts = (ports: any[], kind: 'in' | 'out') => {
      const result: { dtype: string; domain: string; id: string; name: string;
        streamIndex: number; optional: boolean }[] = [];
      let streamIndex = 0;
      for (const port of ports || []) {
        const count = multiplicity(port.multiplicity, defaults);
        const baseName = portBaseName(port, kind, streamIndex);
        for (let i = 0; i < count; ++i) {
          const domain = String(port.domain || 'stream');
          const id = String(port.id || (domain === 'stream' ? streamIndex : port.label || i));
          result.push({
            dtype: String(port.dtype || '').replace(
              /^\$\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\}$/, '$$$1'),
            domain, id, name: count > 1 ? `${baseName}${i}` : baseName,
            streamIndex: domain === 'stream' ? streamIndex : -1,
            optional: !!port.optional,
          });
          if (domain === 'stream') ++streamIndex;
        }
      }
      return result;
    };
    const portTemplates = (ports: any[]): PortTemplate[] => (ports || []).map((port: any) => ({
      dtype: String(port.dtype || ''),
      vlen: String(port.vlen || '1'),
      domain: String(port.domain || 'stream'),
      id: String(port.id || ''),
      label: String(port.label || ''),
      multiplicity: String(port.multiplicity || '1'),
      optional: !!port.optional,
      hide: port.hide ?? false,
    }));
    const inputs = expandPorts(block.inputs, 'in'), outputs = expandPorts(block.outputs, 'out');
    const existing = RUNNABLE[block.id];
    if (existing) {
      // Hand-written definitions carry richer parameter/run-time support. Add
      // the native face-visibility metadata, documentation and port names from
      // blocks.json without replacing that schema. Clone each parameter because
      // several hand-written definitions share TYPE_PARAM.
      const generatedParams = new Map(params.map(p => [p.id, p]));
      existing.params = existing.params.map(p => ({
        ...p,
        hide: generatedParams.get(p.id)?.hide ?? p.hide,
        optionLabels: generatedParams.get(p.id)?.optionLabels ?? p.optionLabels,
      }));
      // These definitions currently expose stream ports only, so omit optional
      // message-control ports that their WASM factories do not support.
      existing.documentation = documentation;
      existing.apiDocumentation = apiDocumentation;
      existing.wikiUrl = wikiUrl;
      const streamInputs = inputs.filter(p => p.domain === 'stream');
      const streamOutputs = outputs.filter(p => p.domain === 'stream');
      existing.inLabels = streamInputs.slice(0, existing.inputs).map(p => p.name);
      existing.outLabels = streamOutputs.slice(0, existing.outputs).map(p => p.name);
      existing.inOptional = streamInputs.slice(0, existing.inputs).map(p => p.optional);
      existing.outOptional = streamOutputs.slice(0, existing.outputs).map(p => p.optional);
      const inputDefs = (block.inputs || []).filter((p: any) => String(p.domain || 'stream') === 'stream');
      const outputDefs = (block.outputs || []).filter((p: any) => String(p.domain || 'stream') === 'stream');
      if (inputDefs.length === 1)
        existing.inLabelBase = portBaseName(inputDefs[0], 'in', 0);
      if (outputDefs.length === 1)
        existing.outLabelBase = portBaseName(outputDefs[0], 'out', 0);
      continue;
    }
    RUNNABLE[block.id] = {
      label: String(block.label || block.id), params, documentation, apiDocumentation, wikiUrl,
      inputs: inputs.length, outputs: outputs.length,
      inTypes: inputs.map(p => p.dtype), outTypes: outputs.map(p => p.dtype),
      inDomains: inputs.map(p => p.domain), outDomains: outputs.map(p => p.domain),
      inIds: inputs.map(p => p.id), outIds: outputs.map(p => p.id),
      inLabels: inputs.map(p => p.name), outLabels: outputs.map(p => p.name),
      inLabelBase: (block.inputs || []).length === 1
        ? portBaseName(block.inputs[0], 'in', 0) : undefined,
      outLabelBase: (block.outputs || []).length === 1
        ? portBaseName(block.outputs[0], 'out', 0) : undefined,
      inStreamIndices: inputs.map(p => p.streamIndex),
      outStreamIndices: outputs.map(p => p.streamIndex),
      inputTemplates: portTemplates(block.inputs),
      outputTemplates: portTemplates(block.outputs),
    };
  }
}
