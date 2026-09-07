import { createReaderKeyboard, ReaderCommand } from './keyboard';
import { DocumentSession, DocumentSessionError } from './document-session';
import { OutlineTree } from './outline';
import { NativeFileError, NativeFileHandle, readPdfFile, releasePdfFile, selectPdfFiles } from './native-files';
import { ReadingPrefs } from './prefs';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import './viewer-overrides.css';

const results = document.querySelector<HTMLUListElement>('#file-results')!;
const status = document.querySelector<HTMLElement>('footer')!;
const empty = document.querySelector<HTMLElement>('#empty-reader')!;
const reader = document.querySelector<HTMLElement>('#reader')!;
const outlinePanel = document.querySelector<HTMLElement>('#outline')!;
const documentList = document.querySelector<HTMLDialogElement>('#document-list')!;
const documentItems = document.querySelector<HTMLElement>('#document-items')!;
const dialog = document.querySelector<HTMLDialogElement>('#password-dialog')!;
const password = document.querySelector<HTMLInputElement>('#pdf-password')!;
const passwordMessage = document.querySelector<HTMLElement>('#password-message')!;
const commandBar = document.querySelector<HTMLElement>('#command-bar')!;
const commandInput = document.querySelector<HTMLInputElement>('#command-input')!;

interface SessionRecord {
  session: DocumentSession;
  name: string;
  /** Content hash (SHA-256 hex) — the persistence key, never a file path. */
  key: string;
  handle: NativeFileHandle;
  view: HTMLDivElement;
}

const prefs = new ReadingPrefs(globalThis.localStorage);
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
// ':clear-history' stops saving for this instance; a fresh launch starts
// recording again. Otherwise the beforeunload flush would resurrect the
// history of still-open sessions.
let persistenceEnabled = true;

function saveSnapshot(session: DocumentSession, key: string): void {
  if (!persistenceEnabled) return;
  const state = session.state();
  const pending = pendingSaves.get(key);
  if (pending !== undefined) {
    clearTimeout(pending);
    pendingSaves.delete(key);
  }
  prefs.putDocument(key, { page: state.pageNumber, zoom: session.zoomValue });
}

function scheduleSave(key: string, session: DocumentSession | undefined): void {
  if (!persistenceEnabled || !session || pendingSaves.has(key)) return;
  const timer = setTimeout(() => {
    pendingSaves.delete(key);
    if (session.isDisposed) return;
    saveSnapshot(session, key);
  }, 400);
  pendingSaves.set(key, timer);
}

async function contentKey(bytes: Uint8Array): Promise<string> {
  // Hash before PDF.js may detach the buffer; the key is content only.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function flushPendingSaves(): void {
  for (const timer of pendingSaves.values()) clearTimeout(timer);
  pendingSaves.clear();
}

const sessions = new Map<symbol, SessionRecord>();
let opening: symbol | undefined;
let abandoned: symbol | undefined;
let creating: symbol | undefined;
let active: SessionRecord | undefined;
let passwordReply: ((value: string | null) => void) | undefined;
let pendingKeys = '';

const outlineTree = new OutlineTree(document.querySelector<HTMLElement>('#outline-tree')!, {
  onActivate: node => {
    const record = active;
    if (!record) return;
    void record.session.navigateToDest(node.dest);
  },
});
let outlineVisible = false;

function toggleOutline(): void {
  if (!active) return;
  outlineVisible = !outlineVisible;
  outlinePanel.hidden = !outlineVisible;
  active.session.relayout();
  if (outlineVisible) void loadOutline();
}

async function loadOutline(): Promise<void> {
  const record = active;
  if (!record) return;
  const nodes = await record.session.outline();
  // A closed or replaced session must never repaint the sidebar.
  if (active !== record || !outlineVisible) return;
  outlineTree.setNodes(nodes);
}

// Restore the remembered status-bar visibility before any UI paints state.
status.hidden = prefs.statusBarHidden();

const keyboard = createReaderKeyboard({
  execute: runCommand,
  isReaderActive: () => active !== undefined && !dialog.open && !documentList.open,
  onPendingChange: pending => {
    pendingKeys = pending;
    renderStatus();
  },
});

function finishPassword(value: string | null): void {
  const reply = passwordReply;
  passwordReply = undefined;
  password.value = '';
  dialog.close();
  reply?.(value);
}

function renderStatus(): void {
  const state = active?.session.state();
  const base = active && state
    ? `${active.name} | Page ${state.pageNumber} of ${state.pageCount} | ${state.zoomLabel}`
    : 'No document open.';
  status.textContent = pendingKeys ? `${base} | Keys: ${pendingKeys}` : base;
}

function feedback(message: string): void {
  const item = document.createElement('li');
  item.textContent = message;
  results.append(item);
  results.hidden = false;
}

function sessionIds(): symbol[] {
  return [...sessions.keys()];
}

function neighborOf(id: symbol): symbol | undefined {
  const ids = sessionIds();
  const index = ids.indexOf(id);
  if (index === -1) return undefined;
  return ids[index + 1] ?? ids[index - 1];
}

function cycleSessions(delta: 1 | -1, from = active?.session.id): symbol | undefined {
  const ids = sessionIds();
  if (ids.length < 2) return from;
  const index = from ? ids.indexOf(from) : 0;
  return ids[(index + delta + ids.length) % ids.length];
}

function activateSession(id: symbol): void {
  const record = sessions.get(id);
  if (!record) return;
  for (const other of sessions.values()) other.view.classList.remove('active-view');
  record.view.classList.add('active-view');
  active = record;
  keyboard.reset();
  empty.hidden = true;
  reader.hidden = false;
  if (outlineVisible) void loadOutline();
  renderStatus();
}

function closeSession(id: symbol): void {
  const record = sessions.get(id);
  if (!record) return;
  // Select the neighbor before removing the session.
  const neighbor = neighborOf(id);
  sessions.delete(id);
  if (active?.session.id === id) active = undefined;
  // Persist the closing document's last page/zoom before teardown.
  saveSnapshot(record.session, record.key);
  void record.session.dispose();
  void releasePdfFile(record.handle).catch(() => {
    feedback('Could not release a closed document. Restart the app to clear native handles.');
  });
  record.view.remove();
  if (neighbor) {
    activateSession(neighbor);
  } else {
    resetReader();
  }
}

function resetReader(): void {
  for (const record of sessions.values()) {
    saveSnapshot(record.session, record.key);
    void record.session.dispose();
    void releasePdfFile(record.handle).catch(() => { /* Per-close feedback covers restart guidance. */ });
    record.view.remove();
  }
  sessions.clear();
  active = undefined;
  keyboard.reset();
  finishPassword(null);
  reader.replaceChildren();
  reader.hidden = true;
  empty.hidden = false;
  empty.focus();
  outlineVisible = false;
  outlinePanel.hidden = true;
  outlineTree.reset();
  hideCommandBar();
  renderStatus();
}

function closeActiveDocument(): void {
  // An explicit close also abandons a pending open request; its handles are
  // released when the in-flight selection resolves and observes staleness.
  if (opening) abandoned = opening;
  creating = undefined;
  opening = undefined;
  const closing = active?.session.id;
  if (closing !== undefined) {
    closeSession(closing);
  } else {
    resetReader();
  }
  (active?.view ?? empty).focus();
}

function runCommand(command: ReaderCommand): void {
  const record = active;
  if (!record) return;
  switch (command.type) {
    case 'scroll':
      record.view.scrollBy({ left: command.dx * 40, top: command.dy * 40 });
      break;
    case 'scroll-half':
      record.view.scrollBy({ top: command.dy * record.view.clientHeight / 2 });
      break;
    case 'scroll-page':
      record.view.scrollBy({ top: command.dy * record.view.clientHeight });
      break;
    case 'go': {
      const state = record.session.state();
      const page = command.page === 'first' ? 1
        : command.page === 'last' ? state.pageCount
        : command.page;
      if (!record.session.scrollToPage(page)) {
        feedback(`Page ${command.page} is out of range (1-${state.pageCount}).`);
      }
      break;
    }
    case 'zoom':
      record.session.zoom(command.action);
      renderStatus();
      break;
    case 'fit':
      record.session.zoom(command.mode === 'page' ? 'fit-page' : 'fit-width');
      renderStatus();
      break;
    case 'tab': {
      const target = cycleSessions(command.delta);
      if (target) activateSession(target);
      break;
    }
  }
}

function isOwnedHandle(handle: NativeFileHandle): boolean {
  return [...sessions.values()].some(record => record.handle === handle);
}

async function releaseUnowned(handles: NativeFileHandle[]): Promise<void> {
  // Only release handles this request owns; already-open ones belong to sessions.
  const owned = handles.filter(handle => !isOwnedHandle(handle));
  const settled = await Promise.allSettled(owned.map(handle => releasePdfFile(handle)));
  if (settled.some(result => result.status === 'rejected')) {
    feedback('Could not release an unused file. Restart the app to clear native handles.');
  }
}

async function openFiles(): Promise<void> {
  if (opening) return;
  const request = Symbol('open');
  opening = request;
  document.body.setAttribute('data-opening', 'busy');
  const previousStatus = status.textContent;
  let openedCount = 0;
  let lastError: string | undefined;
  const isCurrent = () => opening === request && abandoned !== request;
  try {
    status.textContent = 'Selecting PDFs...';
    const selection = await selectPdfFiles();
    if (!isCurrent()) {
      await releaseUnowned(selection.files.map(file => file.handle));
      return;
    }
    if (selection.cancelled) {
      if (status.textContent === 'Selecting PDFs...') status.textContent = previousStatus;
      return;
    }
    results.replaceChildren();
    results.hidden = true;
    for (const failure of selection.errors) {
      feedback(`Selection ${failure.selectionIndex + 1}: ${new NativeFileError(failure.error).message}`);
    }
    const files = selection.files;
    if (!files.length) {
      if (status.textContent === 'Selecting PDFs...') status.textContent = previousStatus;
      return;
    }
    // Lay the reader out before the first session exists: PDFViewer's render
    // queue only paints pages in a visible container.
    empty.hidden = true;
    reader.hidden = false;
    for (const [index, file] of files.entries()) {
      // Native identity dedup keeps one session per already-open file.
      const existing = file.alreadyOpen
        ? [...sessions.values()].find(record => record.handle === file.handle)
        : undefined;
      if (existing) {
        activateSession(existing.session.id);
        continue;
      }
      if (!isCurrent()) {
        await releaseUnowned(files.slice(index).map(entry => entry.handle));
        return;
      }
      status.textContent = `Loading ${file.name} (${index + 1} of ${files.length})...`;
      let bytes: Uint8Array;
      try {
        bytes = await readPdfFile(file.handle);
      } catch (error) {
        feedback(`${file.name}: ${error instanceof NativeFileError ? error.message : 'Could not read this document.'}`);
        lastError = error instanceof NativeFileError ? error.message : 'Could not read this document.';
        await releasePdfFile(file.handle).catch(() => { });
        continue;
      }
      if (!isCurrent()) {
        await releaseUnowned(files.slice(index).map(entry => entry.handle));
        return;
      }
      try {
        // The handle stays open for the session lifetime so duplicate
        // selections can focus this document instead of reopening it.
        const key = await contentKey(bytes);
        if (!isCurrent()) {
          await releaseUnowned(files.slice(index).map(entry => entry.handle));
          return;
        }
        await createSession(request, key, file.handle, file.name, bytes, openedCount === 0);
        openedCount += 1;
      } catch (error) {
        const message = error instanceof DocumentSessionError ? error.message : 'Could not open this document. Try another PDF.';
        await releasePdfFile(file.handle).catch(() => { });
        feedback(`${file.name}: ${message}`);
        lastError = message;
      }
    }
    if (!isCurrent()) return;
    if (!sessions.size) {
      resetReader();
      // A single failed selection surfaces its own error; aggregates stay generic.
      status.textContent = files.length === 1 && lastError ? lastError : 'No document could be opened.';
    } else {
      // The loop's last write was a loading status; restore the active view's.
      renderStatus();
    }
  } catch (error) {
    if (!isCurrent()) return;
    if (!sessions.size) resetReader();
    status.textContent = error instanceof NativeFileError || error instanceof DocumentSessionError
      ? error.message : 'Could not open this document. Try another PDF.';
  } finally {
    if (opening === request) {
      opening = undefined;
      if (document.body.getAttribute('data-opening') === 'busy') {
        document.body.removeAttribute('data-opening');
      }
    }
  }
}

async function createSession(request: symbol, key: string, handle: NativeFileHandle, name: string, bytes: Uint8Array, showNow: boolean): Promise<void> {
  const isCurrent = () => opening === request && abandoned !== request && creating === request;
  const view = document.createElement('div');
  view.className = 'session-view';
  view.tabIndex = -1;
  reader.append(view);
  creating = request;
  // Declared up-front: session callbacks fire during create() and must not
  // touch the binding before initialization (a TDZ throw would fail the load).
  let session: DocumentSession | undefined;
  try {
    session = await DocumentSession.create(view, bytes, {
      requestPassword: reason => new Promise(resolve => {
        if (!isCurrent()) { resolve(null); return; }
        passwordReply = resolve;
        password.value = '';
        passwordMessage.textContent = reason === 'incorrect' ? 'Incorrect password. Try again.' : "Enter this PDF's password.";
        dialog.showModal();
        password.focus();
      }),
      onState: () => {
        if (active?.session.id === session?.id) renderStatus();
        scheduleSave(key, session);
      },
      onNonfatalError: message => feedback(message),
    });
  } finally {
    if (creating === request) creating = undefined;
  }
  const record: SessionRecord = { session: session!, name, key, handle, view };
  sessions.set(session!.id, record);
  // Restore remembered reading position/zoom for this content before the
  // first paint of the tab; invalid stored values are ignored by the session.
  const remembered = prefs.document(key);
  if (remembered) {
    session.setZoomValue(remembered.zoom);
    session.scrollToPage(remembered.page);
  }
  if (showNow || sessions.size === 1) {
    activateSession(session!.id);
  }
}

document.querySelector<HTMLFormElement>('#password-form')!.addEventListener('submit', event => {
  event.preventDefault();
  finishPassword(password.value);
});
document.querySelector('#cancel-password')!.addEventListener('click', () => finishPassword(null));
dialog.addEventListener('cancel', event => { event.preventDefault(); finishPassword(null); });

function anyDialogOpen(): boolean {
  return dialog.open || documentList.open;
}

// On-demand document switcher (Ctrl+L): a modal list of open sessions with
// j/k or arrow movement, Enter to activate, click support, Escape to close.
let documentListIndex = 0;

function openDocumentList(): void {
  if (documentList.open || dialog.open || !active) return;
  const records = sessionIds().map(id => sessions.get(id)!);
  documentListIndex = Math.max(0, records.findIndex(record => record.session.id === active!.session.id));
  documentItems.replaceChildren(...records.map((record, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'document-item';
    option.setAttribute('role', 'option');
    option.textContent = record.name;
    option.addEventListener('click', () => chooseDocument(index));
    return option;
  }));
  documentList.showModal();
  highlightDocumentItem(documentListIndex);
}

function highlightDocumentItem(index: number): void {
  const options = [...documentItems.querySelectorAll<HTMLButtonElement>('.document-item')];
  documentListIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => {
    option.setAttribute('aria-selected', String(optionIndex === documentListIndex));
    option.classList.toggle('highlighted', optionIndex === documentListIndex);
  });
  options[documentListIndex]?.scrollIntoView({ block: 'nearest' });
}

function chooseDocument(index: number): void {
  const id = sessionIds()[index];
  documentList.close();
  if (id) activateSession(id);
}

documentList.addEventListener('keydown', event => {
  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault();
    highlightDocumentItem(documentListIndex + 1);
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault();
    highlightDocumentItem(documentListIndex - 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    chooseDocument(documentListIndex);
  }
});

// Zathura-style command mode: ':' opens the prompt, 'q' + Enter closes the
// current document. Unknown commands are nonfatal feedback.
function showCommandBar(): void {
  if (anyDialogOpen()) return;
  commandBar.hidden = false;
  commandInput.value = '';
  commandInput.focus();
}

function hideCommandBar(): void {
  commandBar.hidden = true;
  commandInput.value = '';
}

function runUserCommand(raw: string): void {
  const command = raw.trim();
  if (!command) return;
  if (command === 'q') {
    closeActiveDocument();
    return;
  }
  if (command === 'clear-history') {
    persistenceEnabled = false;
    for (const timer of pendingSaves.values()) clearTimeout(timer);
    pendingSaves.clear();
    prefs.clear();
    // Restore the cleared default so state and UI agree immediately.
    status.hidden = false;
    feedback('Reading history cleared.');
    return;
  }
  feedback(`Unknown command: ${command}`);
}

commandInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const value = commandInput.value;
    hideCommandBar();
    runUserCommand(value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    hideCommandBar();
  }
});
commandInput.addEventListener('blur', () => hideCommandBar());
window.addEventListener('blur', () => keyboard.reset());
window.addEventListener('beforeunload', () => {
  // Flush debounced per-document saves so a normal window close keeps the
  // last page/zoom.
  for (const record of sessions.values()) saveSnapshot(record.session, record.key);
  flushPendingSaves();
});
document.addEventListener('keydown', event => {
  if (anyDialogOpen()) return;
  if ((event.ctrlKey !== event.metaKey) && !event.altKey && !event.shiftKey
      && !event.isComposing && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    if (!event.repeat) void openFiles();
    return;
  }
  if ((event.ctrlKey !== event.metaKey) && !event.altKey && !event.shiftKey
      && !event.isComposing && !event.repeat && event.key.toLowerCase() === 'l') {
    // On-demand document switcher.
    event.preventDefault();
    openDocumentList();
    return;
  }
  if (event.key === ':' && !event.ctrlKey && !event.metaKey && !event.altKey
      && !event.isComposing && !event.repeat) {
    event.preventDefault();
    showCommandBar();
    return;
  }
  if ((event.ctrlKey !== event.metaKey) && !event.altKey && !event.shiftKey
      && !event.isComposing && !event.repeat && event.key.toLowerCase() === 'n') {
    // Full-bleed reading: toggle the status bar.
    event.preventDefault();
    status.hidden = !status.hidden;
    prefs.setStatusBarHidden(status.hidden);
    return;
  }
  const target = event.target;
  const editable = target instanceof HTMLElement
    && target.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey
      && !event.isComposing && !event.repeat && active && !editable) {
    // From reading context, Tab toggles the outline sidebar; dialogs and
    // editable fields keep ordinary focus traversal.
    event.preventDefault();
    toggleOutline();
    return;
  }
  if (keyboard.handle(event) === 'handled') event.preventDefault();
});
