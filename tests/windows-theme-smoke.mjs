import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';

test('Windows release WebView2: OS theme, live switching, tokens and accessibility', { timeout: 90_000 }, async () => {
  assert.equal(process.platform, 'win32', 'Run this explicitly on native Windows, not a browser preview.');
  const executable = fileURLToPath(new URL('../src-tauri/target/release/local-pdf-reader.exe', import.meta.url));
  await access(executable);
  const profile = await mkdtemp(join(tmpdir(), 'zathura-theme-'));
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  // Only this test child has an isolated profile and loopback debugging endpoint.
  const app = spawn(executable, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  });
  let startupError;
  app.on('error', error => { startupError = error; });
  let browser;
  try {
    const deadline = Date.now() + 30_000;
    let endpoint;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      assert.equal(app.exitCode, null, 'App exited during startup');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
        endpoint = (await response.json()).webSocketDebuggerUrl;
        if (endpoint) break;
      } catch { /* WebView2 has not opened its test endpoint yet. */ }
      await delay(250);
    }
    assert.ok(endpoint, 'WebView2 test endpoint did not start');
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    let page;
    while (Date.now() < deadline) {
      page = context.pages().find(candidate => candidate.url().startsWith('http://tauri.localhost/'));
      if (page) break;
      await delay(100);
    }
    assert.ok(page, 'Expected the actual bundled Tauri page, not a browser preview');
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.locator('#empty-reader').getByText('No document open.', { exact: true }).waitFor();
    // The empty state has no buttons; open the command prompt so a real
    // control (.input) carries the token-propagation and focus checks.
    await page.keyboard.press(':');
    await page.locator('#command-input').waitFor();
    await page.locator('#command-input').focus();
    const initial = await page.evaluate(() => ({
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    assert.equal(initial.scheme, initial.dark ? 'dark' : 'light', 'Startup follows actual OS preference');

    for (const theme of ['light', 'dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme, forcedColors: 'none', reducedMotion: 'reduce' });
      await page.waitForFunction(expected => {
        const root = getComputedStyle(document.documentElement);
        const hex = root.getPropertyValue('--color-control').trim();
        const rgb = `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
        return root.colorScheme === expected && getComputedStyle(document.querySelector('#command-input')).backgroundColor === rgb;
      }, theme, { timeout: 15_000, polling: 250 });
      const state = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const input = getComputedStyle(document.querySelector('#command-input'));
        const status = getComputedStyle(document.querySelector('footer'));
        // Tokens hold light-dark() pairs; resolve against the effective
        // scheme: a data-theme pin wins over the OS preference.
        const rgb = token => {
          const pair = root.getPropertyValue(token).trim();
          const match = pair.match(/^light-dark\(\s*(#[0-9a-f]{6,8})\s*,\s*(#[0-9a-f]{6,8})\s*\)$/);
          if (!match) throw new Error(`${token} is not a light-dark() pair: ${pair}`);
          const pinned = document.documentElement.getAttribute('data-theme');
          const dark = pinned ? pinned === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
          const hex = dark ? match[2] : match[1];
          return `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
        };
        return {
          scheme: root.colorScheme,
          background: root.backgroundColor,
          canvas: rgb('--color-canvas'),
          text: root.color,
          textToken: rgb('--color-text'),
          inputBackground: input.backgroundColor,
          inputToken: rgb('--color-control'),
          muted: status.color,
          mutedToken: rgb('--color-text-muted'),
          duration: root.getPropertyValue('--duration-fast').trim(),
        };
      });
      assert.equal(state.scheme, theme);
      assert.equal(state.background, state.canvas);
      assert.equal(state.text, state.textToken);
      assert.equal(state.inputBackground, state.inputToken);
      assert.equal(state.muted, state.mutedToken);
      assert.equal(state.duration, '0ms', 'Reduced motion zeroes the motion token');

    }

    // Ctrl+R pins the opposite theme over the OS preference; the loop above
    // ended on emulated light, so the first press must pin dark.
    for (const [expectedAttr, expectedScheme] of [['dark', 'dark'], ['light', 'light']]) {
      await page.keyboard.press('Control+r');
      await page.waitForFunction(expected => {
        const root = document.documentElement;
        return root.getAttribute('data-theme') === expected
          && getComputedStyle(root).colorScheme === expected;
      }, expectedAttr, { timeout: 15_000, polling: 250 });
      const pinned = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const pair = root.getPropertyValue('--color-canvas').trim();
        const match = pair.match(/^light-dark\(\s*(#[0-9a-f]{6,8})\s*,\s*(#[0-9a-f]{6,8})\s*\)$/);
        if (!match) throw new Error(`--color-canvas is not a light-dark() pair: ${pair}`);
        const pinned = document.documentElement.getAttribute('data-theme');
        const hex = pinned === 'dark' ? match[2] : match[1];
        return `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
      });
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), pinned,
        `Pinned ${expectedAttr} theme must recolor the shell`);
    }

    const override = await page.evaluate(() => {
      const root = document.documentElement;
      root.style.setProperty('--radius-small', '13px');
      root.style.setProperty('--space-3', '21px');
      root.style.setProperty('--font-family-ui', 'monospace');
      const input = getComputedStyle(document.querySelector('#command-input'));
      const result = { radius: input.borderRadius, padding: input.paddingLeft, font: input.fontFamily };
      for (const token of ['--radius-small', '--space-3', '--font-family-ui']) root.style.removeProperty(token);
      return result;
    });
    assert.deepEqual(override, { radius: '13px', padding: '21px', font: 'monospace' }, 'Shared tokens reach actual controls');

    await page.setViewportSize({ width: 360, height: 320 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow at a small viewport and enlarged text');
    await page.evaluate(() => { document.documentElement.style.removeProperty('font-size'); });
    const controls = await page.evaluate(() => ({
      empty: document.querySelector('#empty-reader').getBoundingClientRect().toJSON(),
      status: document.querySelector('footer').getBoundingClientRect().toJSON(),
      width: innerWidth,
      height: innerHeight,
    }));
    for (const bounds of [controls.empty, controls.status]) {
      // WebView2's display scaling can round layout bounds by a fraction of a CSS pixel.
      assert.ok(bounds.top >= -0.5 && bounds.bottom <= controls.height + 0.5 && bounds.left >= -0.5 && bounds.right <= controls.width + 0.5,
        `Critical controls remain visible at 360x320: ${JSON.stringify(controls)}`);
    }
    await page.keyboard.press(':');
    await page.locator('#command-input').focus();
    assert.equal(await page.locator('#command-input').evaluate(input => {
      const style = getComputedStyle(input);
      return input.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
    }), true, 'Visible focus ring');

    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const input = getComputedStyle(document.querySelector('#command-input'));
      return matchMedia('(forced-colors: active)').matches && root.forcedColorAdjust === 'auto'
        && root.getPropertyValue('--color-canvas').trim() === 'Canvas' && input.boxShadow === 'none';
    }), true, 'Windows Contrast Themes retain system colors');
    assert.deepEqual(pageErrors, []);
    console.log(`Verified WebView2 ${browser.version()}; startup ${initial.scheme}; live light/dark/light, tokens, focus, 360x320, enlarged text, reduced motion and forced colors.`);
  } finally {
    await browser?.close();
    if (app.pid && app.exitCode === null) {
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() | Out-Null; $p.WaitForExit(5000) | Out-Null }`],
      { stdio: 'ignore', timeout: 10_000 });
      if (app.exitCode === null) app.kill();
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
