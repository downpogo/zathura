# CORE-05 Verification — Continuous Reader And Document Lifecycle

Owner: OpenCode / gpt-6-astra, 2026-09-07.
Status: done on Windows (WebView2). macOS/WKWebView and native Linux/WebKitGTK
remain unverified. Search (NEXT-01), tabs (CORE-06) and Vim keys (CORE-07) are
separate items.

## Deliverables

- `src/document-session.ts`: one reusable document session wrapping the pinned
  PDF.js viewer components — `EventBus`, `PDFLinkService` (sanitized subclass),
  and `PDFViewer` — over the existing matching module worker and `getDocument`
  policy from CORE-04. The session exposes the shared operations from the plan:
  scroll-to-page (bounds-validated one-based physical pages), destination
  navigation, zoom in/out/reset/fit-width/fit-page, and deterministic disposal;
  plus observable state: session identity (`id` symbol), page count, current
  page and zoom label, delivered through an `onState` callback.
- `ReaderLinkService`: resolves direct and named destinations itself instead of
  upstream `PDFLinkService#goToDestination`, which logs destination names and
  page references (untrusted PDF content) to the console. Broken destinations
  produce nonfatal feedback; nothing is logged. `externalLinkEnabled = false`
  makes external URI anchors non-navigating at the component level, in addition
  to the Rust navigation lock.
- `src/main.ts` / `index.html`: continuous reader replaces the single-canvas
  proof. Header gains a Close button and a zoom control group (out/in/reset/
  fit-width/fit-page, aria-labelled). Status bar: `name | Page x of y | zoom`.
- `src/viewer-overrides.css`: token-based overrides for the vendored
  `pdf_viewer.css` (unlayered upstream rules load after `style.css`; see
  docs/design-system.md). Page artwork keeps document colors.
- `src/pdf-proof.ts` and its tests are superseded by the session and removed;
  CORE-04 evidence documents the evolution.
- Tests: `tests/document-session.test.mjs` (16 lifecycle/stub tests),
  `tests/pdf-assets.test.mjs` guards updated, `tests/windows-pdf-smoke.mjs`
  rewritten for the continuous reader.

## Rendering Policy

`PDFViewer` owns page view creation, visible/nearby render scheduling, stale
render cancellation on zoom/scroll, text layer construction (selection/copy),
annotation layers, `--scale-factor` management and container resize observation.
The session sets `annotationMode: AnnotationMode.ENABLE` (links without form
interactivity), `enableAutoLinking: false`, `maxCanvasPixels: 8_000_000`,
`maxCanvasDim: 8_192`, the CORE-04 `getDocument` options (no eval, no system
fonts, no XFA, verbosity 0), a fetch-free localizer (upstream GenericL10n
fetches locale resources), and an `AbortSignal` for teardown.

Disposal mirrors the CORE-04 pattern: cancel pending password, abort signal
(removes resize listener, disconnects ResizeObserver), `pdfViewer.cleanup()`,
bounded (1 s) `loadingTask.destroy()` grace, then `PDFWorker` destroy and real
worker termination, viewer div removal; idempotent via a single disposal
promise. PDF.js does not handle window resize itself, so the session re-applies
fit presets (`page-width`/`page-fit`/`page-height`/`auto`) on window resize.

Two integration bugs were found by the native smoke and fixed:
- The reader container was hidden during `setDocument`; the viewer's render
  queue never saw a visible page and painted nothing. The shell now lays out
  the empty reader before session creation.
- Annotation links silently did nothing because the link service was never
  given the document/viewer; `setDocument`/`setViewer` are now called before
  first paint.

## Commands And Results

WSL2 Ubuntu 24.04.4 x64 (Node 24.14.0, pnpm 10.32.1):

| Command | Result |
| --- | --- |
| `FIXTURE_PYTHON=... pnpm test` | 43/43 passed (16 new session tests). |
| `pnpm build` | Passed; vendor CSS bundled; worker emitted as hashed asset. |

Windows 11 build 26200 x64, Node 24.19.0, Rust 1.93.0, WebView2 152.0.4191.66,
C:\zathura:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed. |
| `pnpm test` | 60/60 passed (incl. 16 session + updated asset guards). |
| `pnpm tauri build --no-bundle -- --locked` | Passed. |
| `pnpm test:pdf:windows` | Passed (see below). |
| `pnpm test:theme:windows` | Passed (shell theming unaffected by vendor CSS). |

`test:pdf:windows` against the real release executable, network fully offline,
isolated temp WebView2 profile, no global keyboard input: opened fixtures
through the real native picker; first pages rendered with visible ink for
basic/navigation/cjk-embedded/scan/encrypted; canvas pixel hash unchanged
across dark/light theme emulation; Fit width rescaled the first page and reset
returned to 100%; Ctrl+O cancel kept the open document; internal links in
navigation.pdf navigated to pages 2 (direct) and 3 (named), the broken
destination produced 'This destination is not available.' without navigation;
long-text.pdf (300 pages) kept fewer than 12 canvases before and after jumping
to page 150 via container scroll (lazy rendering, no eager whole-book render);
password wrong/retry/correct plus cancel/escape/close-during-password recovered
each time; corrupt.pdf failed safely and the reader recovered; 20 workers
created and 20 terminated; zero external requests, zero page errors, zero CSP
violations, zero security log entries; page URL never left the packaged origin.
Fixture screenshots in test-results/pdf/ (manually inspected: text, CJK
glyphs, scan raster, encrypted page).

## Limits

- Single active session; multi-document tabs are CORE-06. Destination
  position/zoom handling is inherited from `scrollPageIntoView` and gets its
  dedicated acceptance work (outline tree, focus rules) in CORE-08/09.
- Text selection/copy is provided by the viewer's text layer and verified as
  enabled/layer-correct; an automated clipboard assertion was not added.
- Zoom steps use upstream `increaseScale`/`decreaseScale` presets; keyboard
  bindings (`+`/`-`/`=`/`a`/`s`) are CORE-07.
- macOS and native Linux remain unverified. Performance budgets, memory
  ceilings and repeated-session leak audits belong to CORE-10.
