import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

test('bootstrap grants no native capabilities or global bridge', () => {
  assert.deepEqual(config.app.security.capabilities, []);
  assert.notEqual(config.app.withGlobalTauri, true);
  assert.equal(config.app.windows.length, 1);
});

test('production policy excludes remote assets and executable inline content', () => {
  const policy = config.app.security.csp;
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-src 'none'/);
  assert.doesNotMatch(policy, /https:|'unsafe-inline'|'unsafe-eval'|\*/);
  assert.match(policy, /worker-src 'self'/);
});

test('native hooks use pnpm and a loopback-only development server', () => {
  assert.equal(config.build.beforeDevCommand, 'pnpm dev');
  assert.equal(config.build.beforeBuildCommand, 'pnpm build');
  assert.equal(config.build.devUrl, 'http://127.0.0.1:1420');
  assert.match(pkg.scripts.dev, /--host 127\.0\.0\.1.*--strictPort/);
  assert.equal(pkg.packageManager, 'pnpm@10.32.1');
});
