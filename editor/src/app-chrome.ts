export type MenuItem = {
  label: string;
  key?: string;
  run?: () => void;
  reason?: string;
  enabled?: () => boolean;
  check?: () => boolean;
  danger?: boolean;
};

export interface TopMenu {
  label: string;
  items: (MenuItem | 'sep')[];
}

export interface Tool {
  icon: string;
  label: string;
  key?: string;
  run?: () => void;
  reason?: string;
}

let wasmTipEl: HTMLDivElement | null = null;

function ensureTip(): HTMLDivElement {
  if (!wasmTipEl) {
    wasmTipEl = document.createElement('div');
    wasmTipEl.id = 'wasmTip';
    wasmTipEl.hidden = true;
    document.body.appendChild(wasmTipEl);
  }
  return wasmTipEl;
}

function positionTip(node: HTMLElement): void {
  const tip = ensureTip();
  const rect = node.getBoundingClientRect();
  let left = rect.right + 8;
  let top = rect.top;
  if (left + tip.offsetWidth > window.innerWidth - 8)
    left = rect.left - tip.offsetWidth - 8;
  if (top + tip.offsetHeight > window.innerHeight - 8)
    top = window.innerHeight - tip.offsetHeight - 8;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}

function hideTip(): void {
  if (wasmTipEl) wasmTipEl.hidden = true;
}

function attachTip(node: HTMLElement, message: string): void {
  node.addEventListener('mouseenter', () => {
    const tip = ensureTip();
    tip.textContent = message;
    tip.hidden = false;
    positionTip(node);
  });
  node.addEventListener('mousemove', () => positionTip(node));
  node.addEventListener('mouseleave', hideTip);
}

export function closeMenus(): void {
  document.querySelectorAll('#menus .menu-top.open').forEach(top => {
    top.classList.remove('open');
    top.querySelector('.menu-drop')?.remove();
  });
  hideTip();
}

function buildMenuDrop(items: (MenuItem | 'sep')[]): HTMLElement {
  const drop = document.createElement('div');
  drop.className = 'menu-drop';
  drop.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === 'sep') {
      drop.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
      continue;
    }
    const row = document.createElement('div');
    row.className = 'menuitem' + (item.danger ? ' danger' : '');
    row.setAttribute('role', 'menuitem');
    const check = document.createElement('span');
    check.className = 'mi-check';
    check.textContent = item.check?.() ? '✓' : '';
    const label = document.createElement('span');
    label.className = 'mi-label';
    label.textContent = item.label;
    const key = document.createElement('span');
    key.className = 'mi-key';
    key.textContent = item.key || '';
    row.append(check, label, key);
    if (item.reason) {
      row.classList.add('disabled');
      attachTip(row, item.reason);
    } else if (item.enabled && !item.enabled()) {
      row.classList.add('disabled');
    } else {
      row.addEventListener('click', event => {
        event.stopPropagation();
        closeMenus();
        item.run?.();
      });
    }
    drop.appendChild(row);
  }
  return drop;
}

function openTop(top: HTMLElement, items: (MenuItem | 'sep')[]): void {
  closeMenus();
  top.appendChild(buildMenuDrop(items));
  top.classList.add('open');
}

export function buildMenuBar(menus: TopMenu[], root: HTMLElement): void {
  root.textContent = '';
  for (const menu of menus) {
    const top = document.createElement('div');
    top.className = 'menu-top';
    top.setAttribute('role', 'menuitem');
    top.tabIndex = 0;
    const label = document.createElement('span');
    label.textContent = menu.label;
    top.appendChild(label);
    top.addEventListener('click', event => {
      event.stopPropagation();
      if (top.classList.contains('open')) closeMenus();
      else openTop(top, menu.items);
    });
    top.addEventListener('mouseenter', () => {
      if (root.querySelector('.menu-top.open') && !top.classList.contains('open'))
        openTop(top, menu.items);
    });
    root.appendChild(top);
  }
}

export function installMenuDismissal(root: Document = document): void {
  root.addEventListener('pointerdown', event => {
    if (!(event.target as HTMLElement).closest('#menus')) closeMenus();
  });
}

export function buildToolbar(tools: (Tool | 'sep')[], root: HTMLElement): void {
  root.textContent = '';
  for (const tool of tools) {
    if (tool === 'sep') {
      root.appendChild(Object.assign(document.createElement('div'), { className: 'tsep' }));
      continue;
    }
    const button = document.createElement('button');
    button.className = 'tbtn';
    button.textContent = tool.icon;
    button.setAttribute('aria-label', tool.label);
    // The narrow layout orders these by label, pulling Execute and Kill to the
    // front when the complete toolbar does not fit.
    button.dataset.tool = tool.label;
    if (tool.reason) {
      button.classList.add('disabled');
      button.setAttribute('aria-disabled', 'true');
      attachTip(button, tool.reason);
    } else {
      button.title = tool.label + (tool.key ? ` (${tool.key})` : '');
      button.onclick = () => tool.run?.();
    }
    root.appendChild(button);
  }
}
