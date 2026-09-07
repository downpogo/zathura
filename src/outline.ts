export interface OutlineNode {
  readonly title: string;
  readonly dest: unknown;
  readonly children: readonly OutlineNode[];
}

export interface OutlineTreeHost {
  /** Activation request; destinations are resolved by the caller. */
  onActivate(node: OutlineNode): void;
}

interface Row {
  item: OutlineNode;
  row: HTMLButtonElement;
  expander?: HTMLButtonElement;
  children?: HTMLUListElement;
}

/**
 * Collapsible outline tree. Titles are untrusted PDF content and are only
 * ever rendered as text nodes. Entries without a destination and without
 * children are inert; parentless-destination entries still expand children.
 */
export class OutlineTree {
  readonly #container: HTMLElement;
  readonly #host: OutlineTreeHost;
  readonly #rows = new Set<Row>();

  constructor(container: HTMLElement, host: OutlineTreeHost) {
    this.#container = container;
    this.#host = host;
  }

  /** `null` or an empty list renders the honest "no table of contents" state. */
  setNodes(nodes: readonly OutlineNode[] | null): void {
    this.reset();
    if (!nodes || nodes.length === 0) {
      const message = document.createElement('p');
      message.className = 'outline-empty';
      message.textContent = 'This PDF has no table of contents.';
      this.#container.replaceChildren(message);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'outline-list';
    list.setAttribute('role', 'tree');
    for (const item of nodes) list.append(this.#entry(item));
    this.#container.replaceChildren(list);
  }

  reset(): void {
    this.#rows.clear();
    this.#container.replaceChildren();
  }

  #entry(item: OutlineNode): HTMLLIElement {
    const entry = document.createElement('li');
    entry.className = 'outline-entry';
    entry.setAttribute('role', 'none');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'outline-row';
    row.setAttribute('role', 'treeitem');
    row.textContent = item.title || '(untitled)';
    const hasChildren = item.children.length > 0;
    const navigable = item.dest !== null && item.dest !== undefined;
    const li: Row = { item, row };
    if (hasChildren) {
      const children = document.createElement('ul');
      children.className = 'outline-list';
      children.setAttribute('role', 'group');
      children.hidden = true;
      for (const child of item.children) children.append(this.#entry(child));
      const expander = document.createElement('button');
      expander.type = 'button';
      expander.className = 'outline-expander';
      expander.textContent = '▸';
      expander.setAttribute('aria-expanded', 'false');
      expander.setAttribute('aria-label', `Toggle section ${row.textContent}`);
      expander.addEventListener('click', event => {
        event.stopPropagation();
        this.#toggle(li);
      });
      if (!navigable) {
        row.setAttribute('aria-expanded', 'false');
        // A destination-less parent still expands its children on activation.
        row.addEventListener('click', () => this.#toggle(li));
      } else {
        row.addEventListener('click', () => this.#host.onActivate(item));
      }
      entry.append(expander, row, children);
      li.expander = expander;
      li.children = children;
    } else if (navigable) {
      row.addEventListener('click', () => this.#host.onActivate(item));
      entry.append(row);
    } else {
      row.disabled = true;
      entry.append(row);
    }
    this.#rows.add(li);
    return entry;
  }

  #toggle(entry: Row): void {
    if (!entry.children || !entry.expander) return;
    const expanded = entry.children.hidden;
    entry.children.hidden = !expanded;
    entry.expander.textContent = expanded ? '▾' : '▸';
    entry.expander.setAttribute('aria-expanded', String(expanded));
    entry.row.setAttribute('aria-expanded', String(expanded));
  }
}
