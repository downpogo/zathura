# CORE-08 Verification — Table Of Contents And Destinations

Owner: OpenCode / gpt-6-astra, 2026-09-07.
Status: done on Windows (WebView2). macOS/WebKitGTK unverified.

## Implementation

- `DocumentSession.outline()`: maps the PDF.js outline into plain
  `{ title, dest, children }` nodes. Titles/destinations are untrusted data:
  mapping filters non-object entries, treats missing destinations as null,
  tolerates rejection (resolves empty, never throws), and never resolves after
  disposal. External URL entries are not kept — only destinations are
  navigable. `relayout()` reapplies fit presets after layout changes.
- `src/outline.ts` `OutlineTree`: collapsible tree with proper ARIA roles
  (`tree`/`treeitem`/`group`, entries `role=none`, expander buttons labelled
  `Toggle section <title>`). Titles render as text nodes only — the fixture's
  HTML-like title displays literally. Entries without a destination and
  without children are inert; destinationless parents still expand children.
- `src/main.ts`: `Tab` toggles the sidebar from reading context (dialogs and
  editable fields keep focus traversal); the sidebar reloads per active
  session; a closed/replaced session can never repaint it. Activation routes
  through the sanitized `navigateToDest` (named or explicit destinations,
  position/zoom respected). Broken destinations give nonfatal
  'This destination is not available.' feedback without navigation. PDFs
  without an outline show exactly 'This PDF has no table of contents.'; no
  generated or inferred contents exist. Sidebar open/close calls `relayout()`
  so fit modes reflow to the new viewport.
- Layout: `main` switches to a flex row in document mode; the sidebar is a
  fixed-width tokenized panel and the reader fills the rest. (A first draft
  kept `align-items: center` from the empty-state rule, collapsing the reader
  to zero height — caught by the native smoke and fixed.)

## Verification

WSL2: 73/73 tests — five new session tests (outline mapping/filtering,
rejection and disposal safety, relayout reapply) via the module stubs.
Windows 11 build 26200 x64, WebView2 152.0.4191.66: full suite, release
build, and `pnpm test:pdf:windows` covering, offline, in the packaged app:
Tab toggle with focus staying out of editables; navigation.pdf renders all
six fixture rows in document order (literal HTML-like title); destinationless
parent expands its child without navigating; the named `chapter-three`
destination jumps to page 3 with the sidebar staying open; the broken
`does-not-exist` entry produces nonfatal feedback with the page unchanged;
basic.pdf shows the no-outline message while its canvas keeps rendering;
fit-width with the sidebar open reflows to the reduced viewport with no
horizontal overflow; close-all hides and clears the sidebar. Theme smoke and
the other flows unchanged; 22 workers created and terminated.

## Limits

Outline keyboard operation (j/k/h/l/Enter on the tree, Tab focus semantics
inside the sidebar) is CORE-09. Selection highlight of the current outline
item is not implemented. Sidebar width is fixed (no resizer). Large outlines
render fully (no virtualization) — acceptable for typical TOC sizes, revisit
under CORE-10 if measured otherwise.
