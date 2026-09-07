import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Exercise the real TS boundary without a webview or an installed runtime SDK.
const key = '__core03TestInvoke';
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@tauri-apps/api/core') {
      return {
        url: `data:text/javascript,${encodeURIComponent(`export const invoke = (...args) => globalThis.${key}(...args);`)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { selectPdfFiles, readPdfFile, releasePdfFile, NativeFileError } =
  await import('../src/native-files.ts');
hooks.deregister();

test('selection forwards partial results and normal cancellation unchanged', async () => {
  for (const result of [
    { cancelled: true, files: [], errors: [] },
    { cancelled: false, files: [{ handle: 'opaque', name: 'book.pdf', size: 12, alreadyOpen: false }], errors: [{ selectionIndex: 1, error: 'empty' }] },
  ]) {
    globalThis[key] = async (command, args) => {
      assert.equal(command, 'select_pdf_files');
      assert.equal(args, undefined);
      return result;
    };
    assert.equal(await selectPdfFiles(), result);
  }
});

test('read uses a binary buffer without copying and passes only the handle', async () => {
  const buffer = new Uint8Array([37, 80, 68, 70, 45]).buffer;
  globalThis[key] = async (command, args) => {
    assert.equal(command, 'read_pdf_file');
    assert.deepEqual(args, { handle: 'opaque' });
    return buffer;
  };
  const bytes = await readPdfFile('opaque');
  assert.equal(bytes.buffer, buffer);
  assert.deepEqual([...bytes], [37, 80, 68, 70, 45]);
});

test('JSON arrays are rejected rather than accepted as binary transport', async () => {
  globalThis[key] = async () => [37, 80, 68, 70, 45];
  await assert.rejects(readPdfFile('opaque'), { code: 'internal' });
});

test('release forwards the handle and normalizes safe native errors', async () => {
  globalThis[key] = async (command, args) => {
    assert.equal(command, 'release_pdf_file');
    assert.deepEqual(args, { handle: 'opaque' });
  };
  assert.equal(await releasePdfFile('opaque'), undefined);
  for (const code of ['unauthorized', 'busy', 'invalid_handle', 'missing', 'unreadable', 'empty', 'not_pdf', 'too_large', 'limit_reached', 'internal']) {
    globalThis[key] = async () => { throw code; };
    await assert.rejects(releasePdfFile('opaque'), error => error instanceof NativeFileError && error.code === code);
  }
});

test('unexpected bridge errors never expose paths or raw messages', async () => {
  globalThis[key] = async () => { throw new Error('secret C:\\private\\book.pdf'); };
  await assert.rejects(selectPdfFiles(), error => {
    assert.equal(error.code, 'internal');
    assert.doesNotMatch(error.message, /secret|private|book/);
    return true;
  });
  delete globalThis[key];
});
