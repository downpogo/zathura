# Design System Verification

Owner: OpenCode / gpt-6-astra, 2026-09-07.
Status: implemented and verified in the Windows release webview. Reader feature
work remains paused as requested; this does not advance the CORE-03/04 gate.

## Changes

- `src/tokens.css`: shared typography, spacing, sizing, shape, shadow, stacking,
  motion, semantic color and interaction-state tokens; OS-selected light/dark
  themes, forced system colors, reduced motion and coarse-pointer sizing.
- `src/style.css`: base, button and shell layers consume custom properties. No
  raw design colors, font values or geometry in component declarations.
- `index.html`: early stylesheet and color-scheme hint, reusable button class.
- `src/main.ts`: removed JS-dependent stylesheet import; file behavior unchanged.
- `tests/design-system.test.mjs`: nine PostCSS/source/contrast regression checks.
- `tests/windows-theme-smoke.mjs`: actual release WebView2 computed-style tests.
- `package.json`, `pnpm-lock.yaml`: pinned development-only PostCSS 8.5.28 and
  Playwright Core 1.63.0, plus `test:theme:windows`. No browser downloads or new
  runtime dependency. No Tauri permission/CSP or native theme override changes.
- `docs/design-system.md`, README and implementation plan: contributor policy
  and task status.

## Commands And Results

WSL2 Ubuntu 24.04.4 x64, Node 24.14.0, pnpm 10.32.1:

| Command | Result |
| --- | --- |
| `FIXTURE_PYTHON=/tmp/opencode/core02-venv/bin/python pnpm test` | 18/18 passed, including all nine design-system tests. |
| `pnpm build` | Passed TypeScript and production frontend build. |

Windows 11 build 26200 x64, Node 24.19.0, pnpm 10.32.1, Rust 1.93.0,
WebView2 152.0.4191.66, native source copy now at C:\zathura:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed. |
| `pnpm test` | 18/18 passed with FIXTURE_PYTHON set to the isolated Windows fixture venv. |
| `pnpm tauri build --no-bundle -- --locked` | Passed frontend checks and native release compilation. |
| `pnpm test:theme:windows` | Passed in the actual bundled Tauri WebView2 page. |

The native test observed OS-derived light at startup, then emulated light, dark,
and light again without reloading the app. It verified computed canvas/text/control
colors, hover states, inherited font/spacing/radius overrides, visible focus,
reduced-motion transitions, forced-system-color tokens, and critical control
bounds at an emulated 360x320 viewport. Enlarging root text to 200% caused no
horizontal overflow. No unhandled page errors were observed during those checks.

The test launches only its own app with a temporary WebView2 profile and a
process-scoped loopback debugging port. It closes that app and removes the
profile afterward. It does not send global keyboard input, open native file
dialogs, alter Windows appearance/registry, or change shipped app configuration.

## Findings Resolved

The initial dark border token fell below 3:1 against hover/pressed control
surfaces. Brightened the shared token; all tested control/focus pairs now pass
3:1 and all tested normal-text pairs pass 4.5:1 in both themes.

Native test development exposed test timing and floating-point assumptions:
wait for media/computed styles to settle after emulation, and tolerate half a CSS
pixel in bounds comparisons for scaled Windows displays. Actual observed footer
rounding was about 0.00001 CSS pixel beyond the nominal viewport, not hidden UI.
These were harness corrections, not concealed layout failures.

## Limits

No macOS/WKWebView or native Linux/WebKitGTK runtime theme verification. Native
window chrome and picker colors remain controlled by the OS, not CSS. The test
checks the current real OS preference plus emulated preference updates; it does
not toggle actual Windows system settings or claim title-bar screenshot testing.
Viewport/text emulation is not a comprehensive multi-monitor DPI/accessibility
audit. The design system styles the app shell, not PDF page content.
