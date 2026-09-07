export interface TabStripHost {
  onActivate(id: symbol): void;
  onClose(id: symbol): void;
}

interface TabControls {
  tab: HTMLButtonElement;
  close: HTMLButtonElement;
}

/** Compact tab list; names are untrusted and rendered as text only. */
export class TabStrip {
  readonly #strip: HTMLElement;
  readonly #host: TabStripHost;
  readonly #tabs = new Map<symbol, TabControls>();
  #active?: symbol;

  constructor(strip: HTMLElement, host: TabStripHost) {
    this.#strip = strip;
    this.#host = host;
  }

  get count(): number {
    return this.#tabs.size;
  }

  get active(): symbol | undefined {
    return this.#active;
  }

  ids(): symbol[] {
    return [...this.#tabs.keys()];
  }

  add(id: symbol, name: string): void {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = name;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.setAttribute('aria-label', `Close ${name}`);
    close.textContent = '×';
    close.addEventListener('click', event => {
      event.stopPropagation();
      this.#host.onClose(id);
    });
    tab.addEventListener('click', () => this.#host.onActivate(id));
    tab.append(label, close);
    this.#strip.append(tab);
    this.#tabs.set(id, { tab, close });
    this.#sync();
  }

  activate(id: symbol): void {
    if (!this.#tabs.has(id)) return;
    this.#active = id;
    for (const [entry, controls] of this.#tabs) {
      controls.tab.setAttribute('aria-selected', String(entry === id));
      controls.tab.classList.toggle('active', entry === id);
    }
  }

  /** The neighbor to select after id closes: next in order, else previous. */
  neighborOf(id: symbol): symbol | undefined {
    const ids = this.ids();
    const index = ids.indexOf(id);
    if (index === -1) return undefined;
    return ids[index + 1] ?? ids[index - 1];
  }

  /** Next/previous document operation for the keyboard layer (cyclic). */
  cycle(delta: 1 | -1, from = this.#active): symbol | undefined {
    const ids = this.ids();
    if (ids.length < 2) return from;
    const index = from ? ids.indexOf(from) : 0;
    return ids[(index + delta + ids.length) % ids.length];
  }

  remove(id: symbol): void {
    this.#tabs.get(id)?.tab.remove();
    this.#tabs.delete(id);
    if (this.#active === id) this.#active = undefined;
    this.#sync();
  }

  #sync(): void {
    // Unobtrusive for a single document.
    this.#strip.hidden = this.#tabs.size < 2;
  }
}
