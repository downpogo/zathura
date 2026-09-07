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

const root = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function launchInstance(profile, port) {
  const executable = join(root, 'src-tauri/target/release/local-pdf-reader.exe');
  await access(executable);
  const app = spawn(executable, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  });
  let startupFailed = false;
  app.on('error', () => { startupFailed = true; });
  const deadline = Date.now() + 30_000;
  let endpoint;
  while (Date.now() < deadline) {
    assert.ok(!startupFailed && app.exitCode === null, 'Release app failed to start');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      endpoint = (await response.json()).webSocketDebuggerUrl;
      if (endpoint) break;
    } catch { /* WebView2 has not opened its test endpoint yet. */ }
    await delay(250);
  }
  assert.ok(endpoint, 'WebView2 CDP endpoint unavailable');
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  let page;
  while (Date.now() < deadline) {
    page = context.pages().find(candidate => candidate.url().startsWith('http://tauri.localhost/'));
    if (page) break;
    await delay(100);
  }
  assert.ok(page, 'Expected packaged Tauri origin');
  page.setDefaultTimeout(15_000);
  return { app, browser, page };
}

// Graceful close: WM_CLOSE via CloseMainWindow so beforeunload flushes the
// debounced per-document saves. A kill would drop the pending 400ms write.
async function closeGracefully(app, browser) {
  try { await browser?.close(); } catch { /* The endpoint may already be gone. */ }
  if (!app.pid || app.exitCode !== null) return;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() | Out-Null }`],
  { stdio: 'ignore', timeout: 10_000 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && app.exitCode === null) await delay(250);
  assert.ok(app.exitCode !== null, 'App must exit gracefully via CloseMainWindow');
  if (app.exitCode === null) app.kill();
}

async function drivePicker(page, app, names) {
  // PowerShell receives data via stdin, avoiding shell quoting and path-bearing diagnostics.
  const script = join(root, 'tests/windows-picker.ps1').replaceAll("'", "''");
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$paths = [Console]::In.ReadToEnd(); & '${script}' -ProcessId ${app.pid} -Action Select -PathsJson $paths`],
  { stdio: ['pipe', 'ignore', 'pipe'] });
  let stage = 'startup';
  child.stderr.on('data', data => {
    const match = String(data).match(/Native picker automation failed at (initialize|paths|dialog|filename|button) /);
    if (match) stage = match[1];
  });
  const finished = new Promise(resolve => {
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(names.map(name => join(root, `fixtures/pdfs/${name}.pdf`))));
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    // Minimal UI: Ctrl+O is the only open path.
    await page.keyboard.press('Control+o');
    assert.equal(await finished, true, `Owned native picker control failed at ${stage}; private details suppressed`);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}

test('NEXT-02 Windows release: reading state persists across app restarts', { timeout: 180_000 }, async () => {
  assert.equal(process.platform, 'win32', 'Run explicitly on native Windows; browser previews are not evidence.');
  const profile = await mkdtemp(join(tmpdir(), 'zathura-persistence-'));
  const openSettled = page => page.waitForFunction(() => !document.body.hasAttribute('data-opening'), null, { polling: 250 });
  const statusStarts = (page, prefix, timeout) => page.waitForFunction(expected => {
    const name = document.querySelector('#status-name')?.textContent ?? '';
    const pages = document.querySelector('#status-pages')?.textContent ?? '';
    return (pages ? `${name} | ${pages}` : name).startsWith(expected);
  }, prefix, { timeout, polling: 250 });
  try {
    // Phase A: read position/zoom, hide the status bar, close gracefully.
    {
      const { app, browser, page } = await launchInstance(profile, await freePort());
      try {
        await page.locator('#empty-reader').getByText('No document open.', { exact: true }).waitFor();
        await drivePicker(page, app, ['navigation']);
        await openSettled(page);
        await statusStarts(page, 'navigation.pdf | 1/4', 20_000);
        await page.keyboard.press('3');
        await page.keyboard.press('G');
        await statusStarts(page, 'navigation.pdf | 3/4', 15_000);
        const beforeZoom = await page.evaluate(() => document.querySelector('footer')?.dataset.zoomLabel);
        await page.keyboard.press('+');
        await page.waitForFunction(previous => document.querySelector('footer')?.dataset.zoomLabel !== previous,
          beforeZoom, { timeout: 15_000, polling: 250 });
        const zoomLabel = await page.evaluate(() => document.querySelector('footer')?.dataset.zoomLabel);
        assert.ok(zoomLabel && zoomLabel !== '100%', `Zoom label must change after '+' (got "${zoomLabel}")`);
        await page.keyboard.press('Control+n');
        await page.waitForFunction(() => document.querySelector('footer').hidden, null, { polling: 250 });
        const storageBeforeClose = await page.evaluate(() => localStorage.getItem('zathura.reading-state.v1'));
        console.log(`Phase A storage before close: ${storageBeforeClose}`);
        await closeGracefully(app, browser);
      } catch (error) {
        await browser?.close().catch(() => {});
        if (app.pid && app.exitCode === null) app.kill();
        throw error;
      }
    }

    // Phase B: same profile, new port. Footer hidden and reading position/zoom restore.
    {
      const { app, browser, page } = await launchInstance(profile, await freePort());
      try {
        await page.locator('#empty-reader').getByText('No document open.', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.querySelector('footer').hidden), true,
          'statusBarHidden must be persisted and applied at startup');
        await drivePicker(page, app, ['navigation']);
        await openSettled(page);
        try {
          await statusStarts(page, 'navigation.pdf | 3/4', 20_000);
        } catch (error) {
          const probe = await page.evaluate(() => ({
            footer: document.querySelector('footer').textContent,
            storage: localStorage.getItem('zathura.reading-state.v1'),
          }));
          throw new Error(`Phase B did not restore: ${JSON.stringify(probe)}`, { cause: error });
        }
        const footer = await page.evaluate(() => document.querySelector('#status-pages')?.textContent);
        assert.equal(footer, '3/4', 'Page position must be restored from history');
        // Phase 6 tail: the status bar toggle state persisted, so the user can restore it.
        await page.keyboard.press('Control+n');
        await page.waitForFunction(() => !document.querySelector('footer').hidden, null, { polling: 250 });

        // Phase C start: clear the stored history in this same instance.
        await page.keyboard.press(':');
        await page.locator('#command-input').waitFor({ state: 'visible' });
        await page.locator('#command-input').fill('clear-history');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('#command-bar').hidden, null, { polling: 250 });
        await closeGracefully(app, browser);
      } catch (error) {
        await browser?.close().catch(() => {});
        if (app.pid && app.exitCode === null) app.kill();
        throw error;
      }
    }

    // Phase C: history cleared, so navigation.pdf reopens at page 1 and the
    // cleared statusBarHidden default makes the footer visible again.
    {
      const { app, browser, page } = await launchInstance(profile, await freePort());
      try {
        await page.locator('#empty-reader').getByText('No document open.', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.querySelector('footer').hidden), false,
          'After :clear-history the default (visible) status bar must be restored');
        await drivePicker(page, app, ['navigation']);
        await openSettled(page);
        try {
          await statusStarts(page, 'navigation.pdf | 1/4', 20_000);
        } catch (error) {
          const probe = await page.evaluate(() => ({
            footer: document.querySelector('footer').textContent,
            storage: localStorage.getItem('zathura.reading-state.v1'),
            documents: [...document.querySelectorAll('#document-items .document-item')].map(item => item.textContent),
          }));
          throw new Error(`Phase C did not reset: ${JSON.stringify(probe)}`, { cause: error });
        }
        await closeGracefully(app, browser);
      } catch (error) {
        await browser?.close().catch(() => {});
        if (app.pid && app.exitCode === null) app.kill();
        throw error;
      }
    }
    console.log('Verified WebView2 persistence: page/zoom restore per document, status-bar toggle persists across restarts, :clear-history resets history and defaults.');
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
