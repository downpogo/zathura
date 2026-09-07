# NEXT-02 (Partial) Verification — Local Reading-State Persistence

Owner: OpenCode / gpt-6-astra, 2026-09-07.
Status: done for the user-directed subset (status-bar visibility, per-document
page/zoom, clear-history). Window geometry and a recent-files reopen flow are
explicitly deferred. macOS/WebKitGTK unverified.

## What Persists

- **Status-bar visibility** (Ctrl+N) — applied at startup, saved on toggle.
- **Per-document page + zoom** — keyed by the file's SHA-256 content hash; the
  full raw PDF.js scale value (preset name or numeric string) is stored, so
  fit modes restore as fit modes. Saves happen on state changes (400ms
  debounce), on tab close, and on window close (beforeunload flush).
- Storage: one versioned JSON blob in the webview's localStorage
  (`zathura.reading-state.v1`), capped at 512 documents with oldest-eviction.

## Privacy And Safety Policy

- Keys are content hashes — **file paths are never stored**, and a stored
  hash is not an authorization: reopening still requires the user's own
  picker selection through the native boundary.
- No passwords, no PDF contents, no document metadata. Only page numbers and
  scale values.
- Corrupt or partial JSON, wrong types, out-of-range pages, and IO failures
  recover to defaults without crashing (unit-tested). Storage write failures
  are best-effort; the reader works without persistence.
- `:clear-history` wipes the store, stops saving for the running instance
  (so the close-flush cannot resurrect history), and restores the default
  status-bar visibility. A fresh launch records again.

## Bug Found And Fixed

The native smoke caught a real CORE-05 regression class: PDF.js marks the
scroll location stale only in `panBy`, so a zoom issued right after a
programmatic page jump restored the **pre-jump position** (the test's 3G → +
sequence snapped back to page 1). `DocumentSession.scrollToPage` now refreshes
the viewer's location from the settled scroll position before returning.

## Verification

- WSL: 81/81 tests — 8 new `ReadingPrefs` unit tests (round-trip, corrupt
  JSON, invalid-entry sanitization, cap eviction, storage-failure tolerance)
  via a fake storage.
- Windows 11 build 26200 x64, WebView2 152.0.4191.66:
  `pnpm test:persistence:windows` (`tests/windows-persistence-smoke.mjs`)
  runs the real release executable **three times against one shared
  WebView2 profile**: instance A reads navigation.pdf, jumps to page 3,
  zooms, hides the status bar, closes gracefully; instance B starts with the
  status bar hidden, reopens the same file and lands on page 3 with the
  remembered zoom; `:clear-history` then wipes everything; instance C
  verifies the file reopens at page 1 with defaults restored. PDF and theme
  smokes updated for in-run persistence (history cleared at phase
  boundaries) and both pass.

## Limits

- localStorage lives in the WebView2 profile directory: clearing browser
  data or moving the profile clears reading state. No export/import.
- No window geometry, no recent-files list, no auto-reopen (deferred; a
  reopen flow would need its own explicit authorization discussion per the
  plan).
- Restoring a background tab applies its page/zoom lazily when the tab is
  shown; scroll offset within a page is not preserved across restarts.
