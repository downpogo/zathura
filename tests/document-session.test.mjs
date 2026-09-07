import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import workerUrl, { AnnotationMode, PasswordResponses, element, resetStub, stub } from './helpers/session-stub.mjs';

// Swap the PDF.js surface for lifecycle doubles without touching node_modules.
const stubModuleUrl = new URL('./helpers/session-stub.mjs', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === 'pdfjs-dist/legacy/build/pdf.mjs' ||
      specifier === 'pdfjs-dist/legacy/build/pdf.worker.mjs?url' ||
      specifier === 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
    ) {
      return { url: stubModuleUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { DocumentSession, DocumentSessionError } = await import('../src/document-session.ts');
hooks.deregister();

const data = new Uint8Array([37, 80, 68, 70, 45]);

function pendingTask() {
  const task = {
    onPassword: undefined,
    destroyCalls: 0,
    destroyed: false,
    promise: new Promise(() => { }),
    destroy() {
      task.destroyCalls += 1;
      task.destroyed = true;
      stub.destroyCalls.push(task);
      return Promise.resolve();
    },
  };
  return task;
}

async function createReadySession() {
  const states = [];
  const errors = [];
  const container = element();
  const session = await DocumentSession.create(container, data, {
    requestPassword: async () => null,
    onState: state => states.push(state),
    onNonfatalError: message => errors.push(message),
  });
  return { session, states, errors, container };
}

test('create wires worker, document options and viewer options end to end', async () => {
  resetStub();
  const { session, states, container } = await createReadySession();
  const worker = stub.workers[0];
  assert.equal(worker.url, workerUrl);
  assert.equal(worker.type, 'module');
  const pdfWorker = stub.pdfWorkerCreates[0];
  assert.equal(pdfWorker.port, worker);
  assert.equal(pdfWorker.verbosity, 0);
  const options = stub.getDocumentOptions[0];
  assert.equal(options.data, data);
  assert.equal(options.worker, pdfWorker);
  assert.equal(options.cMapUrl, 'https://reader.local/app/pdfjs/cmaps/');
  assert.equal(options.cMapPacked, true);
  assert.equal(options.standardFontDataUrl, 'https://reader.local/app/pdfjs/standard_fonts/');
  assert.equal(options.wasmUrl, 'https://reader.local/app/pdfjs/wasm/');
  assert.equal(options.iccUrl, 'https://reader.local/app/pdfjs/iccs/');
  assert.equal(options.useSystemFonts, false);
  assert.equal(options.enableXfa, false);
  assert.equal(options.verbosity, 0);
  assert.equal('isEvalSupported' in options, false);
  const viewer = stub.viewers[0];
  assert.equal(viewer.annotationMode, AnnotationMode.ENABLE);
  assert.equal(viewer.enableAutoLinking, false);
  assert.equal(viewer.maxCanvasPixels, 8_000_000);
  assert.equal(viewer.maxCanvasDim, 8_192);
  for (const method of ['get', 'translate', 'pause', 'resume']) {
    assert.equal(typeof viewer.l10n[method], 'function');
  }
  assert.ok(viewer.abortSignal instanceof AbortSignal);
  assert.equal(viewer.eventBus, stub.eventBuses[0]);
  const linkService = viewer.linkService;
  assert.equal(linkService.eventBus, viewer.eventBus);
  assert.equal(linkService.externalLinkEnabled, false);
  assert.equal(linkService._ignoreDestinationZoom, false);
  assert.equal(viewer.viewer.className, 'pdfViewer');
  assert.ok(container.children.includes(viewer.viewer));
  assert.deepEqual(stub.scaleValueSets, [{ viewer, value: 'page-actual' }]);
  assert.deepEqual(session.state(), { pageCount: 5, pageNumber: 1, zoomLabel: '100%' });
  assert.deepEqual(states, [{ pageCount: 5, pageNumber: 1, zoomLabel: '100%' }]);
});

test('password prompts retry after an incorrect entry and resolve on the correct one', async () => {
  resetStub();
  const task = pendingTask();
  stub.loadingTaskFactory = () => task;
  const reasons = [];
  const replies = [];
  let resolveLoad;
  task.promise = new Promise(resolve => { resolveLoad = resolve; });
  const update = password => {
    replies.push(password);
    if (password === 'wrong') task.onPassword(update, PasswordResponses.INCORRECT_PASSWORD);
    else resolveLoad({ numPages: 3 });
  };
  const create = DocumentSession.create(element(), data, {
    requestPassword: async reason => {
      reasons.push(reason);
      return reasons.length === 1 ? 'wrong' : 'right';
    },
    onState: () => { },
    onNonfatalError: () => { },
  });
  assert.equal(typeof task.onPassword, 'function');
  task.onPassword(update, PasswordResponses.NEED_PASSWORD);
  const session = await create;
  assert.deepEqual(reasons, ['required', 'incorrect']);
  assert.deepEqual(replies, ['wrong', 'right']);
  assert.deepEqual(session.state(), { pageCount: 3, pageNumber: 1, zoomLabel: '100%' });
});

test('a null password disposes the pending session and rejects create as cancelled', async () => {
  resetStub();
  const task = pendingTask();
  stub.loadingTaskFactory = () => task;
  const reasons = [];
  const replies = [];
  const create = DocumentSession.create(element(), data, {
    requestPassword: async reason => {
      reasons.push(reason);
      return null;
    },
    onState: () => { },
    onNonfatalError: () => { },
  });
  task.onPassword(password => replies.push(password), PasswordResponses.NEED_PASSWORD);
  await assert.rejects(create, error => error instanceof DocumentSessionError && error.code === 'cancelled');
  assert.deepEqual(reasons, ['required']);
  assert.equal(replies.length, 1);
  assert.ok(replies[0] instanceof DocumentSessionError);
  assert.equal(task.destroyed, true);
  assert.equal(stub.destroyCalls.length, 1);
  assert.equal(stub.workers[0].terminated, true);
});

test('a failing password prompt disposes and reports a safe load failure', async () => {
  resetStub();
  const task = pendingTask();
  stub.loadingTaskFactory = () => task;
  const create = DocumentSession.create(element(), data, {
    requestPassword: async () => {
      throw new Error('secret dialog state');
    },
    onState: () => { },
    onNonfatalError: () => { },
  });
  task.onPassword(() => { }, PasswordResponses.NEED_PASSWORD);
  await assert.rejects(create, error => error instanceof DocumentSessionError && error.code === 'load_failed');
  assert.equal(task.destroyed, true);
  assert.equal(stub.workers[0].terminated, true);
});

test('a worker failure during load disposes and rejects with a safe error', async () => {
  resetStub();
  const task = pendingTask();
  stub.loadingTaskFactory = () => task;
  const create = DocumentSession.create(element(), data, {
    requestPassword: async () => null,
    onState: () => { },
    onNonfatalError: () => { },
  });
  const worker = stub.workers[0];
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  worker.dispatch('error', event);
  await assert.rejects(create, error => error instanceof DocumentSessionError && error.code === 'load_failed');
  assert.equal(event.defaultPrevented, true);
  assert.equal(task.destroyed, true);
  assert.equal(stub.destroyCalls.length, 1);
  assert.equal(worker.terminated, true);
});

test('disposing while a password prompt is pending suppresses the reply', async () => {
  resetStub();
  const task = pendingTask();
  stub.loadingTaskFactory = () => task;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const replies = [];
  const create = DocumentSession.create(element(), data, {
    requestPassword: () => gate,
    onState: () => { },
    onNonfatalError: () => { },
  });
  task.onPassword(password => replies.push(password), PasswordResponses.NEED_PASSWORD);
  const worker = stub.workers[0];
  worker.dispatch('error', { preventDefault() { } });
  release('right');
  await assert.rejects(create, error => error instanceof DocumentSessionError && error.code === 'load_failed');
  assert.equal(replies.length, 1);
  assert.ok(replies[0] instanceof DocumentSessionError);
  assert.equal(task.destroyed, true);
  assert.equal(worker.terminated, true);
});

test('events dispatched after dispose are ignored and dispose stays idempotent', async () => {
  resetStub();
  const { session, states } = await createReadySession();
  const eventBus = stub.eventBuses[0];
  const viewer = stub.viewers[0];
  assert.equal(states.length, 1);
  const disposal = session.dispose();
  assert.equal(session.dispose(), disposal);
  await disposal;
  eventBus.dispatch('pagechanging');
  eventBus.dispatch('scalechanging');
  assert.equal(states.length, 1);
  session.zoom('in');
  assert.equal(viewer.increaseCalls, 0);
});

test('page and scale changes update the reported state with mapped zoom labels', async () => {
  resetStub();
  const { session, states } = await createReadySession();
  const viewer = stub.viewers[0];
  const eventBus = stub.eventBuses[0];
  viewer.currentPageNumber = 3;
  eventBus.dispatch('pagechanging');
  assert.equal(states.at(-1).pageNumber, 3);
  viewer.currentScaleValue = 'page-width';
  eventBus.dispatch('scalechanging');
  assert.equal(states.at(-1).zoomLabel, 'Fit width');
  viewer.currentScaleValue = 1.25;
  viewer.currentScale = 1.25;
  eventBus.dispatch('scalechanging');
  assert.equal(states.at(-1).zoomLabel, '125%');
  const labelFor = scaleValue => {
    viewer.currentScaleValue = scaleValue;
    viewer.currentScale = 1;
    return DocumentSession.zoomLabel(viewer);
  };
  assert.equal(labelFor('page-width'), 'Fit width');
  assert.equal(labelFor('page-fit'), 'Fit page');
  assert.equal(labelFor('page-height'), 'Fit height');
  assert.equal(labelFor('auto'), 'Auto');
  assert.equal(labelFor('page-actual'), '100%');
  viewer.currentScaleValue = undefined;
  viewer.currentScale = 1.25;
  assert.equal(DocumentSession.zoomLabel(viewer), '125%');
  assert.deepEqual(session.state(), { pageCount: 5, pageNumber: 3, zoomLabel: '125%' });
});

test('scrollToPage validates bounds before touching the viewer', async () => {
  resetStub();
  const { session } = await createReadySession();
  const viewer = stub.viewers[0];
  assert.equal(session.scrollToPage(2), true);
  assert.deepEqual(viewer.scrollCalls, [{ pageNumber: 2 }]);
  for (const page of [0, -1, NaN, stub.numPages + 1]) {
    assert.equal(session.scrollToPage(page), false);
  }
  assert.deepEqual(viewer.scrollCalls, [{ pageNumber: 2 }]);
});

test('navigateToDest resolves named, object-ref and integer-ref destinations', async () => {
  resetStub();
  const { session } = await createReadySession();
  const pdf = stub.pdfs[0];
  const viewer = stub.viewers[0];
  const objectRef = { num: 7 };
  const named = [objectRef, { name: 'XYZ' }, 0, 0, 1];
  stub.destinations.set('intro', named);
  stub.cachedPageNumbers.set(objectRef, 2);
  assert.equal(await session.navigateToDest('intro'), true);
  assert.deepEqual(pdf.getDestinationCalls, ['intro']);
  assert.deepEqual(viewer.scrollCalls, [{ pageNumber: 2, destArray: named, ignoreDestinationZoom: false }]);
  const integerDest = [2, { name: 'Fit' }];
  assert.equal(await session.navigateToDest(integerDest), true);
  assert.deepEqual(viewer.scrollCalls[1], { pageNumber: 3, destArray: integerDest, ignoreDestinationZoom: false });
  const unresolvedRef = { num: 9 };
  const fallbackDest = [unresolvedRef, { name: 'XYZ' }];
  stub.pageIndexes.set(unresolvedRef, 4);
  assert.equal(await session.navigateToDest(fallbackDest), true);
  assert.deepEqual(viewer.scrollCalls[2], { pageNumber: 5, destArray: fallbackDest, ignoreDestinationZoom: false });
});

test('broken destinations produce nonfatal feedback without scrolling', async () => {
  resetStub();
  const { session, errors } = await createReadySession();
  const viewer = stub.viewers[0];
  assert.equal(await session.navigateToDest('missing'), false);
  stub.destinations.set('boom', new Error('unavailable'));
  assert.equal(await session.navigateToDest('boom'), false);
  assert.equal(await session.navigateToDest([{ num: 1 }, { name: 'XYZ' }]), false);
  assert.deepEqual(errors, [
    'This destination is not available.',
    'This destination is not available.',
    'This destination is not available.',
  ]);
  assert.deepEqual(viewer.scrollCalls, []);
  assert.equal(await session.navigateToDest('missing'), false);
});

test('disposing mid-flight cancels navigation without error feedback', async () => {
  resetStub();
  const { session, errors } = await createReadySession();
  let resolveDest;
  const navigation = session.navigateToDest(new Promise(resolve => { resolveDest = resolve; }));
  await session.dispose();
  resolveDest([{ num: 1 }, { name: 'XYZ' }]);
  assert.equal(await navigation, false);
  assert.deepEqual(errors, []);
  assert.equal(await session.navigateToDest('intro'), false);
  assert.deepEqual(errors, []);
});

test('zoom requests map to the matching viewer operations', async () => {
  resetStub();
  const { session } = await createReadySession();
  const viewer = stub.viewers[0];
  session.zoom('in');
  session.zoom('out');
  assert.equal(viewer.increaseCalls, 1);
  assert.equal(viewer.decreaseCalls, 1);
  session.zoom('reset');
  session.zoom('fit-width');
  session.zoom('fit-page');
  assert.deepEqual(
    stub.scaleValueSets.filter(entry => entry.viewer === viewer).map(entry => entry.value),
    ['page-actual', 'page-actual', 'page-width', 'page-fit'],
  );
  await session.dispose();
  session.zoom('in');
  session.zoom('fit-width');
  assert.equal(viewer.increaseCalls, 1);
  assert.deepEqual(
    stub.scaleValueSets.filter(entry => entry.viewer === viewer).map(entry => entry.value),
    ['page-actual', 'page-actual', 'page-width', 'page-fit'],
  );
});

test('window resize reapplies fit presets only', async () => {
  resetStub();
  const { session } = await createReadySession();
  const resize = stub.windowListeners.find(entry => entry.name === 'resize');
  assert.ok(resize);
  assert.ok(resize.options.signal instanceof AbortSignal);
  const viewer = stub.viewers[0];
  viewer.currentScaleValue = 'page-width';
  resize.listener();
  assert.deepEqual(stub.scaleValueSets.at(-1), { viewer, value: 'page-width' });
  viewer.currentScaleValue = 'page-fit';
  resize.listener();
  assert.deepEqual(stub.scaleValueSets.at(-1), { viewer, value: 'page-fit' });
  viewer.currentScaleValue = 1.25;
  resize.listener();
  assert.deepEqual(stub.scaleValueSets.at(-1), { viewer, value: 1.25 });
  await session.dispose();
  viewer.currentScaleValue = 'page-width';
  resize.listener();
  assert.deepEqual(stub.scaleValueSets.at(-1), { viewer, value: 'page-width' });
});

test('a worker error terminates the worker within the bounded grace period', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetStub();
  stub.destroyNeverSettles = true;
  const { session } = await createReadySession();
  const worker = stub.workers[0];
  const viewer = stub.viewers[0];
  worker.dispatch('error', { preventDefault() { } });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await session.dispose();
  assert.equal(stub.destroyCalls.length, 1);
  assert.equal(worker.terminated, true);
  assert.equal(viewer.cleanupCalls, 1);
  assert.equal(stub.pdfWorkerCreates[0].destroyed, true);
  worker.dispatch('error', { preventDefault() { } });
  assert.equal(stub.destroyCalls.length, 1);
  assert.equal(await session.dispose(), undefined);
});

test('dispose removes the viewer div, cleans up and terminates the worker once', async () => {
  resetStub();
  const { session, container } = await createReadySession();
  const viewer = stub.viewers[0];
  const viewerDiv = viewer.viewer;
  const worker = stub.workers[0];
  await session.dispose();
  assert.ok(!container.children.includes(viewerDiv));
  assert.equal(viewerDiv.removed, true);
  assert.equal(viewer.cleanupCalls, 1);
  assert.equal(worker.terminated, true);
  assert.equal(stub.pdfWorkerCreates[0].destroyed, true);
  const again = session.dispose();
  assert.equal(session.dispose(), again);
  await again;
  assert.equal(stub.destroyCalls.length, 1);
  assert.equal(worker.terminated, true);
});
