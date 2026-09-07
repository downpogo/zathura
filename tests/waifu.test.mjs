import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';

const root = new URL('../', import.meta.url);
const sheet = postcss.parse(await readFile(new URL('src/style.css', root), 'utf8'), { from: 'src/style.css' });
const tokens = postcss.parse(await readFile(new URL('src/tokens.css', root), 'utf8'), { from: 'src/tokens.css' });

test(':waifu is a command-mode toggle wired to the waifu module', async () => {
  const main = await readFile(new URL('src/main.ts', root), 'utf8');
  assert.match(main, /command === 'waifu'/, 'runUserCommand must route :waifu');
  assert.match(main, /toggleWaifu\(\)/, 'the command must toggle the overlay');
  assert.match(main, /from '\.\/waifu'/, 'the waifu module must be imported');
  const module = await readFile(new URL('src/waifu.ts', root), 'utf8');
  assert.match(module, /export function toggleWaifu/, 'the module must export the toggle');
});

test('the waifu overlay never intercepts input and hides from the a11y tree', async () => {
  const rules = [];
  sheet.walkRules('.waifu', (found) => { rules.push(found); });
  assert.ok(rules.length > 0, 'the .waifu rule must exist');
  let pointerEvents;
  for (const rule of rules) {
    rule.walkDecls('pointer-events', (decl) => { pointerEvents = decl.value; });
  }
  assert.equal(pointerEvents, 'none', 'the overlay must not intercept clicks or keys');
  const module = await readFile(new URL('src/waifu.ts', root), 'utf8');
  assert.match(module, /aria-hidden/, 'the overlay must be hidden from assistive tech');
});

test('the waifu sprite is decorative and driven by a single img element', async () => {
  const module = await readFile(new URL('src/waifu.ts', root), 'utf8');
  assert.match(module, /createElement\('img'\)/, 'the dance is an animated WebP img');
  assert.match(module, /waifu-dance\.webp/, 'the looping dance asset must be referenced');
  assert.match(module, /alt = ''/, 'the sprite must be decorative');
});

test('the waifu always dances; reduced motion never stills her', async () => {
  const module = await readFile(new URL('src/waifu.ts', root), 'utf8');
  assert.doesNotMatch(module, /prefers-reduced-motion/, 'the sprite must never check the OS preference');
  let animated = false;
  sheet.walkRules('.waifu', (rule) => {
    rule.walkDecls('animation', (decl) => {
      animated ||= decl.value.includes('waifu-tour');
    });
  });
  assert.ok(animated, 'the tour must be applied unconditionally');
  let gated = false;
  sheet.walkAtRules('media', (atrule) => {
    if (!atrule.params.includes('prefers-reduced-motion')) return;
    atrule.walkRules(/\.waifu/, () => { gated = true; });
  });
  assert.ok(!gated, 'no reduced-motion gate may wrap the waifu animation');
});

test('the corner tour exists unconditionally and eases its glides', () => {
  let keyframes;
  sheet.walkAtRules('keyframes', (atrule) => {
    if (atrule.params === 'waifu-tour') keyframes = atrule;
  });
  assert.ok(keyframes, 'waifu-tour keyframes must exist');
  let easings = 0;
  keyframes.walkDecls('animation-timing-function', (decl) => {
    assert.equal(decl.value, 'var(--ease-standard)');
    easings += 1;
  });
  assert.equal(easings, 4, 'each glide must use the standard easing');
});

test('the tour geometry and duration are tokens, deliberately not voided by reduced motion', () => {
  const defined = new Map();
  tokens.walkDecls((decl) => { defined.set(decl.prop, decl.value); });
  for (const name of ['--size-waifu-inline', '--size-waifu-block', '--waifu-tour-x', '--waifu-tour-y', '--waifu-tour-duration']) {
    assert.ok(defined.has(name), `${name} must exist`);
  }
  // Reduced motion zeroes every --duration-* token, which would freeze the
  // tour mid-glide; the waifu duration must therefore not be one of them.
  assert.ok(!defined.has('--duration-waifu-tour'), 'no reduced-motion-zeroable duration may drive the tour');
});

test('the waifu asset exists and stays lean', async () => {
  const dance = await stat(new URL('src/assets/waifu-dance.webp', root));
  assert.ok(dance.isFile() && dance.size > 0, 'the dancing sprite must be bundled');
  assert.ok(dance.size < 1.2 * 1024 * 1024, `the dance sprite must stay lean, got ${dance.size} bytes`);
});
