import { RUNNABLE } from './block-defs';
import type { ValidationIssue } from './graph-model';
import type { EditorGraphState } from './editor-state';
import { numericOrExpression } from './block-library';
import { NAME_FIELD } from './validation';
import {
  colorPropertyRow,
  optionCombo,
  propertyFieldDtype,
  usesOptionCombo,
} from './property-fields';
import { fieldIssue, setFieldError } from './validation-ui';

export interface VariableEditorDeps {
  state: EditorGraphState;
  closeContextMenu(): void;
  render(): void;
  recordHistory(): void;
  validateGraph(): ValidationIssue[];
  showFieldColors(): boolean;
}

export function showVariableEditor(deps: VariableEditorDeps): void {
  deps.closeContextMenu();
  document.querySelector('.modal')?.remove();
  const variables = deps.state.insts.filter(
    instance => instance.id === 'variable' || instance.id.startsWith('variable_'));
  const overlay = document.createElement('div');
  overlay.className = 'modal variables';
  const dialog = document.createElement('div');
  dialog.className = 'dlg';
  const head = document.createElement('div');
  head.className = 'dlghead';
  head.textContent = 'Variable Editor';
  const body = document.createElement('div');
  body.className = 'dlgbody';
  const controls: { uid: string; field: string; node: HTMLElement; error: HTMLElement }[] = [];
  const refreshValidation = () => {
    const issues = deps.validateGraph();
    controls.forEach(control => setFieldError(
      control.node,
      control.error,
      fieldIssue(issues, control.uid, control.field),
    ));
  };
  if (!variables.length) {
    body.textContent = 'No variable blocks are present in this flowgraph.';
  } else for (const variable of variables) {
    const definition = RUNNABLE[variable.id];
    const title = document.createElement('div');
    title.className = 'dlghead';
    title.textContent = definition.label;
    body.appendChild(title);
    const add = (label: string, node: HTMLElement, field: string,
                 validationNode: HTMLElement = node, dtype = '') => {
      const row = document.createElement('div');
      row.className = 'dlgrow';
      const fieldLabel = document.createElement('label');
      fieldLabel.textContent = label;
      const control = document.createElement('div');
      control.className = 'field-control';
      const error = document.createElement('small');
      error.className = 'field-error';
      error.hidden = true;
      control.append(node, error);
      row.append(fieldLabel, control);
      body.appendChild(row);
      colorPropertyRow(row, dtype, deps.showFieldColors());
      controls.push({ uid: variable.uid, field, node: validationNode, error });
    };
    const name = document.createElement('input');
    name.value = variable.name;
    name.oninput = () => {
      variable.name = name.value.replace(/\s+/g, '_');
      deps.render();
      refreshValidation();
    };
    name.onchange = deps.recordHistory;
    add('ID', name, NAME_FIELD, name, 'id');
    for (const param of definition.params) {
      const set = (value: string) => {
        variable.params[param.id] = param.type === 'number' ? numericOrExpression(value) : value;
        deps.render();
        refreshValidation();
      };
      if (usesOptionCombo(param)) {
        const combo = optionCombo(param, String(variable.params[param.id]), set);
        combo.select.addEventListener('change', deps.recordHistory);
        combo.input.addEventListener('change', deps.recordHistory);
        add(param.label, combo.wrap, param.id, combo.select, propertyFieldDtype(param));
        continue;
      }
      let input: HTMLInputElement | HTMLSelectElement;
      if (param.type === 'enum') {
        input = document.createElement('select');
        for (const option of param.options || [])
          input.appendChild(new Option(option, option));
        input.value = String(variable.params[param.id]);
      } else {
        input = document.createElement('input');
        input.value = String(variable.params[param.id]);
      }
      input.oninput = () => set(input.value);
      input.onchange = deps.recordHistory;
      add(param.label, input, param.id, input, propertyFieldDtype(param));
    }
  }
  const foot = document.createElement('div');
  foot.className = 'dlgfoot';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.onclick = () => overlay.remove();
  foot.appendChild(close);
  dialog.append(head, body, foot);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('pointerdown', event => {
    if (event.target === overlay) overlay.remove();
  });
  refreshValidation();
  close.focus();
}
