# Core PDF Reader Implementation Backlog

Status: core implementation authorized by the user on 2026-09-07, with verification
required before advancing each dependency gate. Use pnpm. Windows 11 is the primary
test target; the development workspace is in WSL2. Optional NEXT items remain deferred.

## Goal And Decisions

Build a Zathura-inspired desktop reader: open the app, select local PDFs, read
them, navigate with Vim-style keys, and use their embedded table of contents.

- Selected stack: Tauri 2 + TypeScript + PDF.js, with Tauri's bundler.
- Target Windows 11 and macOS first; also validate an explicitly named Linux distribution.
- Proposed frontend default: Vite and vanilla TypeScript. Avoid adding a UI framework unless the implementation demonstrates a concrete need.
- Use locally bundled PDF.js viewer components where practical; do not build a PDF parser or rely on a remote viewer.
- Continuous vertical scrolling, a quiet status bar, an optional outline sidebar, and compact tabs for multiple PDFs.
- Support native file selection, mouse/trackpad reading, and keyboard reading. This is not a promise of complete Zathura parity.
- No backend, accounts, telemetry, RAG, AI, OCR, annotation editing, advanced forms, signature validation, or plugin system in this backlog.
- Ordinary text search and persisted reading history are separate follow-up items, not blockers for the requested core.

Research and primary sources: [Desktop PDF Reader Stack](research/desktop-pdf-stack.md).
The user-selected Tauri decision supersedes the original Electron recommendation.

## Agent Workflow

1. Read this document, the research note, and the current code before changing anything.
2. Confirm the assigned item's dependencies are complete. If not, report the blocker rather than silently implementing unrelated items.
3. Mark the item in progress with the agent/session identifier. Do not overwrite another agent's work.
4. Keep changes within the item's scope. Coordinate shared entry points, dependency manifests, and Tauri configuration before parallel edits.
5. Add tests for the changed behavior, run the relevant checks, and record exact commands and results.
6. Update the item with changed files, decisions, remaining limitations, and verification evidence. Only mark it done when its acceptance criteria are satisfied; distinguish implemented from platform-verified.
7. Do not commit, publish, purchase signing services, or introduce additional features unless explicitly requested.

Use this handoff format under the relevant item:

```text
Owner:
Status: not started | in progress | blocked | done
Changed files:
Decisions / interface changes:
Verification: commands, results, OS/webview versions
Remaining blockers / unverified platforms:
```

All items below start as **not started**. Paths mentioned as deliverables are
suggestions for future implementation, not files that already exist.

## Work Index

User-assigned prerequisite (2026-09-07): establish the UI design system before
further reader features. Owner: OpenCode / gpt-6-astra. Status: done for Windows
webview verification. Shared CSS tokens now cover typography, colors, spacing,
sizing, radii, borders, shadows and motion; light/dark follow OS preference live.
Verification: 18/18 Node tests on Windows/WSL, production/native Windows build,
and real WebView2 theme smoke pass. See docs/design-system.md and
docs/verification/design-system.md. Native chrome follows the OS; macOS/Linux
runtime checks remain unverified. This does not close CORE-03's remaining gate.

| ID | Work Item | Depends On | Category |
| --- | --- | --- | --- |
| CORE-01 | Bootstrap and support matrix | None | Core |
| CORE-02 | PDF fixtures and test foundations | CORE-01 | Core |
| CORE-03 | Authorized native file access | CORE-01 | Core |
| CORE-04 | Packaged PDF.js rendering proof | CORE-02, CORE-03 | Core |
| CORE-05 | Continuous reader and document lifecycle | CORE-04 | Core |
| CORE-06 | Multiple-document tabs | CORE-05 | Core |
| CORE-07 | Vim keyboard navigation | CORE-05 | Core |
| CORE-08 | Table of contents and destinations | CORE-05 | Core |
| CORE-09 | Keyboard/UI integration and accessibility | CORE-06, CORE-07, CORE-08 | Core |
| CORE-10 | Security and performance hardening | CORE-09 | Core |
| CORE-11 | Installers and platform acceptance | CORE-10 | Core release |
| NEXT-01 | Ordinary text search | CORE-09 | Optional follow-up |
| NEXT-02 | Local reading-state persistence | CORE-09 | Optional follow-up |

CORE-02 and CORE-03 can run in parallel after CORE-01. CORE-06, CORE-07, and
CORE-08 can run in parallel after CORE-05 establishes shared interfaces. They
must avoid concurrent edits to the application entry point; CORE-09 owns final
integration. Start native build smoke checks at CORE-01 and packaged webview
checks at CORE-04, not only at release time.

## Shared Design Boundaries

- Rust/Tauri owns native dialogs and authorized read-only document access. The frontend must not gain unrestricted filesystem, shell, or arbitrary URL access.
- TypeScript owns UI, document sessions, and commands. PDF.js and its matching worker own PDF processing.
- CORE-03 defines the open/read/release boundary and its error behavior. Prefer documented scoped plugins if sufficient; custom Rust commands must enforce their own authorization.
- CORE-05 defines the active-document operations consumed by later items: scroll, navigate to a physical page, navigate to a PDF destination, change zoom/fit, and dispose.
- CORE-05 also defines observable state: session identity, loading/error state, page count, current page, and zoom mode. Do not invent a plugin framework or global event bus for these operations.
- UI page numbers and numeric jump commands are one-based physical page numbers; convert at the PDF.js boundary. PDF page labels may be displayed separately if available.
- Every asynchronous document operation belongs to a session. A stale result from a closed or replaced session must never update the active document.
- File selection cancellation is normal, not an error. Document errors must not crash the whole application.
- Passwords stay in memory only. Do not log PDF contents, passwords, or sensitive file paths.

## CORE-01: Bootstrap And Support Matrix

Owner: OpenCode / gpt-6-astra, 2026-09-07
Status: done
Changed files: package.json, pnpm-lock.yaml, tsconfig.json, index.html, src/main.ts,
src/style.css, src-tauri/Cargo.toml, src-tauri/build.rs, src-tauri/src/main.rs,
src-tauri/tauri.conf.json, rust-toolchain.toml, tests/bootstrap.test.mjs,
.gitignore, README.md, docs/verification/core-01.md, app-icon.svg,
src-tauri/icons/, src-tauri/Cargo.lock, tests/windows-shell-smoke.ps1.
Decisions / interface changes: pnpm; Windows 11 x64 primary test target. WSL2
checks do not establish Windows or clean native Linux support.
Verification: pnpm frozen install, typecheck, test (3/3), build pass on Windows
and WSL. Windows cargo check/test/clippy --locked, fmt --check, and pnpm tauri
build --no-bundle -- --locked pass. tests/windows-shell-smoke.ps1 confirms native
window title, responsiveness, bundled content, and clean close. Rust test harness
has zero tests at bootstrap. Windows build 26200 x64, WebView2 152.0.4191.66.
See docs/verification/core-01.md for exact commands and resolved versions.
Remaining blockers / unverified platforms: WSL Rust not installed; Linux native
and macOS checks remain unverified. macOS target unconfirmed. Windows bootstrap
acceptance is complete, not installer or full PDF reader acceptance.

**Depends on:** none.

**Scope:** Create the minimal Tauri 2 + TypeScript + Vite application and development
commands. Record exact dependency/toolchain versions and commit-ready lockfiles.
Establish a minimal empty reader window, not a dashboard or feature mockup.

**Deliverables:** Application skeleton, narrow initial Tauri capabilities/CSP,
typecheck/build/test commands, and README prerequisites. Record the selected
Windows, macOS, Linux, architecture, and webview test targets. Ask the user if
their macOS version or hardware is needed to settle a support decision.

**Acceptance criteria:**

- A clean dependency install and TypeScript production build work.
- The native shell launches on the available development OS, or the exact missing prerequisite is recorded as a blocker.
- The README distinguishes development prerequisites from end-user requirements.
- Windows/macOS support is not claimed from a Linux-only build. Unavailable platform checks remain explicitly unverified.
- No remote assets, broad filesystem capability, updater, analytics, or unused plugins are added.

**Verification:** Typecheck, frontend build, native compile/launch smoke check.

## CORE-02: PDF Fixtures And Test Foundations

Owner: OpenCode / CORE-02 fixture agent, 2026-09-07
Status: done
Changed files: fixtures/ (nine PDFs, manifest, license, setup docs/requirements),
scripts/generate-fixtures.py, tests/fixtures.test.mjs, tests/validate-fixtures.py,
docs/verification/core-02.md; this CORE-02 handoff only in the plan.
Decisions / interface changes: Reuse node --test through pnpm; dev-only Python
pypdf 6.1.1/fonttools 4.59.2 setup required (FIXTURE_PYTHON override). No package,
runtime dependency or reader changes. Original CC0 synthetic content/font/images.
Verification: WSL Python 3.12.3; network-isolated pnpm test 9/9 and direct parser
checks 7/7 pass. All PDFs/manifest regenerate byte-for-byte. Exact commands,
metrics, targets/passwords and limitations: docs/verification/core-02.md.
Additional verification: Windows Python 3.12.10, isolated pinned fixture tools,
pnpm test 9/9 including parser checks and byte-for-byte regeneration pass.
Remaining blockers / unverified platforms: No CORE-02 blocker.
macOS/native Linux unverified; packaged rendering/password cancel/native reader
verification remains CORE-04, not established by parser tests.

**Depends on:** CORE-01.

**Scope:** Establish lightweight unit tests and a documented PDF fixture set that
later items can reuse. Do not implement reader behavior here.

**Deliverables:** A test runner, fixture manifest with provenance/licenses and
expected behavior, and small redistributable fixtures or deterministic fixture
generation. Large performance fixtures can have documented retrieval/generation
instructions instead of being checked in.

**Acceptance criteria:**

- Cover basic text, multiple pages, nested/no outline, named/direct destinations, differing page sizes, CJK/embedded fonts, scanned images, encrypted PDFs, and corrupt input.
- Record known outline targets and test passwords; use only synthetic/public test data.
- Include a long text document and image-heavy document for manual performance checks, with their page counts and byte sizes recorded.
- Tests run without downloading fixtures or accessing the network after setup.
- Fixture construction tools do not become application runtime dependencies.

**Verification:** Run the test command and check fixture provenance and expected results.

## CORE-03: Authorized Native File Access

Owner: OpenCode / CORE-03 native boundary, 2026-09-07
Status: done
Changed files: src-tauri/src/main.rs, src-tauri/src/native_files.rs,
src-tauri/Cargo.toml, src/native-files.ts, tests/native-files.test.mjs,
docs/verification/core-03.md, package.json, pnpm-lock.yaml, src-tauri/Cargo.lock,
index.html, src/main.ts, src/style.css, tests/windows-files-smoke.ps1.
Decisions / interface changes: Rust-only native picker and checked select/read/release
commands; opaque handles and binary whole-file transport. Open button and native
Open shortcuts integrated. This transport proof releases handles after each read;
it does not retain documents or render PDFs yet.
Verification: WSL and Windows pnpm test 9/9, production frontend builds pass.
Windows cargo check/test/clippy --locked pass (10 Rust tests), rustfmt applied,
release executable builds. Native picker and single-file binary read observed;
user confirmed manual picker operation. Windows WebView2 152.0.4191.66.
Final Windows gate: tests/windows-files-smoke.ps1 -Root C:\zathura
-InteractiveConfirmed passes real button, owned native multi-file picker, binary
reads of both fixtures, Ctrl+O, cancellation preserving results, and clean close.
Fixed harness to set/verify the native filename edit field with absolute paths
before clicking Open; remembered picker folders cannot redirect the test.
Remaining blockers / unverified platforms: Linux/macOS native checks unverified;
Windows CORE-03 gate complete. Earlier inconclusive runs are not counted as passes.

**Depends on:** CORE-01.

**Scope:** Implement native multi-file selection and a narrowly authorized,
read-only path for delivering selected PDF bytes to the frontend.

**Deliverables:** Typed frontend boundary, Tauri capabilities or checked Rust
commands, and tests for authorization/error handling. Document authorization
lifetime and how resources are released; do not assume a dialog or plugin grants
custom commands permission automatically.

**Acceptance criteria:**

- Open action and Ctrl+O/Cmd+O invoke a native picker supporting multiple PDFs.
- Cancel leaves existing documents unchanged.
- Selected files can be read; an arbitrary unselected path requested by frontend code is denied.
- Missing, unreadable, empty, and non-PDF selections return recoverable results. An extension filter is not treated as file validation.
- Use binary transport, not base64 or JSON number arrays. Document full-file copying costs if using whole-file reads.
- No recursive home-directory access or write permission is granted.

**Verification:** Authorization unit/integration tests and native picker smoke test.

## CORE-04: Packaged PDF.js Rendering Proof

Owner: OpenCode / gpt-6-astra, 2026-09-07
Status: done (Windows verified)
Changed files: src/pdf-proof.ts, src/main.ts, index.html, src/style.css,
src/tokens.css, scripts/prepare-pdf-assets.mjs, package.json, pnpm-lock.yaml,
src-tauri/tauri.conf.json, src-tauri/src/main.rs, src-tauri/src/native_files.rs,
src-tauri/Cargo.lock, tests/pdf-proof.test.mjs, tests/helpers/pdfjs-stub.mjs,
tests/pdf-assets.test.mjs, tests/windows-pdf-smoke.mjs, tests/windows-picker.ps1,
docs/verification/core-04-renderer.md.
Decisions / interface changes: PDF.js 6.3.289 pinned with matching Vite-bundled
module worker; canvas-only rendering (AnnotationMode.DISABLE, no XFA/scripting/
attachments/links); PdfProof owns load/dispose with password callback; support
assets (cmaps/standard_fonts/wasm/iccs/LICENSE) copied from the installed release
into public/pdfjs; CSP adds wasm-unsafe-eval and self worker; Rust hooks fix
asset MIME and restrict navigation/new windows.
Verification: WSL suite 44/44; Windows release build; cargo test --locked 12/12,
clippy, fmt. Native offline proof on WebView2 152.0.4191.66: real picker
multi-select, binary transport, first-page pixels for text/CJK/scan/encrypted,
pixel hash unchanged across themes, wrong/correct/cancel password flows, corrupt
recovery, 15/15 workers terminated, zero CSP/page errors/external requests,
support assets hash-verified and WASM compiled in-worker. Screenshots in
test-results/pdf/. See docs/verification/core-04-renderer.md.
Remaining blockers / unverified platforms: WKWebView/WebKitGTK unverified. One
selected document's first page only; continuous reader/sessions (CORE-05), tabs
(CORE-06) still open.

**Depends on:** CORE-02, CORE-03.

**Scope:** Prove one selected local PDF renders in a packaged Tauri application
using a real PDF.js worker and bundled supporting assets.

**Deliverables:** Pinned matching PDF.js/worker setup, offline asset configuration,
minimal single-document rendering, and loading/password/error states. Record
which viewer components and PDF.js build will be used by CORE-05.

**Acceptance criteria:**

- A packaged app renders text, images, and relevant font fixtures with the network disabled.
- Worker, fonts, CMaps, and other assets required by the pinned release load from the packaged origin under the production CSP.
- Correct password, wrong-password retry, and password cancellation behave correctly; passwords are not persisted.
- Corrupt/unsupported input shows an error and allows opening another document.
- PDF scripting and attachment launching are disabled. PDF content cannot navigate the application webview away from the reader.
- Run this proof on WebView2, WKWebView, and WebKitGTK when available; explicitly block cross-platform verification if a runner or machine is unavailable.

**Verification:** Packaged offline smoke tests against fixtures, worker/asset
inspection, and recorded OS/webview versions. A Chromium browser preview is not
evidence of Tauri webview compatibility.

## CORE-05: Continuous Reader And Document Lifecycle

Owner: OpenCode / gpt-6-astra, 2026-09-07
Status: done (Windows verified)
Changed files: src/document-session.ts, src/main.ts, index.html, src/style.css,
src/viewer-overrides.css, src/tokens.css (dialog/overlay tokens), src/native-files.ts
(unchanged), scripts none; tests/document-session.test.mjs,
tests/helpers/session-stub.mjs, tests/pdf-assets.test.mjs,
tests/windows-pdf-smoke.mjs, docs/verification/core-05.md; src/pdf-proof.ts and
tests/pdf-proof.test.mjs removed (superseded).
Decisions / interface changes: session wraps PDFViewer/EventBus/PDFLinkService
(pinned 6.3.289 viewer components) with a sanitized link service (no destination
logging, externalLinkEnabled false); shared operations scroll/page/dest/zoom/
dispose and observable state per the plan boundaries; fetch-free l10n;
viewer CSS vendored with token overrides in src/viewer-overrides.css.
Verification: WSL suite 43/43; Windows suite 60/60, release build, cargo
unchanged. Native offline proof (WebView2 152.0.4191.66): lazy rendering
(<12 canvases on a 300-page fixture, before/after a page-150 jump), fit-width/
reset zoom, internal direct/named link navigation, broken-destination feedback,
theme-change pixel stability, password flows, corrupt recovery, Ctrl+O cancel,
20/20 workers terminated, zero external requests/CSP violations/page errors.
See docs/verification/core-05.md.
Remaining blockers / unverified platforms: macOS/WebKitGTK unverified. Tabs
(CORE-06), Vim keys (CORE-07), outline tree (CORE-08) still open; clipboard
assertion manual-only; performance budgets deferred to CORE-10.

**Depends on:** CORE-04.

**Scope:** Turn the rendering proof into a reusable document session and continuous
reader. Establish the shared operations/state described above before downstream
agents begin.

**Deliverables:** Continuous scrolling, current-page tracking, zoom/reset,
fit-width/fit-page modes, text selection, internal destination navigation, and
deterministic disposal. Favor PDF.js viewer components for text layers and render
scheduling rather than duplicating their behavior.

**Acceptance criteria:**

- Only visible/nearby pages keep active rendering resources; a long book does not eagerly render all pages.
- Rapid scrolling, page jumps, resizing, and repeated zoom changes cannot show stale page renders or break selection alignment.
- Fit modes react to viewport changes, including opening a sidebar.
- Current-page status follows scrolling; page jumps validate bounds.
- Text can be selected and copied using platform-standard shortcuts. Image-only scans remain readable without OCR.
- Internal links navigate within the current document. External links remain blocked until a safe user-initiated HTTP(S) opening path is implemented.
- Closing during load/render/password entry cancels outstanding work and releases resources without unhandled errors.

**Verification:** Unit tests for page/zoom state and lifecycle races; fixture-based
reader smoke tests; long-document rendering/cache inspection.

## CORE-06: Multiple-Document Tabs

Owner: OpenCode / gpt-6-astra, 2026-09-07
Status: done (Windows verified)
Changed files: src/tabs.ts, src/main.ts, index.html, src/style.css,
tests/windows-pdf-smoke.mjs, docs/verification/core-06.md.
Decisions / interface changes: TabStrip with role=tab buttons (hidden for one
document); one session/view per file, inactive views keep layout via
visibility:hidden (position/zoom persist, no rendering); sessions hold native
handles for lifetime so identity dedup focuses existing tabs; neighbor rule
next-else-previous; gt/gT wired (user-directed minimal UI).
Verification: WSL 68/68; Windows full suite, release build, and native smoke
(multi-open, duplicate focus, position retention ±1px, close semantics, per-tab
worker disposal, recovery) pass offline in WebView2 152.0.4191.66. See
docs/verification/core-06.md.
Remaining blockers / unverified platforms: macOS/WebKitGTK unverified; no
tab reordering; CORE-09 owns final focus integration.

**Depends on:** CORE-05.

**Scope:** Coordinate multiple document sessions with a compact tab strip. Keep
the tab UI hidden or unobtrusive for a single document.

**Acceptance criteria:**

- Selecting several PDFs opens independently managed sessions; one failed file does not prevent the others opening.
- Switching tabs retains page/scroll position and zoom in memory.
- Closing an active tab selects a predictable neighboring tab; closing the final tab returns to the open screen.
- Inactive documents do not continue rendering offscreen pages. Closing releases their PDF.js resources.
- Duplicate selection behavior is explicit and tested; default to focusing an existing session when native file identity can be established safely.
- Expose next/previous-document operations for CORE-09 without independently adding a competing keyboard listener.

**Verification:** Session/tab tests, mixed success/failure opening, rapid switch/close tests.

## CORE-07: Vim Keyboard Navigation

Owner: OpenCode / gpt-6-astra, 2026-09-07
Status: done (Windows verified)
Changed files: src/keyboard.ts, tests/keyboard.test.mjs, src/main.ts,
index.html, src/style.css, tests/windows-pdf-smoke.mjs,
docs/verification/core-07.md.
Decisions / interface changes: parser-only module (no preventDefault; the
single dispatcher suppresses defaults for handled keys); all planned bindings
plus gt/gT and a `:` command mode where `q` closes the active document —
replacing the Close/zoom buttons per the user's minimal-UI direction (Open
PDFs is the only button). Pending input shows in the status bar; editable
targets, IME, dialogs and unbound keys are never intercepted.
Verification: 25 parser tests (WSL), full suite 68/68; Windows release smoke
exercises gg/G/[count]G, out-of-range feedback, pending display, Escape,
scroll/zoom/fit keys, gt/gT, `:q` and unknown-command feedback in the packaged
app offline. See docs/verification/core-07.md.
Remaining blockers / unverified platforms: macOS/WebKitGTK unverified; `?`
help and final focus rules are CORE-09.

**Depends on:** CORE-05.

**Scope:** Implement a small keyboard parser and reader command bindings, separate
from document rendering. Own the common focus-context rules used in CORE-09.

| Keys | Reading Action |
| --- | --- |
| h / j / k / l | Scroll left / down / up / right |
| Ctrl+D / Ctrl+U | Half viewport down / up |
| Ctrl+F / Ctrl+B | Full viewport down / up |
| gg / G | First / last page |
| 42G | Jump to physical page 42 |
| + / - / = | Zoom in / out / reset to 100% |
| a / s | Fit page / fit width |
| Escape | Cancel pending sequence and transient reader input |

**Acceptance criteria:**

- Numeric prefixes and multi-key sequences have deterministic handling for cancellation, invalid sequences, and overflow. Only the documented numeric page jump is required.
- Invalid page numbers do not crash or navigate out of bounds; feedback is visible.
- Pending input appears in the status bar and resets on focus loss or document switch.
- Editable fields, password prompts, IME composition, and standard copy/select shortcuts are not intercepted by reader commands.
- Only handled commands suppress webview defaults. Native picker and operating-system shortcuts remain usable.
- Keep a single command-dispatch path shared with UI actions; do not add configurable mappings or Vim emulation libraries for this scope.

**Verification:** Unit tests for sequences, counts, repeat events, focus contexts,
and modifier conflicts; native-webview shortcut smoke tests.

## CORE-08: Table Of Contents And Destinations

Owner: OpenCode / gpt-6-astra, 2026-09-07
Status: done (Windows verified)
Changed files: src/document-session.ts (outline()/relayout()), src/outline.ts,
src/main.ts, index.html, src/style.css, src/tokens.css,
tests/document-session.test.mjs, tests/helpers/session-stub.mjs,
tests/windows-pdf-smoke.mjs, docs/verification/core-08.md.
Decisions / interface changes: Tab toggles the sidebar from reading context;
outline nodes are plain {title, dest, children} with external URLs dropped;
destination resolution goes through the sanitized navigateToDest; no-outline
PDFs show exactly 'This PDF has no table of contents.'; ARIA tree pattern
(tree/treeitem/group); sidebar relayouts fit modes.
Verification: WSL 73/73; Windows full suite, release build, and native offline
smoke (tree order with literal titles, destinationless expansion, named jump
to page 3, broken-destination feedback, no-outline fallback, fit reflow with
sidebar open) pass in WebView2 152.0.4191.66. See docs/verification/core-08.md.
Remaining blockers / unverified platforms: macOS/WebKitGTK unverified; tree
keyboard ops and current-item highlight are CORE-09; no outline
virtualization (revisit under CORE-10 if measured).

**Depends on:** CORE-05.

**Scope:** Display the active PDF's embedded outline in a collapsible tree and
resolve its navigation destinations using the shared reader operations.

**Acceptance criteria:**

- Nested entries retain hierarchy and render labels as text, never HTML.
- Direct and named destinations navigate to the correct page and supported destination position/zoom.
- Missing/broken destinations produce nonfatal feedback; an outline entry without a destination can still expand children.
- PDFs without outlines show "This PDF has no table of contents." No generated or inferred contents are added.
- Provide tree actions for selection, collapse/expand, and activation so CORE-09 can wire j/k, h/l, and Enter.
- Loading an outline or resolving a destination for an inactive/closed session cannot change the current document.

**Verification:** Nested/no-outline fixtures, direct/named/broken destination tests,
and session-switch race tests.

## CORE-09: Keyboard/UI Integration And Accessibility

**Depends on:** CORE-06, CORE-07, CORE-08.

**Scope:** Integrate independently built features into one coherent reading flow.
Own changes to the main UI entry point and common focus handling at this stage.

**Acceptance criteria:**

- gt/gT switch documents; Tab toggles the outline from reading context; j/k, h/l, and Enter operate the focused outline.
- Escape dismisses transient UI and returns focus to reading without unexpectedly closing a document.
- Tab retains ordinary focus traversal inside dialogs and editable UI. Provide visible controls and a documented escape route so custom bindings do not create a keyboard trap.
- ? opens accurate shortcut help, including native Open shortcuts. Optional unimplemented features are not advertised.
- Status bar shows filename, physical page/total, zoom, and pending command input.
- Open, tabs, outline, and error/password dialogs have accessible labels and visible focus states.
- Small windows, resizing, and high-DPI displays do not hide critical controls or obstruct reading.
- Complete open -> switch documents -> Vim navigation -> outline jump -> close using only the keyboard.

**Verification:** Integrated workflow tests where supported, manual keyboard-only
and accessibility smoke checks, and resize/high-DPI checks.

## CORE-10: Security And Performance Hardening

**Depends on:** CORE-09.

**Scope:** Review the actual native/frontend boundary and measure the complete
reader using the fixture corpus. Fix core correctness and resource issues rather
than adding features or speculative abstractions.

**Acceptance criteria:**

- Audit capability scopes, custom commands, packaged CSP, navigation/window handling, PDF scripting, and attachment behavior.
- If external links are supported, only validated HTTP(S) URLs open externally after a user action; file, script, and other schemes stay blocked.
- Test forged reads, malicious outline titles/links, and stale-session callbacks.
- Record cold open/first-page time, rapid navigation responsiveness, peak process-tree memory, and repeated open/close behavior with hardware and fixture details.
- Rendered-page resources remain bounded during long-document navigation; repeated open/close does not accumulate live document sessions or render tasks.
- Establish explicit performance budgets on representative hardware before declaring performance acceptance. Do not invent benchmark results or promise a universal maximum PDF size.
- Add range-based file transport only if measurements justify it; otherwise document whole-file read limitations and supported test sizes.
- No PDF content or password is sent over the network or included in logs.

**Verification:** Full test suite, security review findings and fixes, packaged
performance runs, and resource cleanup evidence. Store results in a verification note.

## CORE-11: Installers And Platform Acceptance

**Depends on:** CORE-10.

**Scope:** Build and validate distributable artifacts for the support matrix.
Proposed formats: Windows NSIS installer, macOS DMG, and a Debian-family Linux
package for the initially tested distribution. Confirm architectures before
promising Apple Silicon/Intel or Windows ARM coverage.

**Deliverables:** Per-OS build configuration/CI when a repository remote is
available, installation instructions, dependency/license notices, and a platform
acceptance checklist. Build setup can begin earlier; this item closes release gates.

**Acceptance criteria:**

- Typecheck, tests, frontend build, Rust checks, and relevant native builds pass on their respective runners.
- Packaged offline tests cover multi-open, passwords, Vim navigation, outline jumps, selection, error recovery, and closing documents on every declared platform.
- Install/launch/uninstall behavior is tested on clean target systems without developer toolchains.
- Record OS, architecture, webview, artifact, and test result for each platform. Mark unavailable tests blocked, not passed.
- Include required third-party licenses/notices. Do not assume the selected shell's license covers all bundled assets.
- Document unsigned development artifacts separately from signed public releases. Signing/notarization needing user accounts, payment, or secrets remains a user-controlled release blocker.
- Do not publish artifacts or configure automatic updates without separate authorization.

**Verification:** Per-platform build logs and completed acceptance matrix. Core
release is not declared complete solely because a development browser build works.

## NEXT-01: Ordinary Text Search

**Depends on:** CORE-09. **Requires separate assignment; not a core blocker.**

Implement / to enter search and n/N for next/previous results, with highlighting
and visible match state. Reuse PDF.js search components if compatible with the
chosen viewer integration. No RAG, OCR, or background indexing service.

**Acceptance criteria:** Search is document-scoped and cancellable, does not
intercept typing, handles no matches and image-only scans honestly, and cannot
apply late results to another tab. Test matches across pages, repeated navigation,
closing during search, and interaction with existing focus handling. Avoid eager
whole-document text extraction during ordinary file opening.

## NEXT-02: Local Reading-State Persistence

Owner: OpenCode / gpt-6-astra, 2026-09-07 (user-directed subset)
Status: done (Windows verified) — page/zoom per document + status-bar
visibility + `:clear-history`. Deferred: window geometry, recent-files
reopen flow (needs explicit authorization discussion).
Changed files: src/prefs.ts, src/document-session.ts (zoomValue/setZoomValue,
scrollToPage location refresh), src/main.ts, tests/prefs.test.mjs,
tests/windows-persistence-smoke.mjs, tests/windows-pdf-smoke.mjs,
package.json (`test:persistence:windows`), docs/verification/reading-state.md.
Decisions / interface changes: content SHA-256 keys (never paths, no
authorization implied); versioned localStorage blob, corrupt-safe, 512-doc
cap; `:clear-history` stops saving for the running instance; fit presets
restore as presets.
Verification: WSL 81/81; Windows three-launch persistence smoke (restore,
status-bar toggle, clear) plus updated pdf/theme smokes pass on WebView2
152.0.4191.66. Found+fixed a CORE-05 stale-location bug (zoom after a page
jump snapped back). See docs/verification/reading-state.md.
Remaining blockers / unverified platforms: macOS/WebKitGTK unverified;
geometry and recent-files reopen deferred.

**Depends on:** CORE-09. **Requires separate assignment; not a core blocker.**

Persist last page/zoom, recent files, and window geometry in a small local store.
Do not persist passwords or build a document-content database.

**Acceptance criteria:** State restores across launches; missing/moved/changed
files and corrupt settings are recoverable; users can clear history. A stored
path is not automatically an authorization grant: use an explicit, checked
reopening flow or re-selection rather than broadening filesystem permissions.
Test page-count changes, invalid saved zoom, clearing history, and denied reopen.

## Definition Of Core Completion

CORE-01 through CORE-11 satisfy their acceptance criteria, with platform evidence
and no undisclosed release blockers. A user can install the app, select PDFs,
read and switch among them, navigate using the documented Vim-style keys, and
jump through embedded contents. RAG, annotation editing, ordinary text search,
and reading-history persistence are not required for this milestone.
