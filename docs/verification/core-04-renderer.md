# CORE-04 Renderer Module

Date: 2026-09-07. Owner: OpenCode / rendering module agent.
Status: implemented and unit-tested; **CORE-04 is not done**. Parent owns UI,
asset/CSP integration and actual Windows packaged offline proof. WKWebView and
WebKitGTK remain unverified. CORE-02 and CORE-03 prerequisite gates were complete
in the implementation plan when this work started.

## Owned Files

- `src/pdf-proof.ts`
- `tests/pdf-proof.test.mjs`
- `tests/helpers/pdfjs-stub.mjs`
- `docs/verification/core-04-renderer.md`

No entrypoint, HTML, CSS/tokens, manifest, configuration or implementation-plan
edits were made by this agent.

## Integration Contract

```ts
import { PdfProof, PdfProofError } from './pdf-proof';

const proof = new PdfProof(canvas, requestPassword);
// requestPassword: (reason: 'required' | 'incorrect') => Promise<string | null>
const { pageCount } = await proof.load(bytes); // bytes: Uint8Array
await proof.dispose();
```

- One load per instance; success means physical page 1 finished rendering.
- `load(data: Uint8Array): Promise<{ pageCount: number }>` consumes native binary
  bytes. PDF.js may transfer/detach their backing buffer. Do not reuse those bytes
  or expect a retained copy. The whole-file native transport cost remains.
- `dispose(): Promise<void>` is idempotent and returns the same promise on repeated
  calls. It cancels rendering, rejects a pending PDF.js password request, destroys
  the loading task, destroys the PDFWorker wrapper and terminates the real Worker.
  It zeros both canvas dimensions before resolving. Await it before giving that
  canvas to another instance; parent still owns generation checks and status UI.
- Loading and rendering promises race session cancellation. Late page/password
  completions cannot restart rendering. Abandoned load promises have an internal
  rejection observer without hiding the rejection from callers.
- Password `null` cancels the session. Each wrong-password request invokes the
  callback again with `incorrect`. Callback exceptions produce a generic failure.
  No password persistence, logging or document metadata lookup is performed.
  Parent must dismiss its own prompt on session replacement; this callback API
  cannot close a parent-owned dialog or cancel its pending promise.
- Errors are `PdfProofError` with `code: 'cancelled' | 'render_failed'`. Messages
  are fixed strings without upstream error causes, document contents or filenames.
  Parent should use the code, not render raw third-party errors.
- A second load is rejected without disrupting the first. Loading after disposal
  is cancelled. Failures during opening automatically dispose the session.
- Worker `error`/`messageerror` events fail pending load and dispose without a
  fallback. After load has already resolved, worker failure still clears/disposes
  but cannot report a new error through the resolved promise; no event API is
  introduced for this one-page proof.

## Rendering And Security

Pinned display import: `pdfjs-dist/legacy/build/pdf.mjs` (6.3.289).
Matching worker import: `pdfjs-dist/legacy/build/pdf.worker.mjs?url`, verified to
exist in the installed package. Vite emits the worker as a static hashed asset.
`new Worker(workerUrl, { type: 'module' })` is passed to
`PDFWorker.create({ port, verbosity: 0 })`. No GlobalWorkerOptions, blob wrapper,
remote worker, sandbox bundle, or fake-worker path is used.

The installed v6 declaration incorrectly restricts the PDFWorker constructor's
port to null; its documented `create` method correctly accepts Worker and delegates
to that constructor. The port-initialization source bypasses fallback. PDF.js does
not terminate an externally supplied Worker when destroying the wrapper, hence
explicit native Worker termination here.

Only canvas rendering is used, with `AnnotationMode.DISABLE`: no text, annotation,
interactive form, attachment, link, XFA or scripting layer is instantiated. PDF
actions are not executed. No viewer UI/components are selected yet for CORE-05;
the legacy display API is the established baseline, not a continuous-reader design.

`getDocument` receives `data`, `enableXfa: false`, `useSystemFonts: false`,
`isEvalSupported: false`, and `verbosity: 0`. Inspection of the pinned source shows
v6 no longer reads `isEvalSupported`; it remains an explicit policy option here.
A source search found no eval or Function-constructor execution in the display or
worker (the sole `new Function` prefix match was `new FunctionBasedShading`).
This is not a complete upstream security audit. Verbosity zero suppresses PDF.js
ordinary info/warning helpers in display and worker; some bundled WASM glue has
direct console diagnostics independent of that setting. No global console patch
or claim that every dependency diagnostic is suppressed is made.

Scale is fixed at `96 / 72` PDF-point-to-CSS-pixel conversion, not fit or 1.25x.
No DPR multiplication, resize handling, zoom, tabs or continuous layout. The
backing canvas is reduced for an 8,000,000-pixel area limit and an 8192-pixel
per-axis limit; positive finite geometry is required. Numeric canvas dimensions
are floored, so at most a fractional edge pixel is clipped. Parent supplies
responsive CSS such as maximum inline size and proportional block size. There
are no inline-style writes or palette changes. Canvas bounds do not bound decoded
images, internal PDF.js scratch canvases, fonts or total process memory.

Disposal allows up to 1000 ms for normal PDF.js render/loading-task teardown, then
forcibly terminates the real worker. Installed loading-task destruction waits for
setup and transport acknowledgements, which can otherwise wait forever after
worker failure. Timers are cleared and teardown rejections observed. A timed-out
upstream destroy promise may remain unsettled; this is not proof of complete
upstream heap reclamation. Repeated-open memory inspection belongs to native proof
and CORE-10.

## Parent Asset/CSP Requirements

Copy all supporting assets from this exact pinned release in dev and build:

| Package Directory | Packaged Directory | getDocument Option |
| --- | --- | --- |
| `cmaps/` | `public/pdfjs/cmaps/` | `cMapUrl`, `cMapPacked: true` |
| `standard_fonts/` | `public/pdfjs/standard_fonts/` | `standardFontDataUrl` |
| `wasm/` | `public/pdfjs/wasm/` | `wasmUrl` |
| `iccs/` | `public/pdfjs/iccs/` | `iccUrl` |

Every base is `new URL('pdfjs/<directory>/', document.baseURI).href`, including
the trailing slash. Preserve package license/notices. Worker is bundled by Vite,
not separately copied from another release. No CDN or document URL is used.

- Permit same-origin module worker with `worker-src 'self'` and its script with
  `script-src 'self'`. This module does not need `blob:` for worker creation.
- Permit bundled asset fetches from the packaged origin in `connect-src`, keeping
  native IPC permissions narrowly scoped separately. Verify dev and packaged
  origin semantics rather than assuming a browser origin is equivalent.
- WASM compilation needs the webview-supported narrow `script-src
  'wasm-unsafe-eval'` allowance, not general `'unsafe-eval'`. Serve WASM with
  `application/wasm`; module workers require a JavaScript MIME type. Inspect
  actual WKWebView/WebKitGTK support before deciding alternative configuration.
- PDF.js embedded/local font loading and SVG filter/image internals may require
  `font-src`/`img-src` data/blob allowances depending on the active browser code
  path. Establish the narrow policy using native asset/CSP inspection. No remote
  origins or executable inline content should be enabled to silence violations.
- The existing four-glyph embedded CJK fixture does not establish external CMap,
  ICC or every WASM decoder execution. Verify packaged inventory and exercise
  the relevant paths rather than claiming all assets were fetched from that PDF.

## Verification

WSL/Linux workspace, Node v24.14.0; no browser/webview used by these tests.

```sh
pnpm typecheck
node --test tests/pdf-proof.test.mjs tests/design-system.test.mjs
env FIXTURE_PYTHON=/tmp/opencode/core02-venv/bin/python pnpm test
pnpm exec node --input-type=module -e 'import { build } from "vite"; const output = await build({ configFile: false, build: { write: false, minify: false, rollupOptions: { input: "src/pdf-proof.ts", preserveEntrySignatures: "strict" } } }); for (const item of output.output) console.log(item.fileName);'
```

Typecheck passes. Initial focused run: 23/23 tests passed (14 renderer, 9 design
system). Initial full suite: 32/32 passed with the existing fixture venv selected.
Plain `pnpm test` first failed only because default Python lacked fontTools;
using the documented existing venv resolved that prerequisite without installing
or changing dependencies. Final expanded full suite: **35/35 passed**, including
17 renderer tests; final `pnpm typecheck` also passed. No failed/skipped tests or
unhandled rejections were reported in that final run.

Vite 7.3.1 in-memory production build passes and emits
`assets/pdf-proof-DeIqxMkJ.js` and `assets/pdf.worker-DTrjDNvb.mjs`. This explicitly
builds the owned module even before parent imports it, writes no output files,
and does not establish integrated asset copying or packaged CSP behavior.

Node module hooks replace the exact display and Vite worker-URL imports. Tests
exercise real TypeScript control flow, not real parsing, pixels, workers or DOM.
They cover ready, secure options, password retry/cancel/failure, load/page/render/
password disposal races, queued-success cancellation, repeated disposal, worker
construction/failure with bounded teardown, safe errors, canvas bounds, invalid
geometry and installed version agreement. Node's runner also detects unhandled
rejections; deferred doubles do not establish browser scheduling equivalence.

## Open Native Gate

Parent must record actual packaged Windows/WebView2 offline fixture rendering,
text/image/CJK visual fidelity, real worker and supporting-asset/CSP evidence,
correct/wrong/cancel passwords, corrupt recovery, rapid replacement, close during
load/render/password, and repeat-open resource behavior. Parent owns UI/status
integration and generation guards. No Windows native proof was run by this agent;
no CORE-04 completion or cross-platform compatibility is claimed.

## Parent Native Proof (Closing Update)

Status: **closed on Windows.** The parent integrated this module into
`src/main.ts`, bundled the worker with Vite, copied support assets via
`scripts/prepare-pdf-assets.mjs` (dev/build/test hook), and extended the CSP
(`script-src 'wasm-unsafe-eval'`, `worker-src 'self'`, blob/data font/image
allowances). Tauri request hooks serve `/pdfjs/` assets with explicit MIME types
(`.bcmap`/`.pfb` octet-stream, `.ttf` font/ttf, `.icc` vnd.iccprofile, `.wasm`
application/wasm) because WebView2's protocol handler reported `text/html`;
hashes verify the bytes are unchanged. Navigation is restricted to the reader
entrypoint, and new windows are denied. A lifecycle review found one real race
(close during a pending picker selection could let the abandoned selection
reopen a document); fixed with explicit open/abandoned request tokens and
covered by the native cancel/close workflow.

Native evidence, Windows 11 build 26200 x64, WebView2 152.0.4191.66, from
C:\zathura with `pnpm tauri build --no-bundle -- --locked` then
`pnpm test:pdf:windows` (tests/windows-pdf-smoke.mjs + tests/windows-picker.ps1):
real release executable, isolated temp WebView2 profile, loopback CDP only, no
global keyboard input, network fully offline (`navigator.onLine` false, all
external requests blocked/zero), packaged `tauri.localhost` origin:

- Native multi-select of basic+navigation through the real picker; binary reads;
  first-page rendering with visible nonblank pixels; page counts 1 and 4.
- Canvas pixel hash identical across dark/light theme emulation (PDF pixels
  never recolored); screenshots saved to test-results/pdf/ and visually
  inspected (text, four CJK glyphs, SCAN 01 raster, encrypted page).
- Real module workers only (`/assets/pdf.worker-*.mjs`); 15 created, 15 closed
  across repeated open/close; forged `read_pdf_file`/`release_pdf_file` handles
  rejected with `invalid_handle`.
- Worker-fetched support assets byte/hash-match the installed 6.3.289 release
  (representative bcmap, LiberationSans TTF, ICC, qcms WASM); WASM compiles in
  the worker under CSP; bundled module MIME verified via actual fetches.
- Password: required prompt, wrong-password retry message, correct unlock,
  Cancel/Escape/close-during-password all recover with no leftover workers;
  corrupt.pdf shows the generic render error and the reader recovers.
- Zero page errors, zero CSP violations, zero security log entries, zero
  external requests; no document content or paths logged.
- Windows `cargo test --locked` 12/12 (incl. new navigation/MIME tests),
  clippy `-D warnings` and rustfmt pass; WSL full suite 44/44.

Remaining: WKWebView/WebKitGTK unverified (no macOS/native Linux runner);
multi-document tabs, continuous scroll, zoom/fit, text selection are CORE-05/06;
this gate proves one selected document's first page only.
