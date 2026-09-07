import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

test('offline PDF corpus: parser expectations and byte-for-byte regeneration', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const python = process.env.FIXTURE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['tests/validate-fixtures.py'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0,
    `Fixture validation failed. Install dev-only fixtures/requirements.txt and set FIXTURE_PYTHON; see fixtures/README.md.\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
});
