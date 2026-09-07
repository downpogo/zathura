import assert from 'node:assert/strict';
import test from 'node:test';
import { PREFERENCES_KEY, ReadingPrefs } from '../src/prefs.ts';

function memoryStorage(initial = new Map()) {
  const store = new Map(initial);
  return {
    store,
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); },
    removeItem: key => { store.delete(key); },
  };
}

test('empty storage yields defaults', () => {
  const prefs = new ReadingPrefs(memoryStorage());
  assert.deepEqual(prefs.load(), { statusBarHidden: false, documents: {} });
  assert.equal(prefs.statusBarHidden(), false);
  assert.equal(prefs.document('x'), undefined);
});

test('status bar visibility persists', () => {
  const storage = memoryStorage();
  const prefs = new ReadingPrefs(storage);
  prefs.setStatusBarHidden(true);
  assert.equal(prefs.statusBarHidden(), true);
  assert.equal(new ReadingPrefs(storage).statusBarHidden(), true);
  prefs.setStatusBarHidden(false);
  assert.equal(prefs.statusBarHidden(), false);
});

test('document state round-trips under a content key', () => {
  const storage = memoryStorage();
  const prefs = new ReadingPrefs(storage);
  prefs.putDocument('hash-1', { page: 42, zoom: 'page-width' });
  prefs.putDocument('hash-2', { page: 3, zoom: '1.1' });
  assert.deepEqual(prefs.document('hash-1'), { page: 42, zoom: 'page-width' });
  assert.deepEqual(prefs.document('hash-2'), { page: 3, zoom: '1.1' });
  assert.deepEqual(new ReadingPrefs(storage).document('hash-1'), { page: 42, zoom: 'page-width' });
});

test('invalid entries and corrupt JSON recover to safe state', () => {
  const corrupt = JSON.stringify({ statusBarHidden: 'yes', documents: {
    bad: { page: 'one', zoom: 'x' },
    pageZero: { page: 0, zoom: '1' },
    hugePage: { page: 10_000_000, zoom: '1' },
    longZoom: { page: 5, zoom: 'z'.repeat(64) },
    good: { page: 7, zoom: 'page-fit' },
  } });
  const prefs = new ReadingPrefs(memoryStorage(new Map([[PREFERENCES_KEY, corrupt]])));
  assert.equal(prefs.statusBarHidden(), false);
  assert.deepEqual(prefs.document('good'), { page: 7, zoom: 'page-fit' });
  assert.equal(prefs.document('bad'), undefined);
  assert.equal(prefs.document('pageZero'), undefined);
  assert.equal(prefs.document('hugePage'), undefined);
  assert.equal(prefs.document('longZoom'), undefined);

  const broken = new ReadingPrefs(memoryStorage(new Map([[PREFERENCES_KEY, '{not json']])));
  assert.deepEqual(broken.load(), { statusBarHidden: false, documents: {} });

  const wrongType = new ReadingPrefs(memoryStorage(new Map([[PREFERENCES_KEY, '42']])));
  assert.deepEqual(wrongType.load(), { statusBarHidden: false, documents: {} });
});

test('writes reject invalid keys, pages and zooms without corrupting state', () => {
  const prefs = new ReadingPrefs(memoryStorage());
  prefs.putDocument('hash-1', { page: 42, zoom: 'page-width' });
  for (const [key, state] of [
    ['', { page: 1, zoom: '1' }],
    ['k'.repeat(65), { page: 1, zoom: '1' }],
    ['valid', { page: 0, zoom: '1' }],
    ['valid', { page: 1.5, zoom: '1' }],
    ['valid', { page: 5, zoom: '' }],
    ['valid', { page: 5, zoom: 'z'.repeat(32) }],
  ]) {
    prefs.putDocument(key, state);
  }
  assert.deepEqual(prefs.document('valid'), undefined);
  assert.deepEqual(prefs.document('hash-1'), { page: 42, zoom: 'page-width' });
});

test('clear removes everything', () => {
  const storage = memoryStorage();
  const prefs = new ReadingPrefs(storage);
  prefs.setStatusBarHidden(true);
  prefs.putDocument('hash-1', { page: 9, zoom: 'auto' });
  prefs.clear();
  assert.deepEqual(prefs.load(), { statusBarHidden: false, documents: {} });
  assert.equal(storage.store.has(PREFERENCES_KEY), false);
});

test('storage failures never crash the reader', () => {
  const throwing = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const prefs = new ReadingPrefs(throwing);
  prefs.setStatusBarHidden(true);
  prefs.putDocument('hash-1', { page: 1, zoom: '1' });
  assert.deepEqual(prefs.load(), { statusBarHidden: false, documents: {} });
  const brokenGet = { getItem: () => { throw new Error('io'); }, setItem: () => {}, removeItem: () => {} };
  assert.deepEqual(new ReadingPrefs(brokenGet).load(), { statusBarHidden: false, documents: {} });
});

test('documents beyond the cap evict oldest entries', () => {
  const prefs = new ReadingPrefs(memoryStorage());
  for (let index = 0; index < 520; index++) {
    prefs.putDocument(`hash-${index}`, { page: index + 1, zoom: '1' });
  }
  const state = prefs.load();
  assert.equal(Object.keys(state.documents).length <= 512, true);
  assert.equal(state.documents['hash-0'], undefined, 'oldest evicted');
  assert.ok(state.documents['hash-519']);
});
