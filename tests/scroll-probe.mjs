import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const pdf = process.argv[2];
assert.ok(pdf, 'usage: node tests/scroll-probe.mjs <pdf-path>');
const executable = join(root, 'src-tauri/target/release/local-pdf-reader.exe');
const profile = await mkdtemp(join(tmpdir(), 'zathura-scroll-'));
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const app = spawn(executable, [], {
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` },
  stdio: 'ignore',
});
let browser;
try {
  const deadline = Date.now() + 30_000;
  let endpoint;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      endpoint = (await response.json()).webSocketDebuggerUrl;
      if (endpoint) break;
    } catch { await delay(250); }
  }
  assert.ok(endpoint, 'CDP endpoint unavailable');
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  let page;
  while (Date.now() < deadline) {
    page = context.pages().find(candidate => candidate.url().startsWith('http://tauri.localhost/'));
    if (page) break;
    await delay(100);
  }
  assert.ok(page, 'app page not found');
  await page.locator('#empty-reader').getByText('No document open.', { exact: true }).waitFor();
  // Drive the real picker with the absolute path.
  const script = join(root, 'tests/windows-picker.ps1').replaceAll("'", "''");
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$paths = [Console]::In.ReadToEnd(); & '${script}' -ProcessId ${app.pid} -Action Select -PathsJson $paths`],
    { stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify([pdf]));
  await page.keyboard.press('Control+o');
  await new Promise(resolve => child.on('exit', resolve));
  await page.waitForFunction(() => /^1\//.test(document.querySelector('#status-pages')?.textContent ?? ''), null, { timeout: 60_000, polling: 250 });
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => !document.querySelector('#outline').hidden, null, { polling: 250 });
  await delay(1000);
  const report = await page.evaluate(() => {
    const elements = [
      ['html', document.documentElement],
      ['body', document.body],
      ['main', document.querySelector('main')],
      ['#outline', document.querySelector('#outline')],
      ['#reader', document.querySelector('#reader')],
      ['.session-view(active)', document.querySelector('#reader .session-view.active-view')],
    ];
    return elements.map(([name, element]) => {
      if (!element) return { name, missing: true };
      const style = getComputedStyle(element);
      return {
        name,
        scrollH: element.scrollHeight, clientH: element.clientHeight,
        scrollW: element.scrollWidth, clientW: element.clientWidth,
        vScrollbarPx: element.offsetWidth - element.clientWidth,
        hScrollbarPx: element.offsetHeight - element.clientHeight,
        scrollbarWidthCss: style.scrollbarWidth,
        overflowCss: style.overflow,
        heightCss: style.height, minH: style.minHeight,
      };
    });
  });
  console.log(JSON.stringify(report, null, 1));
} finally {
  await browser?.close();
  if (app.pid && app.exitCode === null) {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() | Out-Null; $p.WaitForExit(5000) | Out-Null; if (-not $p.HasExited) { $p.Kill() } }`],
      { stdio: 'ignore', timeout: 10_000 });
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
