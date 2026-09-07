import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('pdfjs-dist/package.json'));
const root = fileURLToPath(new URL('../', import.meta.url));
const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pdfjs = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (app.dependencies['pdfjs-dist'] !== pdfjs.version) throw new Error('PDF.js must be pinned to the installed exact version');
const output = join(root, 'public', 'pdfjs');
await mkdir(output, { recursive: true });
for (const asset of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'LICENSE']) {
  await rm(join(output, asset), { recursive: true, force: true });
  await cp(join(source, asset), join(output, asset), { recursive: true });
}
