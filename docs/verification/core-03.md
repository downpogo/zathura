# CORE-03 Native File Boundary

Owner: OpenCode / CORE-03 native boundary, 2026-09-07.
Status: **done on Windows**; other native platforms remain unverified.
Dependency gate: CORE-01 is recorded done with Windows verification.

## Final Native Gate

Ran `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
tests/windows-files-smoke.ps1 -Root C:\zathura -InteractiveConfirmed` against the
Windows release executable. Passed Open button, owned native multi-file picker,
both fixture binary reads (756 and 3,619 bytes), Ctrl+O, cancellation preserving
both results, and clean close. The script was executed from the WSL UNC source
path with the explicit Windows build root.

The picker retained its last-used folder. Replaced unreliable Alt+N/SendKeys
filename entry with native WM_SETTEXT/WM_GETTEXT on the dialog's filename Edit
control. The script verifies exact quoted absolute fixture paths before clicking
Open. WM_GETTEXT is necessary for cross-process edit text (GetWindowText is not
sufficient). Native buttons are clicked directly; only the Ctrl+O shortcut check
uses guarded foreground keystrokes. No arbitrary user PDF/content is logged.
The remembered folder is no longer a test prerequisite. This closes the Windows
CORE-03 gate; the earlier pending notes below are historical.

## Parent Verification Update

Integrated @tauri-apps/api 2.11.1, Open button, Ctrl+O/Cmd+O dispatch, serial binary
reads, per-file feedback, and release after read. This is a temporary transport
proof, not document sessions or rendering. Cancellation preserves prior results.
Updated Cargo.lock on Windows and copied rustfmt output and lock back to WSL.

Windows build 26200 x64, WebView2 152.0.4191.66, Rust/Cargo 1.93.0, Node 24.19.0,
pnpm 10.32.1. Windows copy now located at C:\zathura:

- `cargo fmt --manifest-path src-tauri/Cargo.toml`: applied.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed, refreshed lock.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: 10/10 passed, including Windows sharing denial.
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings`: passed.
- `pnpm install --frozen-lockfile`: passed.
- `pnpm test` with isolated fixture Python: 9/9 passed, also passed in WSL.
- `pnpm tauri build --no-bundle -- --locked`: passed, including TypeScript/frontend production build.
- UI Automation invoked the real Open button and observed an owned native Open PDFs dialog.
- A manually selected PDF completed the binary ArrayBuffer boundary and displayed a successful byte count. The user independently confirmed picker operation.

`tests/windows-files-smoke.ps1` attempted multi-file selection, Ctrl+O and cancel,
but keyboard automation overlapped manual picker operation and did not load the
expected synthetic fixtures. **No full workflow pass is claimed.** The script now
requires `-InteractiveConfirmed`, warns that it takes keyboard focus, checks both
fixture files exist, and refuses keystrokes when the test app is not foreground.
It must only be rerun after informing the user and on an idle desktop. It does
not print arbitrary document/accessibility contents on failure.

The requested files exist at C:\zathura\fixtures\pdfs\basic.pdf (756 bytes)
and navigation.pdf (3,619 bytes); they are generated fixtures, not user documents.
Native multi-file, shortcut and cancel smoke remain pending. The initial agent
handoff below is historical; missing dependency and native build blockers are now
resolved. CORE-04 has not started because CORE-03 is not fully verified.

## Parent Integration

- Add a pinned Tauri 2 `@tauri-apps/api` runtime dependency using pnpm. This agent
  deliberately did not edit package.json or pnpm-lock.yaml.
- Import `selectPdfFiles`, `readPdfFile`, `releasePdfFile`, `NativeFileError`, and
  the associated types from `src/native-files.ts`. Wire the Open button and
  Ctrl+O/Cmd+O to the same selection action. No keyboard/UI entry point was edited.
- Refresh Cargo.lock on Windows after syncing the owned Rust files. New native
  dependencies: `rfd =0.15.4`, `same-file =1.0.6`, `serde 1` with derive, and
  `uuid 1` with v4. Existing exact Tauri/build versions are unchanged. Cargo.lock
  was not edited here; its current locked graph does not yet establish these additions.
- No Tauri config, capability, CSP, filesystem plugin, dialog plugin, or shell
  permission changes are required. Keep capabilities empty. The custom app
  commands enforce authorization themselves; `rfd` is invoked only from Rust.

Exact frontend boundary:

```ts
selectPdfFiles(): Promise<NativeFileSelection>
readPdfFile(handle: NativeFileHandle): Promise<Uint8Array>
releasePdfFile(handle: NativeFileHandle): Promise<void>

interface NativeFileSelection {
  cancelled: boolean;
  files: {
    handle: NativeFileHandle; // branded string, opaque runtime UUID
    name: string;            // untrusted basename, never a full path
    size: number;            // bytes at initial selection
    alreadyOpen: boolean;
  }[];
  errors: { selectionIndex: number; error: NativeFileErrorCode }[];
}
```

Native commands: `select_pdf_files` (no args), `read_pdf_file` (`{ handle }`),
`release_pdf_file` (`{ handle }`). Read returns `tauri::ipc::Response` with a
`Vec<u8>` raw body, not a serialized vector, base64, or JSON array. The frontend
requires an `ArrayBuffer` and wraps it in a zero-copy `Uint8Array` view.

Command failures reject with the safe snake-case code. The frontend converts
these to `NativeFileError` with `.code` and a fixed displayable message. Codes:
`unauthorized`, `busy`, `invalid_handle`, `missing`, `unreadable`, `empty`,
`not_pdf`, `too_large`, `limit_reached`, `internal`. Unknown bridge failures become
`internal`; raw errors are not displayed or logged. Selection failures remain
per-file codes in `errors`; their index is zero-based in native picker order.

## Session Contract

1. Await selection; cancellation resolves with `cancelled: true`, empty files and
   errors, and no registry changes. Keep existing documents and selection state.
2. Process successful selections independently even when some selections fail.
   Names are untrusted: use textContent, not innerHTML. No full paths reach JS.
3. Map sessions by handle. If `alreadyOpen` is true, focus the existing session;
   do not create a second owner or release its handle. Identity is determined
   from the open file object via same-file, including hard links. A duplicate
   within one selection returns the same handle with `alreadyOpen: true`.
4. Serialize `readPdfFile` calls (do not use Promise.all). Concurrent native reads
   reject `busy` immediately; there is no unbounded read task queue. Concurrent
   selections similarly reject `busy`; read and selection may overlap.
5. Release each newly owned handle exactly once on close, failed loading, or
   abandoned selection. If selection resolves after its UI action became stale,
   release its newly created handles, not duplicates belonging to existing sessions.
6. Closing during read may release immediately without waiting for file I/O. A
   worker holds a temporary Arc to the already open file and will reject a release
   observed at its final registry check. Release after that check can still race
   with delivery: the UI MUST discard late bytes for closed/stale sessions. This
   boundary does not implement PDF.js cancellation or session-generation checks.

Release removes authorization first. The descriptor and its identity descriptor
close when the last in-flight Arc drops; bytes are not cached in the registry.
Repeated release, forged handles, and path strings reject `invalid_handle`.
Handles are random UUID v4 capabilities (122 random bits), never paths, counters,
or persistent reopening grants. They live until release or process shutdown;
reload does not automatically revoke them. A frontend reload that loses its
session map can leave bounded inaccessible entries until process restart. Do not
use reload as document disposal. Native state is not persisted.

## Authorization And Validation

Every command checks the injected webview and its containing window labels are
both `main`, plus the current trusted local origin. Packaged origins are
`tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost` with
no nondefault port/credentials. Debug builds also accept exactly the bootstrap
development origin `http://127.0.0.1:1420`. No caller-supplied label/path/origin is
accepted as authority. Selection and read recheck origin after asynchronous work;
a failed final selection check releases only newly allocated handles. The existing
CSP prohibits frames, remote scripts, and PDF embedding; retain these restrictions.

Paths exist only inside Rust, as picker output. Only regular files are accepted;
the opened object is validated again. Opening is read-only and the registry
retains that object: replacing/renaming the path cannot redirect later reads to a
different object. Same-object external writes are possible; this is not a snapshot
or file lock. Read revalidates metadata and header, detects length changes during
the read, and returns recoverable failures. A same-length concurrent edit cannot
be reliably detected here; PDF.js must handle parse failures.

Empty, missing, unreadable, oversized and non-PDF input is recoverable. The native
check requires `%PDF-` at byte zero; this intentionally rejects PDFs with leading
junk even if a tolerant parser might accept them. It is a signature check only,
not full PDF validation: malformed, unsupported, and encrypted PDFs with a valid
header still pass to the future parser. The extension filter is convenience only.
No application file paths, PDF contents, or raw OS I/O errors are logged.

## Resource Costs

- Hard per-file limit: **128 MiB (134,217,728 bytes)** at selection and read. This
  is a transport safety policy, not a measured guarantee of PDF rendering support.
- At most 32 selections are processed per dialog. If more are returned, one
  `limit_reached` error at index 32 represents all remaining unprocessed entries.
  The OS dialog may itself allocate a larger path list before this cap is applied.
- At most 64 unique live handles; duplicates remain focusable at capacity.
  Each live entry holds a read-only file and a duplicate identity descriptor.
- One active native read allocates exactly the observed file length using fallible
  reservation. Reads do not grow/double the vector when a file grows concurrently.
  Shrink/growth during read is a recoverable error. A released in-flight read can
  still retain its allocation/descriptor until blocking OS I/O returns.
- Whole-file IPC entails the native vector, bridge/OS transport copies, a webview
  ArrayBuffer, and subsequent PDF.js/worker storage. Do not budget just one file
  size for process-tree memory. Transferring the Uint8Array's buffer to a worker
  can avoid an additional JS copy but does not erase native/transport costs.
- The native single-read gate covers disk reading, not consumption of already
  returned IPC responses or JS-held buffers. A caller retaining responses or
  repeatedly issuing sequential reads can accumulate memory; there is no global
  bridge/renderer memory ceiling. UI integration must await consumption, avoid
  unnecessary rereads, release sessions, and discard stale results. Range transport
  and measured process-tree budgets remain CORE-10 work.
- No interruptible OS I/O, PDF parsing/rendering, or auto-release TTL is introduced.
  Network-mounted selected files can delay I/O. The preliminary regular-file check
  is not a platform-specific atomic defense against a local process replacing a
  selected path with a special device between metadata and open; frontend callers
  cannot supply paths, but hostile local filesystem mutation is a residual risk.

## Verification Performed

WSL2, Node v24.14.0; no Rust execution or Windows checkout modification:

| Command | Result |
| --- | --- |
| `pnpm exec node --test tests/native-files.test.mjs` | Passed, 5/5 CORE-03 boundary tests |
| `pnpm test` (initial) | Passed, 8 tests: 3 bootstrap and 5 native-boundary TS tests |
| `pnpm test` (after concurrent CORE-02 additions) | 8 passed, 1 fixture test failed: Python `fontTools` missing; unrelated fixture environment setup pending |
| `pnpm typecheck` | Blocked: TS2307, `@tauri-apps/api/core` missing; parent must add dependency |

The TS tests use Node module hooks to stub only the Tauri `invoke` import. They
exercise the actual TypeScript functions but do not prove a webview's binary IPC
behavior. No production build is claimed while the SDK import is unresolved.

Ten Rust tests (one Windows-only) are implemented but **not run**: caller label/window/origin denial,
partial multiselect, cancellation, duplicate/hard-link identity, opened-object
binding after path replacement, forged/path handles, release and read/release
ordering, binary response body, file revalidation, size/selection/live-handle limits, directory rejection,
permission-denied error mapping, real Windows sharing denial, and operation gates. Permission-denied mapping is
deterministic; a real Windows unreadable ACL fixture is still a smoke-test item.

## Windows Handoff

Parent owns execution in `C:\zathura`; do not run native Cargo in WSL or edit
the concurrently used Windows copy without coordination. Sync the owned sources
and manifest, integrate frontend dependency/UI, then run with the required PATH:

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:USERPROFILE\.cargo\bin;$env:APPDATA\npm;$env:PATH"
Set-Location C:\zathura
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
pnpm typecheck
pnpm test
pnpm build
pnpm tauri build --no-bundle -- --locked
```

The initial unlocked check resolves newly declared dependencies; return the updated
Cargo.lock and any rustfmt/native fixes to the shared WSL source. Then repeat check
with `--locked`. Toolchain expectation: Rust 1.93.0, Tauri 2.11.5, tauri-build 2.6.3.

Native smoke must cover Open and Ctrl+O, multi-PDF selection, cancel preserving
current documents, duplicate focus, mixed valid/empty/non-PDF/oversized selection,
missing/permission-denied files where the OS picker permits, binary ArrayBuffer
delivery, forged/path reads, close during read, repeated open/release and final
window close. Confirm the native picker is parented/modally behaves correctly and
does not freeze the reader. Record Windows build, WebView2 version, exact commands,
test counts and results before marking CORE-03 done. Cmd+O/macOS and native Linux
remain explicitly unverified; no platform support is inferred from WSL tests.
