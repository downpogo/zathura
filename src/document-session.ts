import { AnnotationMode, getDocument, PasswordResponses, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';

export type ZoomRequest = 'in' | 'out' | 'reset' | 'fit-width' | 'fit-page';

export interface SessionState {
  readonly pageCount: number;
  /** One-based physical page number. */
  readonly pageNumber: number;
  readonly zoomLabel: string;
}

/** Embedded document outline; `dest` feeds navigateToDest, titles are untrusted text. */
export interface OutlineNode {
  readonly title: string;
  readonly dest: unknown;
  readonly children: readonly OutlineNode[];
}

export interface SessionHooks {
  readonly requestPassword: (reason: 'required' | 'incorrect') => Promise<string | null>;
  readonly onState: (state: SessionState) => void;
  readonly onNonfatalError: (message: string) => void;
}

export class DocumentSessionError extends Error {
  readonly code: 'cancelled' | 'load_failed';

  constructor(code: 'cancelled' | 'load_failed') {
    super(code === 'cancelled' ? 'Document opening cancelled.' : 'Could not render this document.');
    this.name = 'DocumentSessionError';
    this.code = code;
  }
}

type ScrollOptions = NonNullable<Parameters<PDFViewer['scrollPageIntoView']>[0]>;
type ExplicitDest = NonNullable<ScrollOptions['destArray']>;

interface ViewerL10n {
  get(key: string, args?: Record<string, unknown> | null): Promise<string>;
  translate(element: HTMLElement): Promise<void>;
  pause(): void;
  resume(): void;
}

// Upstream GenericL10n fetches locale resources. This reader ships English-only
// shell strings, so provide a fetch-free localizer instead. Page content keeps
// its own embedded fonts and text; these strings only back viewer aria text.
const viewerL10n: ViewerL10n = {
  async get() { return ''; },
  async translate() { /* Shell markup carries its own accessible labels. */ },
  pause() { },
  resume() { },
};

/**
 * Upstream PDFLinkService logs rejected destination names and page references
 * through the console. Destinations are untrusted PDF content and must not be
 * logged, so resolve them here with safe nonfatal feedback instead.
 */
class ReaderLinkService extends PDFLinkService {
  readonly #onInvalidDestination: () => void;

  constructor(eventBus: EventBus, onInvalidDestination: () => void) {
    super({ eventBus });
    this.externalLinkEnabled = false;
    this.#onInvalidDestination = onInvalidDestination;
  }

  override async goToDestination(dest: unknown): Promise<void> {
    const pdf = this.pdfDocument;
    if (!pdf) return;
    let explicit: unknown;
    try {
      explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : await dest;
    } catch {
      explicit = null;
    }
    const page = await ReaderLinkService.resolveDestPage(pdf, explicit);
    if (page === null) {
      this.#onInvalidDestination();
      return;
    }
    this.pdfViewer?.scrollPageIntoView({
      pageNumber: page,
      destArray: explicit as ExplicitDest,
      ignoreDestinationZoom: this['_ignoreDestinationZoom'] === true,
    });
  }

  static async resolveDestPage(pdf: {
    cachedPageNumber(reference: unknown): number | null;
    getPageIndex(reference: unknown): Promise<number>;
  }, explicit: unknown): Promise<number | null> {
    if (!Array.isArray(explicit) || explicit.length < 2) return null;
    const [reference] = explicit;
    let page: number | null = null;
    if (reference && typeof reference === 'object') {
      try {
        const cached = pdf.cachedPageNumber(reference);
        page = typeof cached === 'number' && Number.isInteger(cached) && cached > 0 ? cached : null;
      } catch {
        page = null;
      }
      if (page === null) {
        try {
          page = (await pdf.getPageIndex(reference)) + 1;
        } catch {
          page = null;
        }
      }
    } else if (Number.isInteger(reference)) {
      page = (reference as number) + 1;
    }
    return page !== null && page > 0 ? page : null;
  }
}

/** One continuous document per session. Await disposal before closing over the container. */
export class DocumentSession {
  readonly id = Symbol('document-session');
  private readonly container: HTMLElement;
  private readonly hooks: SessionHooks;
  private worker?: Worker;
  private pdfWorker?: PDFWorker;
  private loadingTask?: PDFDocumentLoadingTask;
  private pdf?: PDFDocumentProxy;
  private pdfViewer?: PDFViewer;
  private viewerDiv?: HTMLDivElement;
  private readonly abort = new AbortController();
  private disposed = false;
  private disposal?: Promise<void>;
  private rejectPending!: (error: DocumentSessionError) => void;
  private readonly interrupted = new Promise<never>((_resolve, reject) => { this.rejectPending = reject; });
  private passwordReply?: (password: string | Error) => void;
  private pageCount = 0;

  private constructor(container: HTMLDivElement, hooks: SessionHooks) {
    this.container = container;
    this.hooks = hooks;
    void this.interrupted.catch(() => { /* Abandoned sessions observe their own rejection. */ });
  }

  static async create(container: HTMLDivElement, data: Uint8Array, hooks: SessionHooks): Promise<DocumentSession> {
    const session = new DocumentSession(container, hooks);
    await session.open(data);
    return session;
  }

  private async open(data: Uint8Array): Promise<void> {
    try {
      if (this.disposed) throw new DocumentSessionError('cancelled');
      this.worker = new Worker(workerUrl, { type: 'module' });
      this.worker.addEventListener('error', this.workerFailed);
      this.worker.addEventListener('messageerror', this.workerFailed);
      this.pdfWorker = PDFWorker.create({ port: this.worker, verbosity: 0 });
      const loadingTask = getDocument({
        data,
        worker: this.pdfWorker,
        cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
        wasmUrl: new URL('pdfjs/wasm/', document.baseURI).href,
        iccUrl: new URL('pdfjs/iccs/', document.baseURI).href,
        // pdf.js v6 no longer reads isEvalSupported; eval is not used by the
        // pinned display/worker sources and `wasm-unsafe-eval` covers decoding.
        useSystemFonts: false,
        enableXfa: false,
        verbosity: 0,
      });
      this.loadingTask = loadingTask;
      loadingTask.onPassword = (updatePassword: (password: string | Error) => void, reason: number) => {
        if (this.disposed) {
          updatePassword(new DocumentSessionError('cancelled'));
          return;
        }
        this.passwordReply = updatePassword;
        void Promise.resolve().then(() => {
          if (this.disposed) return null;
          return this.hooks.requestPassword(reason === PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'required');
        }).then(password => {
          if (this.disposed || this.passwordReply !== updatePassword) return;
          if (password === null) {
            void this.dispose();
          } else {
            this.passwordReply = undefined;
            updatePassword(password);
          }
        }).catch(() => {
          if (!this.disposed) {
            this.rejectPending(new DocumentSessionError('load_failed'));
            void this.dispose();
          }
        });
      };
      const pdf = await Promise.race([loadingTask.promise, this.interrupted]);
      if (this.disposed) throw new DocumentSessionError('cancelled');
      this.pdf = pdf;
      this.pageCount = pdf.numPages;
      window.addEventListener('resize', this.#onWindowResize, { signal: this.abort.signal });

      const eventBus = new EventBus();
      eventBus.on('pagechanging', () => { if (!this.disposed) this.hooks.onState(this.state()); });
      eventBus.on('scalechanging', () => { if (!this.disposed) this.hooks.onState(this.state()); });

      this.viewerDiv = document.createElement('div');
      this.viewerDiv.className = 'pdfViewer';
      this.container.append(this.viewerDiv);
      const linkService = this.linkService(eventBus);
      // `abortSignal` is consumed by the runtime but missing from the published
      // options type; the cast keeps the documented teardown wiring.
      const viewerOptions = {
        container: this.container,
        viewer: this.viewerDiv,
        eventBus,
        linkService,
        annotationMode: AnnotationMode.ENABLE,
        enableAutoLinking: false,
        // Full-bleed reading: fit-width/fit-page use the whole viewport and
        // page chrome (borders/margins) is dropped.
        removePageBorders: true,
        maxCanvasPixels: 8_000_000,
        maxCanvasDim: 8_192,
        l10n: viewerL10n,
        abortSignal: this.abort.signal,
      } as unknown as ConstructorParameters<typeof PDFViewer>[0];
      const pdfViewer = new PDFViewer(viewerOptions);
      this.pdfViewer = pdfViewer;
      // Annotation-layer links resolve through the link service, so it needs
      // both the document and the viewer before any click can navigate.
      linkService.setDocument(pdf);
      linkService.setViewer(pdfViewer);
      // pagesinit dispatches during setDocument; listen before awaiting it.
      const pagesReady = new Promise<void>(resolve => {
        eventBus.on('pagesinit', () => resolve(), { once: true });
      });
      await Promise.race([pdfViewer.setDocument(pdf), this.interrupted]);
      if (this.disposed) throw new DocumentSessionError('cancelled');
      await Promise.race([pagesReady, this.interrupted]);
      if (this.disposed) throw new DocumentSessionError('cancelled');
      // Deterministic starting point: physical page 1 at 100%.
      pdfViewer.currentScaleValue = 'page-actual';
      this.hooks.onState(this.state());
    } catch (error) {
      const safeError = error instanceof DocumentSessionError ? error : new DocumentSessionError('load_failed');
      await this.dispose();
      throw safeError;
    }
  }

  private linkService(eventBus: EventBus): PDFLinkService {
    return new ReaderLinkService(eventBus, () => {
      if (!this.disposed) this.hooks.onNonfatalError('This destination is not available.');
    });
  }

  private readonly workerFailed = (event: Event): void => {
    event.preventDefault();
    this.rejectPending(new DocumentSessionError('load_failed'));
    void this.dispose();
  };

  state(): SessionState {
    return {
      pageCount: this.pageCount,
      pageNumber: this.pdfViewer?.currentPageNumber ?? 1,
      zoomLabel: DocumentSession.zoomLabel(this.pdfViewer),
    };
  }

  static zoomLabel(pdfViewer: PDFViewer | undefined): string {
    const value = pdfViewer?.currentScaleValue;
    switch (value) {
      case 'page-actual': return '100%';
      case 'page-width': return 'Fit width';
      case 'page-fit': return 'Fit page';
      case 'page-height': return 'Fit height';
      case 'auto': return 'Auto';
      default: return `${Math.round((pdfViewer?.currentScale ?? 1) * 100)}%`;
    }
  }

  /** One-based physical page jump with bounds validation. */
  scrollToPage(page: number): boolean {
    if (!Number.isInteger(page) || page < 1 || page > this.pageCount) return false;
    this.pdfViewer?.scrollPageIntoView({ pageNumber: page });
    return true;
  }

  /** Direct or named destination; broken input is nonfatal feedback, never a crash. */
  async navigateToDest(dest: unknown): Promise<boolean> {
    const pdf = this.pdf;
    if (!pdf || this.disposed) return false;
    let explicit: unknown;
    try {
      explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : await dest;
    } catch {
      explicit = null;
    }
    if (this.disposed) return false;
    const page = await ReaderLinkService.resolveDestPage(pdf, explicit);
    if (this.disposed) return false;
    if (page === null) {
      this.hooks.onNonfatalError('This destination is not available.');
      return false;
    }
    this.pdfViewer?.scrollPageIntoView({
      pageNumber: page,
      destArray: explicit as ExplicitDest,
      ignoreDestinationZoom: false,
    });
    return true;
  }

  /** Embedded outline of the active document; failures are empty, never thrown. */
  async outline(): Promise<readonly OutlineNode[]> {
    const pdf = this.pdf;
    if (!pdf || this.disposed) return [];
    let items: unknown;
    try {
      items = await pdf.getOutline();
    } catch {
      return [];
    }
    if (this.disposed) return [];
    return DocumentSession.mapOutlineItems(items);
  }

  private static mapOutlineItems(items: unknown): readonly OutlineNode[] {
    if (!Array.isArray(items)) return [];
    return items.filter(item => item && typeof item === 'object').map(item => {
      const record = item as { title?: unknown; dest?: unknown; items?: unknown; url?: unknown };
      return {
        // External URL entries are never navigable in this reader; only dest
        // matters, and titles are rendered as text by the UI layer.
        title: typeof record.title === 'string' ? record.title : '',
        dest: record.dest ?? null,
        children: DocumentSession.mapOutlineItems(record.items),
      };
    });
  }

  /** Reapply fit presets after container-layout changes (e.g. the sidebar). */
  relayout(): void {
    this.#onWindowResize();
  }

  zoom(request: ZoomRequest): void {
    const pdfViewer = this.pdfViewer;
    if (!pdfViewer || this.disposed) return;
    switch (request) {
      case 'in': pdfViewer.increaseScale(); break;
      case 'out': pdfViewer.decreaseScale(); break;
      case 'reset': pdfViewer.currentScaleValue = 'page-actual'; break;
      case 'fit-width': pdfViewer.currentScaleValue = 'page-width'; break;
      case 'fit-page': pdfViewer.currentScaleValue = 'page-fit'; break;
    }
  }

  // PDFViewer does not observe window resize itself; reapply fit presets so
  // they track viewport changes, including future sidebar layout changes.
  readonly #onWindowResize = (): void => {
    const viewer = this.pdfViewer;
    const value = viewer?.currentScaleValue;
    if (viewer && (value === 'page-width' || value === 'page-fit' || value === 'page-height' || value === 'auto')) {
      viewer.currentScaleValue = value;
    }
  };

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.rejectPending(new DocumentSessionError('cancelled'));
    this.disposal = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.passwordReply?.(new DocumentSessionError('cancelled'));
        this.passwordReply = undefined;
        this.abort.abort();
        this.pdfViewer?.cleanup();
        // PDF.js destroy waits for worker replies; terminate after a bounded
        // grace period if a dead worker cannot acknowledge them.
        await Promise.race([
          Promise.allSettled([this.loadingTask?.destroy()]),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
        ]);
      } catch {
        // Cleanup failures must not expose document details or block teardown.
      } finally {
        clearTimeout(timer);
        try { this.pdfWorker?.destroy(); } catch { /* Still terminate the real worker. */ }
        this.worker?.removeEventListener('error', this.workerFailed);
        this.worker?.removeEventListener('messageerror', this.workerFailed);
        this.worker?.terminate();
        this.viewerDiv?.remove();
        this.viewerDiv = undefined;
        this.pdfViewer = undefined;
        this.pdf = undefined;
        this.loadingTask = undefined;
        this.pdfWorker = undefined;
        this.worker = undefined;
        this.passwordReply = undefined;
      }
    });
    return this.disposal;
  }
}
