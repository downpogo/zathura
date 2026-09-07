export interface DocumentReadingState {
  /** One-based physical page. */
  page: number;
  /** PDF.js scale value: a preset name or a numeric string. */
  zoom: string;
}

export interface ReadingState {
  statusBarHidden: boolean;
  documents: Record<string, DocumentReadingState>;
}

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PREFERENCES_KEY = 'zathura.reading-state.v1';
const MAX_DOCUMENTS = 512;
const MAX_KEY_LENGTH = 64;
const MAX_ZOOM_LENGTH = 16;
const MAX_PAGE = 1_000_000;

const EMPTY: ReadingState = { statusBarHidden: false, documents: {} };

function sanitize(raw: string | null): ReadingState {
  if (!raw) return { ...EMPTY, documents: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt settings recover to defaults; nothing crashes.
    return { ...EMPTY, documents: {} };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY, documents: {} };
  const candidate = parsed as Partial<ReadingState>;
  const documents: Record<string, DocumentReadingState> = {};
  if (candidate.documents && typeof candidate.documents === 'object') {
    for (const [key, value] of Object.entries(candidate.documents)) {
      if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
      const entry = value as Partial<DocumentReadingState> | null;
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.page !== 'number' || !Number.isInteger(entry.page)
        || entry.page < 1 || entry.page > MAX_PAGE) continue;
      if (typeof entry.zoom !== 'string' || entry.zoom.length === 0 || entry.zoom.length > MAX_ZOOM_LENGTH) continue;
      documents[key] = { page: entry.page, zoom: entry.zoom };
    }
  }
  return { statusBarHidden: candidate.statusBarHidden === true, documents };
}

/**
 * Reading preferences in a small versioned JSON blob. Keys are content
 * hashes, never file paths; passwords and PDF contents are never stored.
 */
export class ReadingPrefs {
  readonly #storage: PrefsStorage;

  constructor(storage: PrefsStorage) {
    this.#storage = storage;
  }

  load(): ReadingState {
    let raw: string | null = null;
    try {
      raw = this.#storage.getItem(PREFERENCES_KEY);
    } catch {
      // Storage IO failures recover to defaults.
      return { ...EMPTY, documents: {} };
    }
    return sanitize(raw);
  }

  #write(state: ReadingState): void {
    try {
      const keys = Object.keys(state.documents);
      if (keys.length > MAX_DOCUMENTS) {
        // Evict the oldest entries (insertion order) beyond the cap.
        for (const key of keys.slice(0, keys.length - MAX_DOCUMENTS)) {
          delete state.documents[key];
        }
      }
      this.#storage.setItem(PREFERENCES_KEY, JSON.stringify(state));
    } catch {
      // Persistence is best effort; the reader works without it.
    }
  }

  statusBarHidden(): boolean {
    return this.load().statusBarHidden;
  }

  setStatusBarHidden(hidden: boolean): void {
    const state = this.load();
    state.statusBarHidden = hidden;
    this.#write(state);
  }

  document(key: string): DocumentReadingState | undefined {
    return this.load().documents[key];
  }

  putDocument(key: string, state: DocumentReadingState): void {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return;
    if (typeof state.page !== 'number' || !Number.isInteger(state.page)
      || state.page < 1 || state.page > MAX_PAGE) return;
    if (typeof state.zoom !== 'string' || state.zoom.length === 0 || state.zoom.length > MAX_ZOOM_LENGTH) return;
    const current = this.load();
    current.documents[key] = { page: state.page, zoom: state.zoom };
    this.#write(current);
  }

  clear(): void {
    try {
      this.#storage.removeItem(PREFERENCES_KEY);
    } catch { /* Best effort. */ }
  }
}
