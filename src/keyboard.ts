/**
 * CORE-07 keyboard parser: classifies keydown events into reader commands.
 *
 * Classification only. `handle` never calls `preventDefault` or
 * `stopPropagation`. The dispatcher owns the single DOM keydown listener and
 * suppresses the webview default exactly for events classified `'handled'`;
 * everything classified `'ignored'` keeps its default so native picker
 * shortcuts, OS shortcuts, and text editing keep working. This keeps one
 * dispatch path shared with UI actions and lets the parser run without a DOM.
 *
 * Repeat keydowns (`event.repeat`) behave like fresh presses: held h/j/k/l and
 * Ctrl+D/U/F/B repeat their scroll commands naturally, held digits keep
 * accumulating into the pending count until the 9-digit cap, and held sequence
 * keys re-enter or complete their sequence deterministically. keyup events are
 * ignored entirely.
 */

export type ReaderCommand =
  | { type: 'scroll'; dx: -1 | 0 | 1; dy: -1 | 0 | 1 }
  | { type: 'scroll-half'; dy: 1 | -1 }
  | { type: 'scroll-page'; dy: 1 | -1 }
  | { type: 'go'; page: number | 'first' | 'last' }
  | { type: 'zoom'; action: 'in' | 'out' | 'reset' }
  | { type: 'fit'; mode: 'page' | 'width' }
  | { type: 'tab'; delta: 1 | -1 };

export interface ReaderKeyboardHooks {
  execute(command: ReaderCommand): void;
  /** False while a dialog owns input or the reader has no document. */
  isReaderActive(): boolean;
  /** Pending sequence display (e.g. '1', '1g', ''); '' when none. */
  onPendingChange(pending: string): void;
}

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
const COUNT_LIMIT = 9;

export function createReaderKeyboard(hooks: ReaderKeyboardHooks): {
  handle(event: KeyboardEvent): 'handled' | 'ignored';
  /** Reset pending state (focus loss, document switch). Fires onPendingChange(''). */
  reset(): void;
} {
  let pending = '';

  const setPending = (value: string): void => {
    pending = value;
    hooks.onPendingChange(value);
  };

  const isPlain = (event: KeyboardEvent): boolean =>
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

  const isCtrlOnly = (event: KeyboardEvent): boolean =>
    event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

  const isDigit = (key: string): boolean => key >= '0' && key <= '9' && key.length === 1;

  const isEditableTarget = (target: EventTarget | null): boolean => {
    const element = target as { closest?: (selector: string) => unknown } | null;
    if (typeof element?.closest !== 'function') return false;
    return element.closest(EDITABLE_SELECTOR) !== null;
  };

  const handle = (event: KeyboardEvent): 'handled' | 'ignored' => {
    if (event.type !== 'keydown') return 'ignored';
    if (event.isComposing || event.keyCode === 229) return 'ignored';
    if (isEditableTarget(event.target)) return 'ignored';

    if (event.key === 'Escape') {
      if (pending !== '') {
        setPending('');
        return 'handled';
      }
      return 'ignored';
    }

    if (!hooks.isReaderActive()) return 'ignored';

    // A completed command clears the pending sequence before dispatch so the
    // status bar observes onPendingChange('') ahead of the command itself.
    const complete = (command: ReaderCommand): 'handled' => {
      if (pending !== '') setPending('');
      hooks.execute(command);
      return 'handled';
    };

    const key = event.key;

    if (pending.endsWith('g')) {
      // Bare 'g' or digits+'g' awaits its second key; everything else cancels.
      if (key === 'g' && isPlain(event)) {
        const digits = pending.slice(0, -1);
        return complete({ type: 'go', page: digits === '' ? 'first' : Number(digits) });
      }
      if (key === 't' && isPlain(event)) {
        return complete({ type: 'tab', delta: 1 });
      }
      if (key === 'T' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        return complete({ type: 'tab', delta: -1 });
      }
      setPending('');
      return 'ignored';
    }

    if (pending !== '') {
      // Digits pending: extend, close with g/G, or cancel on anything else.
      if (isDigit(key) && isPlain(event)) {
        if (pending.length < COUNT_LIMIT) setPending(pending + key);
        return 'ignored';
      }
      if (key === 'g' && isPlain(event)) {
        setPending(pending + 'g');
        return 'ignored';
      }
      if (key === 'G' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Leading zeros are not special-cased here; page 0 and other invalid
        // targets reach execute and are rejected by the bounds check later.
        return complete({ type: 'go', page: Number(pending) });
      }
      setPending('');
      return 'ignored';
    }

    if (isDigit(key) && isPlain(event)) {
      setPending(key);
      return 'ignored';
    }

    switch (key) {
      case 'g':
        if (isPlain(event)) setPending('g');
        return 'ignored';
      case 'G':
        if (!event.ctrlKey && !event.metaKey && !event.altKey) {
          return complete({ type: 'go', page: 'last' });
        }
        break;
      case 'h':
        if (isPlain(event)) return complete({ type: 'scroll', dx: -1, dy: 0 });
        break;
      case 'j':
        if (isPlain(event)) return complete({ type: 'scroll', dx: 0, dy: 1 });
        break;
      case 'k':
        if (isPlain(event)) return complete({ type: 'scroll', dx: 0, dy: -1 });
        break;
      case 'l':
        if (isPlain(event)) return complete({ type: 'scroll', dx: 1, dy: 0 });
        break;
      case 'a':
        if (isPlain(event)) return complete({ type: 'fit', mode: 'page' });
        break;
      case 's':
        if (isPlain(event)) return complete({ type: 'fit', mode: 'width' });
        break;
      case '+':
        // US layouts produce '+' via Shift+'='; classify by event.key only.
        if (!event.ctrlKey && !event.metaKey && !event.altKey) {
          return complete({ type: 'zoom', action: 'in' });
        }
        break;
      case '-':
        if (isPlain(event)) return complete({ type: 'zoom', action: 'out' });
        break;
      case '=':
        if (isPlain(event)) return complete({ type: 'zoom', action: 'reset' });
        break;
      case 'd':
        if (isCtrlOnly(event)) return complete({ type: 'scroll-half', dy: 1 });
        break;
      case 'u':
        if (isCtrlOnly(event)) return complete({ type: 'scroll-half', dy: -1 });
        break;
      case 'f':
        if (isCtrlOnly(event)) return complete({ type: 'scroll-page', dy: 1 });
        break;
      case 'b':
        if (isCtrlOnly(event)) return complete({ type: 'scroll-page', dy: -1 });
        break;
    }
    return 'ignored';
  };

  return {
    handle,
    reset(): void {
      if (pending !== '') setPending('');
    },
  };
}
