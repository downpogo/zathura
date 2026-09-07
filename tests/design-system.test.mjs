import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import test from 'node:test';
import postcss from 'postcss';

const root = new URL('../', import.meta.url);
async function files(directory) {
  const entries = await readdir(new URL(directory, root), { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(`${directory}${entry.name}/`) : `${directory}${entry.name}`))).flat();
}
const sourceFiles = await files('src/');
const sheets = await Promise.all(sourceFiles.filter((path) => path.endsWith('.css')).map(async (path) =>
  postcss.parse(await readFile(new URL(path, root), 'utf8'), { from: path })));
const tokens = sheets.find((sheet) => basename(sheet.source.input.file) === 'tokens.css');
assert.ok(tokens, 'tokens.css must exist');
const media = (node) => {
  const conditions = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name === 'media') conditions.push(parent.params);
  }
  return conditions.join(' and ');
};
const definitions = (condition = '') => {
  const values = new Map();
  tokens.walkDecls(/^--/, (decl) => {
    if (media(decl) === condition) {
      assert.equal(decl.parent.selector, ':root', 'global tokens belong on :root');
      values.set(decl.prop, decl.value);
    }
  });
  return values;
};
const light = definitions();
const darkOverrides = definitions('(prefers-color-scheme: dark)');
const dark = new Map([...light, ...darkOverrides]);
const references = (value) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
const colorNames = (values) => [...values.keys()].filter((name) => name.startsWith('--color-')).sort();

test('OS dark mode overrides every light color, with no dark-only colors', () => {
  assert.ok(colorNames(light).length > 0);
  assert.deepEqual(colorNames(darkOverrides), colorNames(light));
  assert.equal(light.get('--theme-color-scheme'), 'light');
  assert.equal(darkOverrides.get('--theme-color-scheme'), 'dark');
});

test('all CSS token references exist and token graphs are acyclic in each mode', () => {
  for (const sheet of sheets) sheet.walkDecls((decl) => {
    for (const name of references(decl.value)) assert.ok(light.has(name), `${decl}: undefined ${name}`);
  });
  const conditions = new Set(['']);
  tokens.walkDecls(/^--/, (decl) => conditions.add(media(decl)));
  for (const base of [light, dark]) for (const condition of conditions) {
    const values = new Map([...base, ...definitions(condition)]);
    const visited = new Set();
    const visit = (name, path = []) => {
      assert.ok(!path.includes(name), `token cycle: ${[...path, name].join(' -> ')}`);
      if (visited.has(name)) return;
      assert.ok(values.has(name), `undefined token ${name}`);
      for (const ref of references(values.get(name))) visit(ref, [...path, name]);
      visited.add(name);
    };
    for (const name of values.keys()) visit(name);
  }
});

// Strip simple var() calls, not arbitrary CSS functions or literal fallbacks.
function assertDesignValue(prop, value) {
  const remainder = value.replace(/var\(\s*--[\w-]+\s*\)/g, '').trim();
  const keywords = /^(?:(?:inherit|initial|unset|revert|revert-layer|none|auto|normal|solid|dashed|dotted|double|hidden|currentColor|transparent|min-content|max-content|fit-content|background-color|color|opacity|transform|all)\b|\s|,)*$/i;
  assert.match(remainder, keywords, `${prop}: ${value} contains an untokenized design value`);
}
test('component design declarations use tokens rather than raw design values', () => {
  const designProperty = /^(?:color|color-scheme|background(?:-.+)?|font(?:-.+)?|line-height|letter-spacing|word-spacing|text-(?:shadow|indent|decoration.*)|border(?:-.+)?|outline(?:-.+)?|box-shadow|margin(?:-.+)?|padding(?:-.+)?|(?:row-|column-)?gap|(?:min-|max-)?(?:width|height|inline-size|block-size)|inset(?:-.+)?|top|right|bottom|left|transition(?:-.+)?|animation-duration|animation-delay|animation-timing-function|fill|stroke(?:-.+)?|opacity|z-index|flex-basis)$/;
  for (const sheet of sheets.filter((sheet) => sheet !== tokens)) sheet.walkDecls((decl) => {
    assert.ok(!decl.prop.startsWith('--'), `define ${decl.prop} in tokens.css, not component CSS`);
    if (designProperty.test(decl.prop) && decl.prop !== 'font-synthesis') assertDesignValue(decl.prop, decl.value);
    assert.doesNotMatch(decl.value, /#[\da-f]{3,8}\b|\b(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(/i);
  });
});

test('design-value guard rejects literals mixed with tokens and accepts structure', () => {
  for (const [prop, value] of [['border', '1px solid var(--color-border)'], ['padding', 'var(--space-1) 8px'],
    ['color', 'red'], ['font-weight', '600'], ['transition', 'color 120ms ease'], ['width', 'var(--missing, 20px)']]) {
    assert.throws(() => assertDesignValue(prop, value));
  }
  assertDesignValue('border', 'var(--border-width) solid var(--color-border)');
  assertDesignValue('font', 'inherit');
});

test('app TS and HTML have no inline styles or embedded palettes', async () => {
  for (const path of ['index.html', ...sourceFiles.filter((path) => /\.(?:tsx?|html)$/.test(path))]) {
    const source = await readFile(new URL(path, root), 'utf8');
    assert.doesNotMatch(source, /\bstyle\s*=|<style\b|\.style\b|\[\s*['"]style['"]\s*\]|\b(?:setAttribute|setAttributeNS)\(\s*['"]style['"]|\bcssText\b/i, path);
    assert.doesNotMatch(source, /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\s*\(/i, path);
  }
});

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i, 'contrast pairs must use opaque six-digit hex colors');
  const [r, g, b] = hex.slice(1).match(/../g).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
for (const [theme, values] of [['light', light], ['dark', dark]]) {
  test(`${theme} text contrast is at least 4.5:1 and focus/control boundaries at least 3:1`, () => {
    const failures = [];
    const check = (foreground, background, minimum) => {
      const a = luminance(values.get(`--color-${foreground}`));
      const b = luminance(values.get(`--color-${background}`));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < minimum) failures.push(`${foreground} on ${background}: ${ratio.toFixed(2)}:1 < ${minimum}:1`);
    };
    for (const background of ['canvas', 'surface']) {
      for (const foreground of ['text', 'text-muted', 'accent', 'danger']) check(foreground, background, 4.5);
    }
    for (const background of ['control', 'control-hover', 'control-active']) check('text', background, 4.5);
    check('text-disabled', 'control-disabled', 4.5);
    check('on-selection', 'selection', 4.5);
    for (const background of ['canvas', 'surface', 'control', 'control-hover', 'control-active']) {
      for (const foreground of ['focus', 'border-control']) check(foreground, background, 3);
    }
    assert.deepEqual(failures, [], `${theme} contrast failures:\n${failures.join('\n')}`);
  });
}

test('reduced motion removes durations and forced colors defer to system colors', () => {
  const reduced = definitions('(prefers-reduced-motion: reduce)');
  const durations = [...light.keys()].filter((name) => name.startsWith('--duration-'));
  assert.ok(durations.length > 0);
  for (const name of durations) assert.match(reduced.get(name) ?? '', /^0(?:ms|s)$/, name);
  const forced = definitions('(forced-colors: active)');
  assert.deepEqual(colorNames(forced), colorNames(light));
  for (const name of colorNames(forced)) assert.match(forced.get(name), /^(?:Canvas|CanvasText|ButtonText|ButtonFace|GrayText|LinkText|Highlight|HighlightText|transparent)$/i, name);
  assert.equal(forced.get('--shadow-control'), 'none');
  for (const sheet of sheets) sheet.walkDecls('forced-color-adjust', (decl) => assert.notEqual(decl.value, 'none'));
  const style = sheets.find((sheet) => basename(sheet.source.input.file) === 'style.css');
  let focus;
  style.walkRules(':focus-visible', (rule) => { focus = rule; });
  assert.ok(focus, 'keyboard focus must have a visible outline');
  assert.ok(focus.nodes.some((node) => node.prop === 'outline' && references(node.value).includes('--color-focus')));
});

test('native windows follow OS theme and HTML loads the theme stylesheet before app code', async () => {
  const configs = (await readdir(new URL('src-tauri/', root)))
    .filter((path) => /^tauri(?:\.[\w-]+)?\.conf\.json$/.test(path))
    .map((path) => `src-tauri/${path}`);
  assert.ok(configs.length > 0);
  for (const path of configs) {
    const config = JSON.parse(await readFile(new URL(path, root), 'utf8'));
    for (const window of config.app?.windows ?? []) assert.ok(window.theme == null, `${path}: window theme must follow OS`);
  }
  const html = await readFile(new URL('index.html', root), 'utf8');
  const link = html.search(/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["']\/src\/style\.css["'])[^>]*>/i);
  assert.ok(link >= 0 && link < html.search(/<script\b/i), 'load CSS before scripts');
  assert.match(html, /<meta\b[^>]*name="color-scheme"[^>]*content="light dark"/);
  const style = sheets.find((sheet) => basename(sheet.source.input.file) === 'style.css');
  assert.ok(style.nodes.some((node) => node.type === 'atrule' && node.name === 'import' && /^['"]\.\/tokens\.css['"]$/.test(node.params)));
  let scheme = false;
  style.walkDecls('color-scheme', (decl) => { scheme ||= decl.value === 'var(--theme-color-scheme)'; });
  assert.ok(scheme, 'native HTML controls must use the selected CSS color scheme');
});
