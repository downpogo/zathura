import { createReaderKeyboard, ReaderCommand } from './keyboard';
import { DocumentSession, DocumentSessionError } from './document-session';
import { NativeFileError, NativeFileHandle, readPdfFile, releasePdfFile, selectPdfFiles } from './native-files';
import { TabStrip } from './tabs';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import './viewer-overrides.css';

const openButton = document.querySelector<HTMLButtonElement>('#open-files')!;
const header = document.querySelector<HTMLElement>('header')!;
const results = document.querySelector<HTMLUListElement>('#file-results')!;
const status = document.querySelector<HTMLElement>('footer')!;
const empty = document.querySelector<HTMLElement>('#empty-reader')!;
const reader = document.querySelector<HTMLElement>('#reader')!;
const tabStripElement = document.querySelector<HTMLElement>('#tab-strip')!;
const dialog = document.querySelector<HTMLDialogElement>('#password-dialog')!;
const password = document.querySelector<HTMLInputElement>('#pdf-password')!;
const passwordMessage = document.querySelector<HTMLElement>('#password-message')!;
const commandBar = document.querySelector<HTMLElement>('#command-bar')!;
const commandInput = document.querySelector<HTMLInputElement>('#command-input')!;

interface SessionRecord {
  session: DocumentSession;
  name: string;
  handle: NativeFileHandle;
  view: HTMLDivElement;
}

const sessions = new Map<symbol, SessionRecord>();
let opening: symbol | undefined;
let abandoned: symbol | undefined;
let creating: symbol | undefined;
let active: SessionRecord | undefined;
let passwordReply: ((value: string | null) => void) | undefined;
let pendingKeys = '';

const tabs = new TabStrip(tabStripElement, {
  onActivate: id => activateSession(id),
  onClose: id => closeSession(id),
});

const keyboard = createReaderKeyboard({
  execute: runCommand,
  isReaderActive: () => active !== undefined && !dialog.open,
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

function activateSession(id: symbol): void {
  const record = sessions.get(id);
  if (!record) return;
  for (const other of sessions.values()) other.view.classList.remove('active-view');
  record.view.classList.add('active-view');
  tabs.activate(id);
  active = record;
  keyboard.reset();
  empty.hidden = true;
  reader.hidden = false;
  renderStatus();
}

function closeSession(id: symbol): void {
  const record = sessions.get(id);
  if (!record) return;
  // Select the neighbor before removing the tab from the strip.
  const neighbor = tabs.neighborOf(id);
  sessions.delete(id);
  tabs.remove(id);
  if (active?.session.id === id) active = undefined;
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
  header.hidden = false;
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
  openButton.disabled = false;
  openButton.focus();
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
      const target = tabs.cycle(command.delta);
      if (target) activateSession(target);
      break;
    }
  }
}

function isOwnedHandle(handle: NativeFileHandle): boolean {
  return [...sessions.values()].some(record => record.handle === handle);
}

async function releaseUnowned(handles: NativeFileHandle[]): Promise<void> {
  // Only release handles this request owns; already-open ones belong to tabs.
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
  openButton.disabled = true;
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
    // queue only paints pages in a visible container. The picker button is
    // only for the empty state; Ctrl+O opens more documents.
    empty.hidden = true;
    reader.hidden = false;
    header.hidden = true;
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
        await createSession(request, file.handle, file.name, bytes, openedCount === 0);
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
      openButton.disabled = false;
    }
  }
}

async function createSession(request: symbol, handle: NativeFileHandle, name: string, bytes: Uint8Array, showNow: boolean): Promise<void> {
  const isCurrent = () => opening === request && abandoned !== request && creating === request;
  const view = document.createElement('div');
  view.className = 'session-view';
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
      },
      onNonfatalError: message => feedback(message),
    });
  } finally {
    if (creating === request) creating = undefined;
  }
  const record: SessionRecord = { session: session!, name, handle, view };
  sessions.set(session!.id, record);
  tabs.add(session!.id, name);
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

// Zathura-style command mode: ':' opens the prompt, 'q' + Enter closes the
// current document. Unknown commands are nonfatal feedback.
function showCommandBar(): void {
  if (dialog.open) return;
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
openButton.addEventListener('click', () => { void openFiles(); });
window.addEventListener('blur', () => keyboard.reset());
document.addEventListener('keydown', event => {
  if (dialog.open) return;
  if ((event.ctrlKey !== event.metaKey) && !event.altKey && !event.shiftKey
      && !event.isComposing && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    if (!event.repeat) void openFiles();
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
    return;
  }
  if (keyboard.handle(event) === 'handled') event.preventDefault();
});
