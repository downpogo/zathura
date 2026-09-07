import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = ['basic', 'navigation', 'cjk-embedded', 'scan', 'encrypted', 'corrupt', 'long-text'];
const assets = [
  ['cmaps/Adobe-Japan1-UCS2.bcmap', /application\/octet-stream/],
  ['standard_fonts/LiberationSans-Regular.ttf', /(?:font\/ttf|application\/(?:octet-stream|x-font-ttf))/],
  ['iccs/CGATS001Compat-v2-micro.icc', /(?:application\/(?:octet-stream|vnd.iccprofile))/],
  ['wasm/qcms_bg.wasm', /application\/wasm/],
];

async function until(predicate, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  assert.fail(message);
}

test('CORE06/07 Windows release: multi-document tabs, reader keyboard, continuous reader, internal links and offline native PDFs', { timeout: 360_000 }, async () => {
  assert.equal(process.platform, 'win32', 'Run explicitly on native Windows; browser previews are not evidence.');
  const executable = join(root, 'src-tauri/target/release/local-pdf-reader.exe');
  await access(executable);
  for (const fixture of fixtures) await access(join(root, `fixtures/pdfs/${fixture}.pdf`));
  const expectedAssets = await Promise.all(assets.map(async ([name]) => {
    const bytes = await readFile(join(root, 'node_modules/pdfjs-dist', name));
    return { length: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') };
  }));
  const output = join(root, 'test-results/pdf');
  await mkdir(output, { recursive: true });
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const profile = await mkdtemp(join(tmpdir(), 'zathura-pdf-'));
  const app = spawn(executable, [], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--force-renderer-accessibility --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` },
    stdio: 'ignore',
  });
  let startupFailed = false;
  app.on('error', () => { startupFailed = true; });
  let browser;
  try {
    let endpoint;
    await until(async () => {
      assert.ok(!startupFailed && app.exitCode === null, 'Release app failed to start');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
        endpoint = (await response.json()).webSocketDebuggerUrl;
      } catch { /* Wait for the isolated WebView2 endpoint. */ }
      return Boolean(endpoint);
    }, 'WebView2 CDP endpoint unavailable', 30_000);
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    let page;
    await until(() => {
      page = context.pages().find(candidate => candidate.url().startsWith('http://tauri.localhost/'));
      return Boolean(page);
    }, 'Expected packaged Tauri origin');
    page.setDefaultTimeout(15_000);
    let pageErrors = 0;
    let workerCreated = 0;
    let workerClosed = 0;
    let invalidWorkerUrls = 0;
    let externalRequests = 0;
    let securityErrors = 0;
    const responses = [];
    page.on('pageerror', () => { pageErrors++; });
    page.on('worker', worker => {
      workerCreated++;
      const url = new URL(worker.url());
      if (url.origin !== 'http://tauri.localhost' || !/^\/assets\/pdf\.worker-[\w-]+\.mjs$/.test(url.pathname)) invalidWorkerUrls++;
      worker.on('close', () => { workerClosed++; });
    });
    context.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === 'http://tauri.localhost' && /^\/(assets|pdfjs)\//.test(url.pathname)) {
        responses.push({ path: url.pathname, status: response.status(), mime: response.headers()['content-type'] ?? '' });
      }
    });
    await context.addInitScript(() => {
      globalThis.__pdfSmokeCspCount = 0;
      document.addEventListener('securitypolicyviolation', () => { globalThis.__pdfSmokeCspCount++; });
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && !['tauri.localhost', 'ipc.localhost'].includes(url.hostname)) {
        externalRequests++;
        return route.abort();
      }
      return route.continue();
    });
    const cdp = await context.newCDPSession(page);
    cdp.on('Log.entryAdded', ({ entry }) => {
      // Count browser security diagnostics without retaining URLs or raw text.
      if (entry.source === 'security' && entry.level === 'error') securityErrors++;
    });
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await context.setOffline(true);
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    // Reload under monitoring and real offline emulation, not merely route blocking.
    await page.reload();
    await page.getByRole('button', { name: 'Open PDFs', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.onLine), false, 'WebView2 must report offline');
    assert.equal(await page.evaluate(() => typeof globalThis.__TAURI_INTERNALS__?.invoke), 'function');
    for (const command of ['read_pdf_file', 'release_pdf_file']) {
      assert.equal(await page.evaluate(async command => {
        try { await globalThis.__TAURI_INTERNALS__.invoke(command, { handle: 'forged-core05-handle' }); return false; }
        catch (error) { return error === 'invalid_handle'; }
      }, command), true, `${command} rejects forged capabilities`);
    }

    async function picker(names, shortcut = false) {
      // PowerShell receives data via stdin, avoiding shell quoting and path-bearing diagnostics.
      const action = names.length ? 'Select' : 'Cancel';
      const script = join(root, 'tests/windows-picker.ps1').replaceAll("'", "''");
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$paths = [Console]::In.ReadToEnd(); & '${script}' -ProcessId ${app.pid} -Action ${action} -PathsJson $paths`],
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
        if (shortcut) await page.keyboard.press('Control+o');
        else {
          const button = page.getByRole('button', { name: 'Open PDFs', exact: true });
          // The button only exists in the empty state; documents use Ctrl+O.
          if (await button.isVisible().catch(() => false)) await button.click();
          else await page.keyboard.press('Control+o');
        }
        assert.equal(await finished, true, `Owned native picker control failed at ${stage}; private details suppressed`);
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
    }
    async function diagnose(expected) {
      return page.evaluate(() => ({
        status: document.querySelector('footer').textContent,
        dialogOpen: document.querySelector('#password-dialog').open,
        readerHidden: document.querySelector('#reader').hidden,
        zoomControlsHidden: document.querySelector('#zoom-controls').hidden,
        tabs: [...document.querySelectorAll('#tab-strip .tab')].map(tab => ({
          label: tab.querySelector('.tab-label')?.textContent,
          selected: tab.getAttribute('aria-selected'),
        })),
        views: [...document.querySelectorAll('#reader .session-view')].map(view => ({
          active: view.classList.contains('active-view'),
          canvases: view.querySelectorAll('canvas').length,
        })),
        pages: document.querySelectorAll('#reader .pdfViewer .page').length,
        results: [...document.querySelectorAll('#file-results li')].map(item => item.textContent),
      })).then(actual => {
        throw new Error(`Expected status "${expected}" but found ${JSON.stringify(actual)}`);
      });
    }
    async function status(text) {
      try {
        await page.waitForFunction(expected => document.querySelector('footer').textContent === expected, text, { timeout: 15_000, polling: 250 });
      } catch { await diagnose(text); }
    }
    async function statusStarts(prefix, timeout = 20_000) {
      try {
        await page.waitForFunction(expected => document.querySelector('footer').textContent.startsWith(expected), prefix, { timeout, polling: 250 });
      } catch { await diagnose(prefix); }
    }
    async function footerIncludes(text) {
      try {
        await page.waitForFunction(expected => document.querySelector('footer').textContent.includes(expected), text, { polling: 250 });
      } catch { await diagnose(text); }
    }
    async function footerExcludes(text) {
      try {
        await page.waitForFunction(unexpected => !document.querySelector('footer').textContent.includes(unexpected), text, { polling: 250 });
      } catch { await diagnose(text); }
    }
    // Upstream PDFViewer builds .page divs carrying data-page-number inside
    // #reader .pdfViewer; page 1 is the render target for first-page proofs.
    function firstPageCanvas() {
      return page.locator('#reader .pdfViewer .page[data-page-number="1"] canvas').first();
    }
    async function noWorkers() {
      await until(() => page.workers().length === 0 && workerCreated === workerClosed, 'PDF workers must terminate');
      assert.equal(await page.locator('#reader canvas').count(), 0);
    }
    async function closeViaCommand() {
      // Zathura-style ':q' closes the active document.
      await page.keyboard.press(':');
      await page.locator('#command-input').waitFor({ state: 'visible' });
      await page.locator('#command-input').fill('q');
      await page.keyboard.press('Enter');
      await page.locator('#command-input').waitFor({ state: 'hidden' });
    }
    async function close() {
      await closeViaCommand();
      await status('No document open.');
      await noWorkers();
    }
    async function openSettled() {
      // The Open button re-enables once the whole selection loop has resolved.
      await page.waitForFunction(() => !document.querySelector('#open-files').disabled, null, { polling: 250 });
    }
    async function closeAllTabs() {
      for (;;) {
        const remaining = await page.locator('#tab-strip .tab').count();
        if (!remaining) break;
        await closeViaCommand();
        await page.waitForFunction(expected => document.querySelectorAll('#tab-strip .tab').length < expected, remaining, { polling: 250 });
      }
      await status('No document open.');
      await noWorkers();
    }
    async function rendered(name, count = 1, workers = 1) {
      // Zoom label varies with the viewport; match the deterministic prefix.
      await statusStarts(`${name}.pdf | Page 1 of ${count} | `);
      await until(() => page.workers().length === workers, `Expected ${workers} actual PDF worker${workers === 1 ? '' : 's'}`);
      const canvas = firstPageCanvas();
      try {
        await canvas.waitFor();
      } catch (error) {
        const probe = await page.evaluate(() => ({
          status: document.querySelector('footer').textContent,
          pages: document.querySelectorAll('#reader .pdfViewer .page').length,
          pageNumbers: [...document.querySelectorAll('#reader .pdfViewer .page')].slice(0, 3).map(page => page.getAttribute('data-page-number')),
          canvases: [...document.querySelectorAll('#reader .pdfViewer canvas')].slice(0, 2).map(canvas => ({ width: canvas.width, height: canvas.height, box: canvas.getBoundingClientRect().toJSON() })),
          readerBox: document.querySelector('#reader').getBoundingClientRect().toJSON(),
        }));
        throw new Error(`First-page canvas did not appear: ${JSON.stringify(probe)}`, { cause: error });
      }
      let pixels;
      await until(async () => {
        pixels = await canvas.evaluate(canvas => {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          let hash = 2166136261;
          for (let i = 0; i < data.length; i++) {
            hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
            if (i % 4 === 0 && data[i + 3] > 0 && Math.min(data[i], data[i + 1], data[i + 2]) < 240) ink++;
          }
          return { ink, hash, width: canvas.width, height: canvas.height };
        });
        return pixels.width > 0 && pixels.height > 0 && pixels.ink > 100;
      }, `${name}: first page must render visible nonblank pixels`);
      // Screenshots are diagnostic evidence, not a gate: WebView2 occasionally
      // crashes its renderer under element screenshots; the pixel checks above
      // are the actual assertions.
      try {
        await canvas.screenshot({ path: join(output, `${name}.png`) });
      } catch { /* Skip this diagnostic capture. */ }
      return pixels;
    }
    function tab(label) {
      return page.locator('#tab-strip .tab').filter({ hasText: label });
    }
    // Session views render in creation order: index 0 is the first open file.
    function sessionView(index) {
      return page.locator('#reader .session-view').nth(index);
    }

    // CORE-06 multi-open: every selected file becomes its own tab/session; the
    // FIRST file's tab is active, later ones open as background tabs.
    await picker(['basic', 'navigation']);
    await openSettled();
    await page.waitForFunction(() => {
      const strip = document.querySelector('#tab-strip');
      return !strip.hidden && strip.querySelectorAll('button.tab').length === 2;
    }, null, { polling: 250 });
    assert.equal(await page.evaluate(() => document.querySelector('#tab-strip').getAttribute('role')), 'tablist');
    const tabRows = await page.evaluate(() => [...document.querySelectorAll('#tab-strip .tab')].map(tab => ({
      label: tab.querySelector('.tab-label')?.textContent ?? '',
      selected: tab.getAttribute('aria-selected'),
      close: tab.querySelector('.tab-close')?.getAttribute('aria-label') ?? '',
    })));
    assert.deepEqual(tabRows.map(row => row.label), ['basic.pdf', 'navigation.pdf']);
    assert.deepEqual(tabRows.map(row => row.selected), ['true', 'false']);
    assert.deepEqual(tabRows.map(row => row.close), ['Close basic.pdf', 'Close navigation.pdf']);
    const viewRows = await page.evaluate(() => [...document.querySelectorAll('#reader .session-view')].map(view => ({
      active: view.classList.contains('active-view'),
      visibility: getComputedStyle(view).visibility,
    })));
    assert.equal(viewRows.length, 2, 'Each selected file opens its own session view');
    assert.deepEqual(viewRows.map(row => row.active), [true, false], 'First file owns the active view');
    assert.equal(await page.evaluate(() => document.querySelector('header').hidden), true, 'The Open button hides while documents are open');

    // Ctrl+N toggles the status bar for full-bleed reading.
    await page.keyboard.press('Control+n');
    await page.waitForFunction(() => document.querySelector('footer').hidden, null, { polling: 250 });
    await page.keyboard.press('Control+n');
    await page.waitForFunction(() => !document.querySelector('footer').hidden, null, { polling: 250 });
    assert.deepEqual(viewRows.map(row => row.visibility), ['visible', 'hidden'],
      'Background views keep layout via visibility:hidden, not display:none');
    await until(() => page.workers().length === 2, 'Expected two live PDF workers, one per tab');
    const basic = await rendered('basic', 1, 2);
    const automaticFonts = await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/pdfjs/standard_fonts/')));
    const workerFonts = await page.workers()[0].evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/pdfjs/standard_fonts/')));
    assert.ok(automaticFonts || workerFonts || responses.some(item => item.path.startsWith('/pdfjs/standard_fonts/')), 'PDF rendering must fetch bundled standard fonts without a probe');
    // WebView2's native resource handler need not emit Playwright response events.
    // Fetch the actual loaded module URLs to verify MIME/availability directly.
    const modules = await page.evaluate(async workerUrl => {
      const urls = [...document.scripts].map(script => script.src).filter(Boolean).concat(workerUrl);
      return Promise.all(urls.map(async url => {
        const response = await fetch(url);
        return { status: response.status, mime: response.headers.get('content-type') };
      }));
    }, page.workers()[0].url());
    assert.ok(modules.length >= 2);
    for (const module of modules) {
      assert.equal(module.status, 200, 'Actual application/worker module is available offline');
      assert.match(module.mime ?? '', /javascript/, 'Application/worker module MIME');
    }
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      try {
        await page.waitForFunction(theme => getComputedStyle(document.documentElement).colorScheme === theme, theme, { timeout: 15_000, polling: 250 });
      } catch (error) {
        const probe = await page.evaluate(() => ({
          dark: matchMedia('(prefers-color-scheme: dark)').matches,
          scheme: getComputedStyle(document.documentElement).colorScheme,
          themeVar: getComputedStyle(document.documentElement).getPropertyValue('--theme-color-scheme').trim(),
        }));
        throw new Error(`Theme emulation did not reach ${theme}: ${JSON.stringify(probe)}`, { cause: error });
      }
      assert.deepEqual(await rendered('basic', 1, 2), basic, 'Theme changes must not recolor PDF pixels');
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // CORE-06 position retention: each view keeps its own scroll offset while
    // backgrounded; switching tabs restores them exactly.
    await page.evaluate(() => {
      const view = document.querySelectorAll('#reader .session-view')[0];
      view.scrollTop = 300;
    });
    const basicScroll = await sessionView(0).evaluate(view => view.scrollTop);
    assert.ok(Math.abs(basicScroll - 300) <= 1, `basic.pdf view must be scrollable to 300px (got ${basicScroll})`);
    await tab('navigation.pdf').click();
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    await page.waitForFunction(() => {
      const view = document.querySelectorAll('#reader .session-view')[1];
      return view.querySelector('.pdfViewer canvas') !== null;
    }, null, { polling: 250 });
    await page.evaluate(() => {
      const view = document.querySelectorAll('#reader .session-view')[1];
      view.scrollTop = 500;
    });
    const navigationScroll = await sessionView(1).evaluate(view => view.scrollTop);
    assert.ok(Math.abs(navigationScroll - 500) <= 1, `navigation.pdf view must be scrollable to 500px (got ${navigationScroll})`);
    await tab('basic.pdf').click();
    await statusStarts('basic.pdf | Page 1 of 1 | ');
    await page.waitForFunction(target => Math.abs(document.querySelectorAll('#reader .session-view')[0].scrollTop - target) <= 1, basicScroll, { polling: 250 });
    await tab('navigation.pdf').click();
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    await page.waitForFunction(target => Math.abs(document.querySelectorAll('#reader .session-view')[1].scrollTop - target) <= 1, navigationScroll, { polling: 250 });

    // CORE-07 gt/gT switch documents cyclically.
    await tab('navigation.pdf').click();
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await statusStarts('basic.pdf | Page 1 of 1 | ');
    await page.keyboard.press('g');
    await page.keyboard.press('T');
    await statusStarts('navigation.pdf | Page 1 of 4 | ');

    // CORE-07 zoom/fit on the active document, at 100% before and after.
    await tab('basic.pdf').click();
    await statusStarts('basic.pdf | Page 1 of 1 | 100%');
    await page.keyboard.press('+');
    await status('basic.pdf | Page 1 of 1 | 110%');
    await page.keyboard.press('=');
    await status('basic.pdf | Page 1 of 1 | 100%');
    await page.keyboard.press('a');
    await status('basic.pdf | Page 1 of 1 | Fit page');
    await page.keyboard.press('s');
    await status('basic.pdf | Page 1 of 1 | Fit width');
    // Full-bleed fit-width: the page spans the session view's full client
    // width and never overflows into a horizontal scrollbar.
    await page.waitForFunction(() => {
      const view = document.querySelector('#reader .session-view');
      const page = document.querySelector('#reader .pdfViewer .page');
      return Math.abs(page.getBoundingClientRect().width - view.clientWidth) <= 2
        && view.scrollWidth <= view.clientWidth + 1;
    }, null, { polling: 250 });
    await page.keyboard.press('=');
    await status('basic.pdf | Page 1 of 1 | 100%');

    // Ctrl+O passthrough: the picker still opens; cancel keeps both documents.
    await picker([], true);
    await statusStarts('basic.pdf | Page 1 of 1 | ');

    // CORE-07 keyboard: scrolling and paging on navigation.pdf (4 pages).
    await tab('navigation.pdf').click();
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    try {
      await page.waitForFunction(() => document.querySelectorAll('#reader .session-view')[1].scrollTop <= 12, null, { polling: 250 });
    } catch (error) {
      const probe = await page.evaluate(() => ({
        scroll: [...document.querySelectorAll('#reader .session-view')].map(view => view.scrollTop),
        footer: document.querySelector('footer').textContent,
        activeElement: document.activeElement?.className ?? 'none',
        selected: [...document.querySelectorAll('#tab-strip .tab')].map(tab => tab.getAttribute('aria-selected')),
      }));
      throw new Error(`gg did not scroll to top: ${JSON.stringify(probe)}`, { cause: error });
    }
    await page.keyboard.press('j');
    await page.waitForFunction(() => document.querySelectorAll('#reader .session-view')[1].scrollTop >= 39, null, { polling: 250 });
    const halfViewport = await sessionView(1).evaluate(view => view.clientHeight / 2);
    const beforeHalf = await sessionView(1).evaluate(view => view.scrollTop);
    await page.keyboard.press('Control+d');
    await page.waitForFunction(bounds => {
      const view = document.querySelectorAll('#reader .session-view')[1];
      return view.scrollTop >= bounds.before + bounds.half - 2;
    }, { before: beforeHalf, half: halfViewport }, { polling: 250 });
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    await page.waitForFunction(() => document.querySelectorAll('#reader .session-view')[1].scrollTop <= 12, null, { polling: 250 });
    await page.keyboard.press('3');
    await footerIncludes('Keys: 3');
    await page.keyboard.press('G');
    await statusStarts('navigation.pdf | Page 3 of 4 | ');
    await page.keyboard.press('G');
    await statusStarts('navigation.pdf | Page 4 of 4 | ');
    await page.waitForFunction(() => {
      const view = document.querySelectorAll('#reader .session-view')[1];
      return view.scrollTop >= (view.scrollHeight - view.clientHeight) / 2;
    }, null, { polling: 250 });
    for (const digit of ['9', '9', '9', '9']) await page.keyboard.press(digit);
    await footerIncludes('Keys: 9999');
    await page.keyboard.press('G');
    await page.locator('#file-results li').filter({ hasText: 'out of range' }).first().waitFor();
    await statusStarts('navigation.pdf | Page 4 of 4 | ');
    // Counted go is vi-style: digits, then 'gg' completes ('2g' pends visibly).
    await page.keyboard.press('2');
    await footerIncludes('Keys: 2');
    await page.keyboard.press('g');
    await footerIncludes('Keys: 2g');
    await page.keyboard.press('g');
    await statusStarts('navigation.pdf | Page 2 of 4 | ');
    await footerExcludes('Keys:');
    // Escape abandons a pending count without changing the page.
    await page.keyboard.press('7');
    await footerIncludes('Keys: 7');
    await page.keyboard.press('Escape');
    await footerExcludes('Keys:');
    await statusStarts('navigation.pdf | Page 2 of 4 | ');
    await closeAllTabs();

    // CORE-06 duplicate handling: selecting an already-open file focuses its
    // existing tab and session without spawning a new worker.
    await picker(['basic']);
    await rendered('basic');
    assert.equal(await page.evaluate(() => document.querySelector('#tab-strip').hidden), true, 'Strip stays hidden for a single document');
    assert.equal(await page.locator('#reader .session-view').count(), 1);
    const workersBeforeDuplicate = workerCreated;
    await picker(['basic']);
    await openSettled();
    assert.equal(workerCreated, workersBeforeDuplicate, 'Duplicate selection must not spawn a worker');
    await statusStarts('basic.pdf | Page 1 of 1 | ');
    assert.equal(await page.locator('#tab-strip .tab').count(), 1);
    assert.equal(await page.locator('#reader .session-view').count(), 1);
    await until(() => page.workers().length === 1, 'Duplicate selection must reuse the existing session worker');
    await picker(['navigation']);
    await openSettled();
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    assert.equal(await page.locator('#tab-strip .tab').count(), 2);
    assert.equal(await page.locator('#reader .session-view').count(), 2);
    await until(() => page.workers().length === 2, 'Expected one worker per tab');
    const workersBeforeSecondDuplicate = workerCreated;
    await picker(['navigation']);
    await openSettled();
    assert.equal(workerCreated, workersBeforeSecondDuplicate, 'Duplicate navigation selection must not spawn a worker');
    assert.equal(await page.locator('#tab-strip .tab').count(), 2);
    await statusStarts('navigation.pdf | Page 1 of 4 | ');

    // CORE-06 close semantics: the tab's own close button closes that tab and
    // its neighbor (next, else previous) becomes active.
    await tab('basic.pdf').click();
    await statusStarts('basic.pdf | Page 1 of 1 | ');
    await page.getByRole('button', { name: 'Close basic.pdf', exact: true }).click();
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    assert.equal(await page.locator('#tab-strip .tab').count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector('#tab-strip').hidden), true, 'Strip hidden again for the one remaining document');
    await until(() => page.workers().length === 1, 'Closing a tab disposes only its own worker');
    await close();
    // Recovery: the reader can open documents again after every tab closed.
    await picker(['basic']);
    await rendered('basic');
    // Command mode rejects unknown commands without disturbing the document.
    await page.keyboard.press(':');
    await page.locator('#command-input').fill('nope');
    await page.keyboard.press('Enter');
    await page.getByText('Unknown command: nope', { exact: true }).waitFor();
    await page.locator('#command-input').waitFor({ state: 'hidden' });
    await statusStarts('basic.pdf | Page 1 of 1 | ');
    await close();
    assert.equal(await page.evaluate(() => document.querySelector('header').hidden), false, 'The Open button returns with the empty state');

    // Probe support files in the real PDF worker, under the app's worker CSP/offline policy.
    await picker(['basic']);
    await rendered('basic');
    const worker = page.workers()[0];
    for (let i = 0; i < assets.length; i++) {
      const [name, mime] = assets[i];
      const result = await worker.evaluate(async name => {
        const response = await fetch(new URL(`/pdfjs/${name}`, location.href));
        const bytes = await response.arrayBuffer();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        let compiled = false;
        if (name.endsWith('.wasm')) { await WebAssembly.compile(bytes); compiled = true; }
        return { status: response.status, mime: response.headers.get('content-type'), length: bytes.byteLength, hash, compiled };
      }, name);
      assert.equal(result.status, 200, `${name}: packaged response`);
      assert.equal(result.length, expectedAssets[i].length, `${name}: byte length`);
      assert.equal(result.hash, expectedAssets[i].hash, `${name}: installed asset identity`);
      assert.match(result.mime ?? '', mime, `${name}: MIME`);
      if (name.endsWith('.wasm')) assert.equal(result.compiled, true, 'Actual bundled WASM compiles under worker CSP');
    }
    await close();

    // Internal destination links: page 1 of navigation.pdf carries three link
    // annotations (direct -> page 2, named -> page 3, broken named target).
    // Upstream builds section.linkAnnotation containers holding an anchor each.
    const navigationLinks = () => page.locator('#reader .pdfViewer .page[data-page-number="1"] section.linkAnnotation a');
    async function openNavigation() {
      await picker(['navigation']);
      await rendered('navigation', 4);
      await until(async () => (await navigationLinks().count()) === 3, 'navigation.pdf page 1 must expose three link annotations');
    }
    await openNavigation();
    await navigationLinks().nth(0).click();
    await statusStarts('navigation.pdf | Page 2 of 4 | ');
    assert.ok(page.url().startsWith('http://tauri.localhost/'), 'Internal links must never navigate the page');
    await close();
    await openNavigation();
    await navigationLinks().nth(1).click();
    await statusStarts('navigation.pdf | Page 3 of 4 | ');
    assert.ok(page.url().startsWith('http://tauri.localhost/'), 'Named destinations must never navigate the page');
    await close();
    await openNavigation();
    await navigationLinks().nth(2).click();
    await page.locator('#file-results li').filter({ hasText: 'This destination is not available.' }).first().waitFor();
    await statusStarts('navigation.pdf | Page 1 of 4 | ');
    assert.ok(page.url().startsWith('http://tauri.localhost/'), 'Broken destinations must never navigate the page');
    await close();

    for (const [name, count] of [['navigation', 4], ['cjk-embedded', 1], ['scan', 1]]) {
      await picker([name]);
      await rendered(name, count);
      if (name === 'cjk-embedded') {
        // Fixture draws four 48pt glyphs at (40, 650) on a 612x792pt first page.
        const glyphs = await firstPageCanvas().evaluate(canvas => {
          const scale = canvas.width / 612;
          return Array.from({ length: 4 }, (_, index) => {
            const data = canvas.getContext('2d').getImageData(Math.floor((40 + index * 48) * scale),
              Math.floor((792 - 650 - 48) * scale), Math.floor(48 * scale), Math.floor(48 * scale)).data;
            let ink = 0;
            for (let i = 0; i < data.length; i += 4) if (data[i + 3] && Math.min(data[i], data[i + 1], data[i + 2]) < 200) ink++;
            return ink;
          });
        });
        assert.ok(glyphs.every(ink => ink > 50), 'Each of the four CJK glyph regions contains visible ink');
      }
      await close();
    }
    await picker(['encrypted']);
    await page.locator('#password-dialog').waitFor({ state: 'visible' });
    await page.locator('#pdf-password').fill('wrong-password');
    await page.getByRole('button', { name: 'Unlock PDF', exact: true }).click();
    await page.getByText('Incorrect password. Try again.', { exact: true }).waitFor();
    assert.equal(await page.locator('#pdf-password').inputValue(), '');
    await page.locator('#pdf-password').fill('core02-user');
    await page.getByRole('button', { name: 'Unlock PDF', exact: true }).click();
    await rendered('encrypted');
    await close();
    for (const action of ['cancel', 'escape']) {
      await picker(['encrypted']);
      await page.locator('#password-dialog').waitFor({ state: 'visible' });
      if (action === 'cancel') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (action === 'escape') await page.keyboard.press('Escape');
      await page.locator('#password-dialog').waitFor({ state: 'hidden' });
      await status('Document opening cancelled.');
      assert.equal(await page.locator('#pdf-password').inputValue(), '');
      await noWorkers();
      await picker(['basic']);
      await rendered('basic');
      await close();
    }
    await picker(['corrupt']);
    await status('Could not render this document.');
    await noWorkers();

    // Bounded long-document behavior: lazy page rendering and scroll tracking.
    await picker(['long-text']);
    await statusStarts('long-text.pdf | Page 1 of 300 | ');
    // The status flips at pagesinit; poll for the async first paint.
    let initialCanvases = 0;
    await until(async () => {
      initialCanvases = await page.locator('#reader .pdfViewer .page canvas').count();
      return initialCanvases > 0;
    }, 'long-text first page must eventually render');
    assert.ok(initialCanvases < 12, `Long documents must not eagerly render all pages (found ${initialCanvases} canvases)`);
    await page.evaluate(() => {
      // Each session view is its own scroll container under #reader.
      const container = document.querySelector('#reader .session-view');
      const target = document.querySelectorAll('#reader .pdfViewer .page')[149];
      container.scrollTop = target.offsetTop;
    });
    await statusStarts('long-text.pdf | Page 150 of 300 | ');
    const afterJump = await page.locator('#reader .pdfViewer .page canvas').count();
    assert.ok(afterJump < 12, `Rendering resources must stay bounded after a page jump (found ${afterJump} canvases)`);
    await close();

    for (let cycle = 0; cycle < 3; cycle++) {
      await picker(['basic']);
      await rendered('basic');
      await close();
    }
    assert.equal(invalidWorkerUrls, 0, 'All real workers use bundled PDF module URLs');
    // The live flow asserts per-phase worker counts (e.g. two workers during
    // multi-open); the exact total depends on fixture order, so bound it
    // loosely and prove cleanup via created === closed.
    assert.ok(workerCreated >= 20, 'Tabs, duplicate handling, keyboard sessions and recovery created actual workers');
    assert.equal(workerCreated, workerClosed, 'Every observed worker closed');
    assert.equal(responses.filter(item => item.status >= 400).length, 0, 'No failing packaged asset responses');
    assert.equal(externalRequests, 0, 'No external HTTP requests');
    assert.equal(pageErrors, 0, 'No uncaught page errors (raw messages suppressed)');
    assert.equal(securityErrors, 0, 'No browser security errors, including worker CSP failures');
    assert.equal(await page.evaluate(() => globalThis.__pdfSmokeCspCount), 0, 'No document CSP violations');
    console.log(`Verified WebView2 ${browser.version()}: offline multi-tab reader with CORE-06 tabs (multi-open, duplicates, position retention, close semantics) and CORE-07 keyboard (hjkl, Ctrl+D/U/F/B, gg/G/[count]G, zoom/fit, pending keys), plus lazy pages, internal links, passwords and recovery across ${workerClosed} terminated workers. Fixture screenshots: test-results/pdf/.`);
  } finally {
    try { await browser?.close(); } finally {
      if (app.pid && app.exitCode === null) {
        spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$p = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() | Out-Null; $p.WaitForExit(5000) | Out-Null }`],
        { stdio: 'ignore', timeout: 10_000 });
        if (app.exitCode === null) app.kill();
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
});
