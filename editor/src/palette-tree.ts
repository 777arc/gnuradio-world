import type { LocalJsBlock } from './js-block';

export interface LibraryBlock {
  id: string;
  label: string;
  runnable: boolean;
  unavailableReason?: string;
  module: string;
  js?: boolean;
  localJs?: LocalJsBlock;
}

interface Category {
  name: string;
  subs: Map<string, Category>;
  blocks: LibraryBlock[];
}

export interface PaletteTreeOptions {
  hidden: ReadonlySet<string>;
  isJavaScript(block: any): boolean;
  makeBlockItem(block: LibraryBlock, indent: number): HTMLElement;
}

function buildTree(blocks: any[], options: PaletteTreeOptions): Category {
  const root: Category = { name: '', subs: new Map(), blocks: [] };
  for (const block of blocks) {
    if (options.hidden.has(block.id)) continue;
    // Generated metadata uses an array so a literal slash in a category name
    // such as "Industrial I/O" is not mistaken for tree nesting.
    const category = block.category || ['Other'];
    const parts = (Array.isArray(category) ? category : String(category).split('/'))
      .map(String).filter(Boolean);
    let node = root;
    for (const part of parts) {
      let child = node.subs.get(part);
      if (!child) {
        child = { name: part, subs: new Map(), blocks: [] };
        node.subs.set(part, child);
      }
      node = child;
    }
    node.blocks.push({
      id: block.id,
      label: block.label || block.id,
      runnable: !!block.runnable,
      unavailableReason: block.unavailable_reason || undefined,
      module: block.module || 'core',
      localJs: block.localJs,
      js: options.isJavaScript(block),
    });
  }
  return root;
}

const matchesQuery = (block: { id: string; label: string }, query: string): boolean =>
  !query || `${block.label} ${block.id}`.toLowerCase().includes(query);

function categoryMatches(node: Category, query: string): boolean {
  return !query || node.blocks.some(block => matchesQuery(block, query)) ||
    [...node.subs.values()].some(child => categoryMatches(child, query));
}

function makeCategoryRow(name: string, container: HTMLElement, open: boolean,
                         indent = 6): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cat-row';
  row.style.paddingLeft = indent + 'px';
  const triangle = document.createElement('span');
  triangle.className = 'tri';
  const label = document.createElement('span');
  label.className = 'cat-name';
  label.textContent = name;
  row.append(triangle, label);
  const children = document.createElement('div');
  triangle.textContent = open ? '▾' : '▸';
  children.style.display = open ? 'block' : 'none';
  row.onclick = () => {
    const isOpen = children.style.display !== 'none';
    children.style.display = isOpen ? 'none' : 'block';
    triangle.textContent = isOpen ? '▸' : '▾';
  };
  container.append(row, children);
  return children;
}

const TREE_INDENT = 16;
const TOP_PALETTE_CATEGORY = 'Supported SDRs';
const CORE_PALETTE_CATEGORY = 'Core';
const AFTER_CORE_PALETTE_CATEGORY = 'GNU Radio World';

export function comparePaletteCategoryNames(a: string, b: string, depth: number): number {
  if (depth === 0) {
    if (a === b) return 0;
    if (a === TOP_PALETTE_CATEGORY) return -1;
    if (b === TOP_PALETTE_CATEGORY) return 1;
    if (a === CORE_PALETTE_CATEGORY) return -1;
    if (b === CORE_PALETTE_CATEGORY) return 1;
    if (a === AFTER_CORE_PALETTE_CATEGORY) return -1;
    if (b === AFTER_CORE_PALETTE_CATEGORY) return 1;
  }
  return a.localeCompare(b);
}

function renderCategory(node: Category, container: HTMLElement, depth: number,
                        query: string, options: PaletteTreeOptions): void {
  for (const child of [...node.subs.values()].sort(
    (a, b) => comparePaletteCategoryNames(a.name, b.name, depth))) {
    if (!categoryMatches(child, query)) continue;
    // A search opens everything it matched. Otherwise the two root categories
    // a user reaches for first start open: the radios they can actually plug
    // in, and Core.
    const openByDefault = depth === 0 &&
      (child.name === TOP_PALETTE_CATEGORY || child.name === CORE_PALETTE_CATEGORY);
    const children = makeCategoryRow(
      child.name,
      container,
      !!query || openByDefault,
      6 + depth * TREE_INDENT,
    );
    renderCategory(child, children, depth + 1, query, options);
  }
  const blocks = [...node.blocks]
    .filter(block => matchesQuery(block, query))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const block of blocks)
    container.appendChild(options.makeBlockItem(block, 6 + depth * TREE_INDENT + 20));
}

export function renderPaletteTree(blocks: any[], container: HTMLElement, query: string,
                                  options: PaletteTreeOptions): void {
  container.textContent = '';
  renderCategory(buildTree(blocks, options), container, 0, query, options);
}

export function makePaletteSearch(placeholder: string, ariaLabel: string):
    { bar: HTMLElement; input: HTMLInputElement } {
  const bar = document.createElement('div');
  bar.className = 'palsearch-bar';
  const input = document.createElement('input');
  input.className = 'palsearch';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  bar.append(input);
  return { bar, input };
}
