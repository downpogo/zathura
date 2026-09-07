# CORE-07 Verification — Vim Keyboard Navigation

Owner: OpenCode / gpt-6-astra, 2026-09-07.
Status: done on Windows (WebView2). macOS/WebKitGTK unverified.

## Implementation

- `src/keyboard.ts`: dependency-free parser classifying keydowns into reader
  commands; it never calls `preventDefault`/`stopPropagation` — the single
  document-level dispatcher in `src/main.ts` suppresses defaults only for
  `'handled'` events. `ignored` events keep native picker, OS and Ctrl+O
  behavior.
- Bindings: h/j/k/l (±40px), Ctrl+D/U (half viewport), Ctrl+F/B (full
  viewport), gg/G, `[count]G` and `[count]gg` (one-based physical page, count
  capped at 9 digits), +/−/= (zoom in/out/reset), a/s (fit page/width),
  gt/gT (next/previous document, user-directed addition for the minimal UI),
  Escape (clear pending). Pending digits and `g` sequences surface in the
  status bar as `Keys: <sequence>` and reset on focus loss, document switch,
  and Escape.
- Focus rules: editable targets (`input/textarea/select/contenteditable`),
  IME composition (`isComposing`/keyCode 229), and the password dialog are
  never intercepted. The reader keyboard is inactive without an open document.
- Command mode (`:` prompt, user-directed): `q` + Enter closes the active
  document (`:q`); unknown commands produce nonfatal `Unknown command: …`
  feedback; Escape or blur dismisses the prompt. This replaces the previous
  Close/zoom buttons per the user's minimal-UI direction — Open PDFs is the
  only remaining button.

## Verification

WSL2: `pnpm test` 68/68 — 25 keyboard parser tests cover every binding's
payload, modifier conflicts (Ctrl+h, Meta+l, Shift+j, Ctrl+T), IME, editable
targets, unbound keys (incl. Ctrl+O passthrough), digit accumulation and the
9-digit cap, cancellation rules, gt/gT chord gating, Escape/reset semantics,
repeat behavior, and pending-state reporting.
Windows 11 build 26200 x64, WebView2 152.0.4191.66: full suite green, release
build, and `pnpm test:pdf:windows` exercising real key events in the packaged
app: gg/3G/G paging with status and scroll assertions, 9999G producing visible
`out of range` feedback without navigation, pending display (`Keys: 2`,
`Keys: 2g`), Escape clearing pending, j/Ctrl+D scrolling, +/=/a/s zoom and fit
with exact status labels, gt/gT tab switching, `:q` closing (single tab, close
semantics, and close-all loops), and unknown-command feedback. Ctrl+O still
opens the native picker.

## Limits

Only the documented bindings exist; no configurability (per plan). `?` help,
dialog focus traversal, and final integrated focus rules are CORE-09. Key
repeat semantics follow plain keydown classification; OS-level key repeat
rates are unchanged. macOS/WebKitGTK shortcut behavior unverified.
