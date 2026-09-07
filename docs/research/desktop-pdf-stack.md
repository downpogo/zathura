# Desktop PDF Reader Stack

Researched: 2026-09-07. Scope: planning only for a small, keyboard-first,
Zathura-inspired reader on Windows 11, macOS, and Linux. The workspace was
empty when inspected; there were no existing conventions or application files.
All external evidence below was retrieved with webfetch from official project
documentation or first-party repositories. No application or benchmark was built.

## Selected Stack

**Decision: Tauri 2 + TypeScript + PDF.js**, selected by the user after reviewing
the alternatives. Use Tauri's bundler for desktop distribution. This document is
research only; implementation is not authorized.

Keep the initial scope to local PDF opening, reading, Vim-style navigation, and
embedded table-of-contents navigation. RAG and annotations are deferred.

The main validation requirement is PDF.js compatibility in WebView2 (Windows),
WKWebView (macOS), and WebKitGTK (Linux). Smaller bundles do not establish lower
PDF rendering memory use or better performance. Before implementation, settle
minimum supported OS versions and how native-platform testing will be provided.

## Original Recommendation And Tradeoffs

The original research recommendation was **Electron + TypeScript + PDF.js,
packaged with Electron Forge**. It is retained here to explain the tradeoff,
not as the selected implementation stack.
Use a locally bundled PDF.js viewer/display layer with a small custom keyboard
and command interface, not a remote viewer or a new PDF engine.

**Engineering judgment:** For a small project prioritizing dependable releases,
shipping one controlled Chromium version is worth the larger distribution and
likely higher baseline resource usage. Electron bundles Chromium and Node;
Tauri uses WebView2 on Windows, WKWebView on macOS, and WebKitGTK on Linux.
That makes Tauri's browser compatibility matrix broader, not its PDF renderer
more native. [1][2][3]

**Tauri 2 + PDF.js** favors smaller bundles while requiring Rust/native toolchains
and testing multiple webviews.
Neither stack has demonstrated superior PDF throughput in this research.

## Comparison And Prerequisites

| Area | Electron + PDF.js | Tauri 2 + PDF.js |
| --- | --- | --- |
| Development | Node LTS/npm and web tooling; Electron supplies its runtime. No Rust required for this design. [1] | Rust/Cargo plus Node for the proposed JS frontend tooling. [2] |
| Windows 11 | Bundled Chromium/Node; users do not install Node. Signing needs Windows signing tooling. [1][12] | Microsoft C++ Build Tools with Desktop development with C++, MSVC Rust, and WebView2 for development. WebView2 is preinstalled on Windows 11. [2][3] |
| macOS | Plan a Mac build/signing runner and Xcode for notarization. [11][13] | Xcode Command Line Tools suffice for desktop development, plus Rust; system WKWebView supplies the frontend runtime. [2][3] |
| Linux | Plan Linux builds and clean-machine package tests; bundled Chromium does not eliminate native OS dependencies. Forge recommends per-OS CI rather than relying on cross-building. [11] | Native compiler/system packages, including WebKitGTK 4.1 development libraries; Debian prerequisites also list SSL, appindicator, librsvg, and libxdo. Runtime WebKit availability/version varies by distribution. [2][3] |
| Runtime control | Application updates deliver browser/runtime fixes; keeping Electron current is the app maintainer's responsibility. [8] | System/runtime updates deliver webview fixes, but the app still maintains Tauri, Rust/npm dependencies, and PDF.js. Unsupported macOS versions stop receiving WebKit updates. [3][9] |
| Footprint | Bundles a browser and Node. Expect larger artifacts and baseline overhead; this is judgment, not a measured RAM figure. [1] | Does not normally bundle the webview. Expect smaller app artifacts, not zero webview memory or automatically faster PDFs. [9] |

Do not equate a shell's minimum OS version with support for the complete reader.
The current PDF.js FAQ lists Chrome/Firefox for its modern build; its legacy
build lists Safari 18+ as "Mostly" supported with no automated testing.
WebKitGTK is not separately certified there. **Judgment:** Tauri must prove the
chosen PDF.js build on actual WKWebView/WebKitGTK versions, not just in a browser
on the developer's machine. Set explicit supported macOS versions and Linux
distributions before release; do not promise every Linux system. [3][7]

## PDF Capabilities

**Verified, shared by both choices:** PDF.js provides a parsing core, a versioned
display API for rendering, and a viewer UI used by Firefox. `getOutline()` exposes
an existing outline tree; `getDestination()` and `getPageIndex()` support resolving
navigation targets. `onPassword` requests a missing or replacement password.
These APIs support outline navigation and password prompts, but do not establish
compatibility with every encryption scheme or malformed PDF. [4][5][6]

**Proposed scope:** local reading, zoom/rotation, text selection/search, outline,
password retry/cancel, and keyboard commands. Prefer reusing viewer components
over rebuilding selection, search, and rendering scheduling around bare canvases.
An absent embedded outline should produce an empty state, not an invented table
of contents. Treat scanned-document OCR, advanced forms, signature validation,
and editing as separate requirements, not implied features of a reader.

Bundle PDF.js and its worker at exactly matching versions, with the release's
required supporting assets, for offline operation. Its generic `file://` setup
does not enable the worker; verify the packaged application origin, CSP, worker,
fonts, and supporting assets, not only the development server. The linked API
reference is a moving draft, so check APIs against the pinned release. [4][7]

## Local Files And Security

**Electron verified mechanisms:** native open dialogs return selected paths.
Electron recommends context isolation, renderer sandboxing, restrictive CSP,
IPC sender validation, limited navigation/windows, and custom protocols instead
of broad `file://` access. [8][10]

**Proposed Electron boundary:** the main process authorizes user-selected files
and supplies bytes to PDF.js in the sandboxed renderer/worker. Expose narrow
open/read/close operations, not Node, raw IPC, arbitrary filesystem reads, or a
shell. Use an opaque document handle tied to an authorized open file; constrain
any custom protocol to packaged assets and authorized documents. Do not parse
untrusted PDFs in the privileged main process.

**Tauri verified mechanisms:** filesystem plugin commands require permissions
and appropriate path scopes. Rust core/plugin code is not constrained by those
frontend permissions. **Proposed boundary:** authorize only selected documents,
with read-only scopes or narrowly checked Rust commands; do not grant recursive
home-directory access. A custom Rust command must enforce its own file policy,
not assume the filesystem plugin scope protects it. [9][17]

**For either stack, proposed policy:** PDFs, metadata, outline titles, and links
are untrusted data. Render labels as text; disable unnecessary PDF scripting and
attachment launching; allow external HTTP(S) links only after URL validation and
user action. Keep documents/passwords out of logs and network requests. A PDF.js
worker improves responsiveness; do not mistake it for a separate OS security
boundary. Review the actual renderer sandbox and native bridge. [5][6][8][9]

## Packaging And Costs

- **Electron:** Forge separates package, make, and publish, supports installer
  makers, and integrates macOS signing/notarization. It recommends native OS CI
  runners because cross-building has caveats. **Proposal:** Windows installer,
  signed/notarized macOS DMG, and one initially supported Linux package family;
  expand formats only with demand. [11]
- **Tauri:** built-in bundling includes NSIS EXE/WiX MSI, app/DMG, DEB, RPM, and
  AppImage. Its MSI build currently needs the optional VBScript feature, which
  its prerequisites warn is being deprecated. **Proposal:** prefer NSIS for a
  simple Windows release if Tauri is selected. [2][18]
- **macOS, either stack:** budget Apple Developer Program membership at **USD
  99/year**, with regional pricing and possible institutional waivers, plus Mac
  hardware or CI access. Direct distribution should be Developer ID signed and
  notarized for normal Gatekeeper acceptance; unsigned/ad-hoc local builds are
  not an equivalent public-release experience. [13][14]
- **Windows, either stack:** budget Authenticode signing separately. Certificate
  prices vary by supplier; modern certificate key-storage requirements can add
  hardware/cloud setup. Do not budget a universal fixed fee. Azure signing is an
  option to check for current eligibility and pricing, not an assumed entitlement.
  Signing is not a blanket guarantee of no SmartScreen warnings: Microsoft also
  evaluates file and certificate reputation. [12][15]
- **Linux:** no mandatory platform signing purchase for direct distribution.
  GPG-based artifact signing is available; AppImage signatures are not automatically
  verified on launch. Package/repository trust remains a distribution concern. [16]

**Judgment:** packaging, identity verification, signing secrets, release testing,
and dependency updates are recurring work in both stacks. Tauri does not remove
Apple/Windows distribution costs. Budget CI and artifact hosting separately;
prices were not estimated here.

## Large PDFs

**Verified:** PDF.js recommends rendering only visible pages. Its example allocates
about 3.45 MB per letter-size canvas at 96 DPI, or 13.8 MB at device pixel ratio 2,
before decoded images, fonts, document data, and other overhead. It supports partial
loading with suitable HTTP Range responses; base64 conversion consumes additional
memory. `getDestinations()` can be slow for large documents, and document cleanup
must not run during active rendering. [5][7]

**Engineering guidance:** use the worker, a bounded visible/nearby page cache,
cancel stale work after zoom/navigation, and release document resources on close.
Avoid eagerly rendering every page or extracting all text at open. Full-file
binary reads are a simple starting point but can create costly cross-process
copies. For genuinely large files, plan a measured byte-range transport rather
than sending base64/JSON arrays; a local custom protocol does not automatically
guarantee PDF.js range loading. Smaller Tauri installers cannot solve canvas or
decoded-image memory pressure.

**Unverified until tested:** startup time, total process-tree RAM, battery usage,
scroll latency, maximum usable file size, and rendering fidelity. Before committing
to release support, test packaged builds on all three OS families with a long
textbook, a large scan, complex vector/transparency pages, CJK/embedded fonts,
nested outlines, password success/failure/cancel, and a damaged PDF. Measure cold
open, first-page render, rapid navigation, peak RAM, and cleanup after repeated
open/close. These are future validation gates, not work performed in this research.

## Licensing And Native Option

**Verified:** Electron is MIT; Tauri's repository describes MIT or MIT/Apache-2.0
where applicable; PDF.js is Apache-2.0. These permit use without a framework
royalty, subject to their terms. Preserve required license/copyright notices,
PDF.js modification notices, and applicable NOTICE content. Audit the actual
shipped dependencies/assets separately; the shell's license does not cover every
bundled component or grant branding rights. No Zathura code is being reused or
licensed by this planning decision. [18][19][20]

**Optional native candidate: Qt 6 Widgets + Qt PDF.** Qt provides `QPdfView`, a
render queue, search, navigation, and bookmark models, so this is a credible
alternative to building a native PDF UI from scratch. Qt PDF lists commercial,
LGPLv3, or GPLv2 licensing options. **Judgment:** revisit if native UI/resource
goals dominate or the maintainer already knows Qt/C++; otherwise do not introduce
another toolchain and licensing-compliance decision for v1. Its exact platform,
password, packaging, and performance suitability needs a separate evaluation;
no native performance advantage was established here. [21]

## Sources

All accessed 2026-09-07; live docs and prices may change.

1. Electron prerequisites: https://www.electronjs.org/docs/latest/tutorial/tutorial-prerequisites
2. Tauri prerequisites: https://v2.tauri.app/start/prerequisites/
3. Tauri webview versions: https://v2.tauri.app/reference/webview-versions/
4. PDF.js layers and distribution: https://mozilla.github.io/pdf.js/getting_started/
5. PDF.js document API: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html
6. PDF.js password/loading API: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentLoadingTask.html
7. PDF.js compatibility, memory, and loading FAQ: https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions
8. Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
9. Tauri trust boundaries and runtime updates: https://v2.tauri.app/security/
10. Electron native dialogs: https://www.electronjs.org/docs/latest/api/dialog
11. Forge packaging and per-OS CI: https://www.electronforge.io/core-concepts/build-lifecycle
12. Forge Windows signing: https://www.electronforge.io/guides/code-signing/code-signing-windows
13. Forge macOS signing/notarization: https://www.electronforge.io/guides/code-signing/code-signing-macos
14. Apple membership price: https://developer.apple.com/programs/enroll/
15. Microsoft SmartScreen reputation: https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/
16. Linux signing: https://v2.tauri.app/distribute/sign/linux/
17. Tauri filesystem permissions/scopes: https://v2.tauri.app/plugin/file-system/
18. Tauri bundler, platforms, and licensing: https://raw.githubusercontent.com/tauri-apps/tauri/dev/README.md
19. Electron license: https://raw.githubusercontent.com/electron/electron/main/LICENSE
20. PDF.js license: https://raw.githubusercontent.com/mozilla/pdf.js/master/LICENSE
21. Qt PDF capabilities and licensing: https://doc.qt.io/qt-6/qtpdf-index.html
