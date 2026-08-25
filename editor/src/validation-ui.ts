import type { ValidationIssue } from './graph-model';

export function fieldIssue(issues: ValidationIssue[], uid: string, field: string): string {
  return issues.find(issue => issue.uid === uid && issue.field === field)?.message || '';
}

export function setFieldError(node: HTMLElement, errorNode: HTMLElement, message: string): void {
  node.classList.toggle('field-invalid', !!message);
  node.setAttribute('aria-invalid', String(!!message));
  if (message) node.setAttribute('title', message);
  else node.removeAttribute('title');
  errorNode.textContent = message;
  errorNode.hidden = !message;
}
