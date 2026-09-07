import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const installed = dirname(require.resolve('pdfjs-dist/package.json'));
const output = join(root, 'public', 'pdfjs');
const assets = ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'LICENSE'];

// Inventory every file, including licenses and fallback code, without a filename allowlist.
async function inventory(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result[entry.name] = await inventory(path);
    } else {
      assert.ok(entry.isFile(), `${path} must be a regular file`);
      const bytes = await readFile(path);
      result[entry.name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  }
  return result;
}

test('PDF.js dependency is the exact installed CORE04 release', async () => {
  const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const pdfjs = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(app.dependencies['pdfjs-dist'], '6.3.289');
  assert.equal(pdfjs.version, app.dependencies['pdfjs-dist']);
  assert.match(app.scripts.test, /^pnpm prepare:pdf-assets\s*&&\s*node --test tests\/\*\.test\.mjs$/);
});

test('generated PDF.js assets contain only the required installed trees and root license', async () => {
  assert.deepEqual((await readdir(output)).sort(), [...assets].sort());
  assert.deepEqual(await readFile(join(output, 'LICENSE')), await readFile(join(installed, 'LICENSE')));
});

for (const asset of assets.filter(name => name !== 'LICENSE')) {
  test(`${asset} preserves the complete installed inventory, byte lengths and hashes, including nested licenses`, async () => {
    const expected = await inventory(join(installed, asset));
    assert.ok(Object.keys(expected).length > 0, `${asset} must not be empty`);
    assert.deepEqual(await inventory(join(output, asset)), expected);
  });
}

test('display and module worker imports use the same local PDF.js build', async () => {
  const source = await readFile(join(root, 'src', 'document-session.ts'), 'utf8');
  const display = source.match(/import\s*\{[^}]*\bgetDocument\b[^}]*\}\s*from\s*['"](pdfjs-dist\/[^'"]+\/pdf\.mjs)['"]/);
  assert.ok(display, 'display API must be imported from the installed PDF.js package');
  assert.equal(display[1], 'pdfjs-dist/legacy/build/pdf.mjs', 'display must use the legacy build');
  const worker = source.match(/import\s+(\w+)\s+from\s*['"]([^'"]+\.worker\.mjs)\?url['"]/);
  assert.ok(worker, 'worker must be a bundled URL import');
  assert.equal(worker[2], display[1].replace(/pdf\.mjs$/, 'pdf.worker.mjs'), 'worker URL must derive from the display path');
  assert.match(source, new RegExp(`new Worker\\(\\s*${worker[1]}\\s*,\\s*\\{\\s*type:\\s*['"]module['"]\\s*\\}\\s*\\)`));
  // Vendored upstream viewer components and their CSS are intentional; the
  // reader must use the legacy viewer module and stylesheet from the same pin.
  assert.match(source, /import\s*\{[^}]*\bPDFViewer\b[^}]*\}\s*from\s*['"]pdfjs-dist\/legacy\/web\/pdf_viewer\.mjs['"]/);
  const main = await readFile(join(root, 'src', 'main.ts'), 'utf8');
  assert.match(main, /import\s+['"]pdfjs-dist\/legacy\/web\/pdf_viewer\.css['"]/);
});

test('production CSP allows local workers and WASM without general eval or remote content', async () => {
  const config = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const directives = {};
  for (const clause of config.app.security.csp.split(';')) {
    if (!clause.trim()) continue;
    const [name, ...sources] = clause.trim().split(/\s+/);
    assert.ok(!Object.hasOwn(directives, name), `duplicate CSP directive: ${name}`);
    directives[name] = sources.sort();
  }
  // The IPC endpoint is native transport, not permission for arbitrary HTTP origins.
  const expected = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'worker-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'blob:', 'data:'],
    'font-src': ["'self'", 'blob:', 'data:'],
    'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'frame-src': ["'none'"],
    'form-action': ["'none'"],
  };
  for (const sources of Object.values(expected)) sources.sort();
  assert.deepEqual(directives, expected);
});

test('reader source does not enable PDF scripting, markup injection, links or attachments', async () => {
  const files = (await readdir(join(root, 'src'), { recursive: true })).filter(name => /\.(?:[cm]?[jt]sx?|html)$/.test(name));
  assert.ok(files.includes('document-session.ts'));
  for (const file of files) {
    const source = await readFile(join(root, 'src', file), 'utf8');
    assert.doesNotMatch(source, /pdf\.sandbox|quickjs|PDFScriptingManager/i, file);
    assert.doesNotMatch(source, /\b(?:getJSActions|getJavaScript|getAttachments|getAnnotations|AnnotationLayer|DownloadManager)\b/, file);
    assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML)\s*=|\b(?:insertAdjacentHTML|createContextualFragment|parseFromString)\s*\(|document\.(?:write|writeln)\s*\(/, file);
    assert.doesNotMatch(source, /createElement\s*\(\s*['"](?:script|iframe|object|embed)['"]/, file);
    assert.doesNotMatch(source, /\bwindow\.open\s*\(/, file);
    assert.doesNotMatch(source, /\.(?:href|location)\s*=/i, file);
    assert.doesNotMatch(source, /enableXfa\s*:\s*true/i, file);
    assert.doesNotMatch(source, /enableAutoLinking\s*:\s*true/i, file);
    assert.doesNotMatch(source, /AnnotationMode\.(?:ENABLE_FORMS|ENABLE_STORAGE)/, file);
  }
  const session = await readFile(join(root, 'src', 'document-session.ts'), 'utf8');
  // pdf.js v6 removed the isEvalSupported option; it must not be re-introduced
  // as a document option.
  assert.doesNotMatch(session, /isEvalSupported\s*:/, 'document-session must not set isEvalSupported');
  // Positive hardening assertions: the sanitized link service and viewer options.
  assert.match(session, /externalLinkEnabled\s*=\s*false/, 'external link navigation must stay disabled');
  assert.match(session, /enableAutoLinking\s*:\s*false/, 'auto linking must stay disabled');
  assert.match(session, /annotationMode\s*:\s*AnnotationMode\.ENABLE\b/, 'annotations must stay at ENABLE, never forms or storage');
  assert.match(session, /enableXfa\s*:\s*false/, 'XFA must stay disabled');
  assert.match(session, /useSystemFonts\s*:\s*false/, 'system fonts must stay disabled');
  assert.match(session, /verbosity\s*:\s*0/, 'PDF.js logging must stay silent');
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.deepEqual(html.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi), ['<script type="module" src="/src/main.ts"></script>']);
  assert.doesNotMatch(html, /<(?:a|iframe|object|embed)\b|\bon\w+\s*=|javascript:/i);
});
