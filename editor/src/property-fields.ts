import type { ParamDef } from './block-defs';

// Native GRC gives an editable combo box to any parameter carrying options,
// including non-enum parameters whose current value may be an expression.
const CUSTOM_OPTION = '__grw_custom_value__';

export function optionCombo(param: ParamDef, value: string,
                            commit: (value: string) => void) {
  const wrap = document.createElement('div');
  wrap.className = 'opt-combo';
  const select = document.createElement('select');
  const input = document.createElement('input');
  const hint = document.createElement('small');
  hint.className = 'field-hint';
  hint.textContent = 'Custom value — reopen this dialog to choose from the list again.';
  input.hidden = hint.hidden = true;
  const labelOf = new Map((param.options || []).map(
    (option, index) => [option, param.optionLabels?.[index] ?? option]));
  const values = labelOf.has(value) ? [...labelOf.keys()] : [value, ...labelOf.keys()];
  for (const option of values)
    select.appendChild(new Option(labelOf.get(option) ?? option, option));
  select.appendChild(new Option('Custom value…', CUSTOM_OPTION));
  select.value = value;
  let current = value;
  select.onchange = () => {
    if (select.value !== CUSTOM_OPTION) {
      current = select.value;
      commit(current);
      return;
    }
    input.value = current;
    select.hidden = true;
    input.hidden = hint.hidden = false;
    input.focus();
    input.select();
  };
  input.oninput = () => {
    current = input.value;
    commit(current);
  };
  wrap.append(select, input, hint);
  return { wrap, select, input };
}

export function usesOptionCombo(param: ParamDef): boolean {
  return param.type !== 'enum' && !param.multiline && !!param.options?.length;
}

const PROPERTY_FIELD_COLORS: Record<string, string> = {
  complex: '#3399FF', real: '#FF8C69', float: '#FF8C69', int: '#00FF99',
  complex_vector: '#3399AA', real_vector: '#CC8C69', float_vector: '#CC8C69',
  int_vector: '#00CC99', bool: '#00FF99', hex: '#00FF99', string: '#CC66CC',
  id: '#DDDDDD', stream_id: '#DDDDDD', raw: '#DDDDDD',
};

export function propertyFieldDtype(param: ParamDef): string {
  return param.dtype || (param.type === 'number' ? 'real' : param.type);
}

export function colorPropertyRow(row: HTMLElement, dtype: string, enabled: boolean): void {
  if (!enabled) return;
  const color = PROPERTY_FIELD_COLORS[dtype];
  if (!color) return;
  row.classList.add('dtype-field');
  row.style.setProperty('--dtype-field-color', color);
}
