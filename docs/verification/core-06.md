# CORE-06 Verification — Multiple-Document Tabs

Owner: OpenCode / gpt-6-astra, 2026-09-07.
Status: done on Windows (WebView2). macOS/WebKitGTK unverified.

## Implementation

- `src/tabs.ts`: `TabStrip` renders one `role=tab` button per document with a
  `Close <name>` button (untrusted names as text only). The strip is hidden for
  a single document. `neighborOf` implements the close rule (next tab, else
  previous) and `cycle` exposes next/previous-document operations for the
  keyboard layer without its own listener.
- `src/main.ts`: every selected file becomes its own `DocumentSession` in its
  own `.session-view` scroll container. Inactive views keep layout via
  `visibility: hidden`, so scroll position, zoom and rendered pages persist
  while no new rendering is triggered. The first file's tab is active;
  background tabs open without stealing focus.
- Duplicate handling: sessions keep their native file handle for their
  lifetime, so the native identity dedup (same-file, hard links) returns
  `alreadyOpen` with the same handle and the existing tab is focused instead of
  reopening. One failed file never blocks the others (per-file feedback).
- Closing a tab disposes only that session (bounded teardown, worker
  termination) and releases its handle; the last close returns to the open
  screen.

## Verification

WSL2: `pnpm test` 68/68 (incl. TabStrip/session wiring via existing suites).
Windows 11 build 26200 x64, WebView2 152.0.4191.66: full suite green, release
build, and `pnpm test:pdf:windows` covering: two-PDF multi-open (2 tabs, 2
views, 2 workers; first active), per-tab aria/labels, position retention
(scroll each view, switch both ways, offsets preserved ±1px), duplicate
selection (no new worker/tab, focus jumps), close-active → neighbor selection,
strip visibility rules, per-tab worker disposal, and recovery after the final
close. Zero external requests, zero CSP violations/page errors; created ==
terminated workers.

## Subsequent UI Change (User-Directed)

The always-visible tab strip was replaced by an on-demand **Ctrl+L document
switcher** (modal listbox: j/k or arrows, Enter, click, Escape). Session
management, neighbor-close rule, gt/gT and per-session workers are unchanged;
`src/tabs.ts` was folded into headless registry helpers in `src/main.ts`.
The native smoke drives the modal (open, item order, aria-selected, Enter/
Escape, close-neighbor, no worker spawns on switching) and passes along with
the persistence and theme smokes.

## Limits

gt/gT is wired for keyboard-only switching (user-directed minimal UI);
CORE-09 still owns final focus integration. Tab strip ordering is creation
order; no drag-reorder. Memory for background documents is bounded by the
session/worker, not by OS-level process suspension (CORE-10 measures).
