import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('tracked text does not contain literal user home paths', async () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const homePath = /(?:[A-Za-z]:\\Users\\[^\\/\s`"'<>]+\\|\/(?:home|Users)\/[^/\s`"'<>]+\/)/g;
  const findings = [];

  for (const file of files) {
    const bytes = await readFile(join(root, file));
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const match of text.matchAll(homePath)) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push(`${file}:${line}: ${match[0]}`);
    }
  }

  assert.deepEqual(findings, [], `Replace personal paths with environment variables or neutral placeholders:\n${findings.join('\n')}`);
});
