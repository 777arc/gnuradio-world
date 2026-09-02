import type { ParamDef } from './block-defs';
import { normalizeNoteColor } from './note';

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
  real_matrix: '#CC8C69', float_matrix: '#CC8C69', int_matrix: '#00CC99',
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

// A colour parameter (the Note block's background): the browser's own picker,
// the hex beside it so the value is readable and typeable, and a Default button
// that clears the field back to the block's normal fill. `commit` receives ''
// for "no colour" and a canonical `#rrggbb` otherwise -- never a half-typed hex,
// so the canvas cannot flicker through the colours a user passes on the way.
export function colorField(value: string, commit: (value: string) => void,
                           fallback: string) {
  const wrap = document.createElement('div');
  wrap.className = 'color-field';
  const swatch = document.createElement('input');
  swatch.type = 'color';
  const text = document.createElement('input');
  text.className = 'color-hex';
  text.placeholder = fallback;
  text.spellcheck = false;
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'color-default';
  clear.textContent = 'Default';
  const show = (current: string) => {
    // An <input type=color> has no empty state, so an unset parameter shows the
    // fill the block already has -- opening the picker on the colour on screen.
    swatch.value = normalizeNoteColor(current) || fallback;
    text.value = normalizeNoteColor(current);
    clear.disabled = !text.value;
  };
  show(value);
  swatch.oninput = () => { show(swatch.value); commit(normalizeNoteColor(swatch.value)); };
  // Typing is committed only once it parses, so the intermediate "#f", "#f1"…
  // of a hand-typed hex neither clears the colour nor paints a wrong one.
  text.oninput = () => {
    const parsed = normalizeNoteColor(text.value);
    clear.disabled = !text.value.trim();
    if (parsed) { swatch.value = parsed; commit(parsed); }
    else if (!text.value.trim()) commit('');
  };
  text.onblur = () => show(normalizeNoteColor(text.value));
  clear.onclick = () => { show(''); commit(''); };
  wrap.append(swatch, text, clear);
  return { wrap, swatch, text, clear };
}
