// Lifecycle doubles only: these do not parse PDFs, paint pixels or run a worker.
export const AnnotationMode = { DISABLE: 0, ENABLE: 1 };
export const PasswordResponses = { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 };
export const workerUrl = 'stub://pdf.worker.mjs';
export default workerUrl;

export const stub = {
  numPages: 5,
  pdfOutline: undefined,
  destinations: new Map(),
  cachedPageNumbers: new Map(),
  pageIndexes: new Map(),
  loadingTaskFactory: null,
  destroyNeverSettles: false,
  getDocumentOptions: [],
  pdfs: [],
  loadingTasks: [],
  pdfWorkerCreates: [],
  workers: [],
  eventBuses: [],
  viewers: [],
  linkServices: [],
  scaleValueSets: [],
  destroyCalls: [],
  windowListeners: [],
  createdElements: [],
};

export function resetStub() {
  stub.numPages = 5;
  stub.pdfOutline = undefined;
  stub.destinations = new Map();
  stub.cachedPageNumbers = new Map();
  stub.pageIndexes = new Map();
  stub.loadingTaskFactory = null;
  stub.destroyNeverSettles = false;
  for (const key of ['getDocumentOptions', 'pdfs', 'loadingTasks', 'pdfWorkerCreates', 'workers', 'eventBuses', 'viewers', 'linkServices', 'scaleValueSets', 'destroyCalls', 'windowListeners', 'createdElements']) {
    stub[key] = [];
  }
}

export class FakeWorker {
  constructor(url, options) {
    this.url = url;
    this.type = options?.type;
    this.listeners = new Map();
    this.terminated = false;
    stub.workers.push(this);
  }

  addEventListener(name, listener) {
    const list = this.listeners.get(name) ?? new Set();
    list.add(listener);
    this.listeners.set(name, list);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, event = { preventDefault() { } }) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }

  terminate() {
    this.terminated = true;
  }
}

export class FakeEventBus {
  constructor() {
    this.handlers = new Map();
    stub.eventBuses.push(this);
  }

  on(name, handler, options) {
    const list = this.handlers.get(name) ?? [];
    list.push({ handler, once: options?.once === true });
    this.handlers.set(name, list);
  }

  off(name, handler) {
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter(entry => entry.handler !== handler));
  }

  dispatch(name, event) {
    const remaining = (this.handlers.get(name) ?? []).filter(entry => {
      entry.handler(event);
      return !entry.once;
    });
    this.handlers.set(name, remaining);
  }
}

export class FakePDFLinkService {
  constructor(options) {
    this.eventBus = options?.eventBus;
    this.externalLinkEnabled = true;
    this._ignoreDestinationZoom = false;
    this.documents = [];
    this.viewers = [];
    stub.linkServices.push(this);
  }

  setDocument(pdf) {
    this.documents.push(pdf);
  }

  setViewer(viewer) {
    this.viewers.push(viewer);
  }
}

export class FakePDFViewer {
  constructor(options) {
    Object.assign(this, options);
    this._currentScaleValue = undefined;
    this._currentScale = 1;
    this.currentPageNumber = 1;
    this.setDocumentCalls = [];
    this.scrollCalls = [];
    this.cleanupCalls = 0;
    this.increaseCalls = 0;
    this.decreaseCalls = 0;
    stub.viewers.push(this);
  }

  get currentScaleValue() {
    return this._currentScaleValue;
  }

  set currentScaleValue(value) {
    this._currentScaleValue = value;
    stub.scaleValueSets.push({ viewer: this, value });
  }

  get currentScale() {
    return this._currentScale;
  }

  set currentScale(value) {
    this._currentScale = value;
  }

  async setDocument(pdf) {
    this.setDocumentCalls.push(pdf);
    this.eventBus.dispatch('pagesinit');
  }

  cleanup() {
    this.cleanupCalls += 1;
  }

  increaseScale() {
    this.increaseCalls += 1;
  }

  decreaseScale() {
    this.decreaseCalls += 1;
  }

  scrollPageIntoView(options) {
    this.scrollCalls.push(options);
  }
}

export { FakeEventBus as EventBus, FakePDFLinkService as PDFLinkService, FakePDFViewer as PDFViewer };

export const PDFWorker = {
  create(options) {
    const pdfWorker = {
      port: options?.port,
      verbosity: options?.verbosity,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    stub.pdfWorkerCreates.push(pdfWorker);
    return pdfWorker;
  },
};

function makePdf() {
  const pdf = {
    numPages: stub.numPages,
    getOutlineCalls: 0,
    getOutline: async () => {
      pdf.getOutlineCalls += 1;
      const value = stub.pdfOutline;
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    getDestinationCalls: [],
    getDestination: async name => {
      pdf.getDestinationCalls.push(name);
      const value = stub.destinations.get(name);
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    cachedPageNumber: reference => stub.cachedPageNumbers.get(reference) ?? null,
    getPageIndex: async reference => {
      if (!stub.pageIndexes.has(reference)) throw new Error('page index unavailable');
      return stub.pageIndexes.get(reference);
    },
  };
  stub.pdfs.push(pdf);
  return pdf;
}

export function getDocument(options) {
  stub.getDocumentOptions.push(options);
  if (stub.loadingTaskFactory) return stub.loadingTaskFactory();
  const task = {
    onPassword: undefined,
    destroyCalls: 0,
    destroyed: false,
    promise: makePdf(),
    destroy() {
      task.destroyCalls += 1;
      task.destroyed = true;
      stub.destroyCalls.push(task);
      return stub.destroyNeverSettles ? new Promise(() => { }) : Promise.resolve();
    },
  };
  stub.loadingTasks.push(task);
  return task;
}

export function element(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    children: [],
    parent: null,
    removed: false,
    append(child) {
      child.parent = el;
      child.removed = false;
      el.children.push(child);
    },
    remove() {
      el.removed = true;
      const parent = el.parent;
      if (parent) {
        const index = parent.children.indexOf(el);
        if (index >= 0) parent.children.splice(index, 1);
        el.parent = null;
      }
    },
  };
  stub.createdElements.push(el);
  return el;
}

globalThis.Worker = FakeWorker;
globalThis.document = {
  baseURI: 'https://reader.local/app/',
  createElement: tag => element(tag),
};
globalThis.window = {
  addEventListener(name, listener, options) {
    stub.windowListeners.push({ name, listener, options });
  },
  removeEventListener() { },
};
