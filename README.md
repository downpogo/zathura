# Zathura

A local, keyboard-first desktop PDF reader inspired by Zathura. It uses a
minimal interface so that opening, reading, navigating, and switching documents
can be done almost entirely from the keyboard.

The application is currently developed and verified on Windows 11 x64. Linux
and macOS can be built through Tauri, but their native behavior has not yet been
verified by this project.

## Features

- Open up to 32 PDFs at once with the native file picker.
- Render PDFs completely offline with a bundled PDF.js worker and assets.
- Read documents in a continuous vertical view with mouse, trackpad, or
  Vim-style keyboard navigation.
- Select and copy text from PDFs that contain a text layer.
- Zoom in and out, reset to 100%, fit the current page, or fit page width.
- Keep multiple documents open without a permanent tab bar; use the document
  switcher or keyboard shortcuts to move between them.
- Browse nested PDF outlines and follow internal document destinations.
- Open password-protected PDFs with retry and cancellation support.
- Recover cleanly from invalid, corrupt, or unsupported files.
- Follow the operating-system theme or persist a manual light/dark override.
- Remember status-bar visibility and each document's last page and zoom level.
  Document history is keyed by file content rather than its path.
- Run without a network connection, accounts, telemetry, or remote assets.

Current limitations:

- There is no text search, OCR, printing, annotation editing, Save As, or recent
  files list.
- External links in PDFs are disabled; internal PDF links are supported.
- Image-only PDFs can be viewed but are not converted to searchable text.
- Files are loaded into memory and are limited to 128 MiB each.
- Installers and signed release packages are not configured yet. The build
  instructions below produce a standalone executable for the current OS.

## Keybindings

On macOS, use `Cmd` instead of `Ctrl` for the global shortcuts marked
`Ctrl/Cmd`. Reader scrolling shortcuts continue to use `Ctrl`.

### Application

| Keys | Action |
| --- | --- |
| `Ctrl/Cmd+O` | Open one or more PDFs |
| `Ctrl/Cmd+L` | List open documents |
| `Ctrl/Cmd+R` | Toggle and remember light/dark theme |
| `Ctrl/Cmd+N` | Toggle and remember the status bar |
| `Tab` | Toggle the PDF outline sidebar |
| `:` | Open command mode |
| `Escape` | Clear a pending key sequence or close the active dialog |

### Reading

| Keys | Action |
| --- | --- |
| `j` / `k` | Scroll down / up |
| `h` / `l` | Scroll left / right |
| `Ctrl+D` / `Ctrl+U` | Scroll half a viewport down / up |
| `Ctrl+F` / `Ctrl+B` | Scroll one viewport down / up |
| `gg` | Go to the first page |
| `G` | Go to the last page |
| `[number]G` | Go to a physical page, for example `42G` |
| `+` / `-` | Zoom in / out |
| `=` | Reset zoom to 100% |
| `a` | Fit the page |
| `s` | Fit page width |
| `gt` / `gT` | Switch to the next / previous document |

### Document Switcher

| Keys | Action |
| --- | --- |
| `j` / `Down` | Select the next document |
| `k` / `Up` | Select the previous document |
| `Enter` | Open the selected document |
| `Escape` | Close the switcher |

### Commands

Press `:`, type a command, and press `Enter`.

| Command | Action |
| --- | --- |
| `:q` | Close the current document |
| `:clear-history` | Clear saved reading state and return to the OS theme |
| `:waifu` | Toggle the dancing corner overlay |

## Tech Stack

| Layer | Technology |
| --- | --- |
| Desktop shell | [Tauri 2](https://v2.tauri.app/) |
| Native backend | Rust 1.93 |
| Frontend | TypeScript 5.9, HTML, and CSS |
| Build tooling | Vite 7 and pnpm 10 |
| PDF rendering | PDF.js 6.3 |
| Native file picker | `rfd` |
| Windows webview | Microsoft Edge WebView2 |
| Linux webview | WebKitGTK 4.1 |
| macOS webview | WKWebView |

The frontend receives opaque document handles instead of filesystem paths. The
native backend validates and reads selected files, while PDF parsing and
rendering happen locally in the bundled PDF.js viewer. Tauri capabilities,
remote navigation, and external PDF links are disabled.

## Build a Binary

Build on the operating system you want to target. Tauri uses native webviews and
native compiler toolchains, so a Windows build should run on Windows, a macOS
build on macOS, and a Linux build on Linux. Cross-compilation is not part of the
project's supported workflow.

All platforms require:

- [Node.js 24](https://nodejs.org/)
- [pnpm 10](https://pnpm.io/installation)
- [Rust through rustup](https://rustup.rs/); `rust-toolchain.toml` automatically
  selects Rust 1.93
- Git

After installing the OS-specific prerequisites below, run these commands from
the repository root:

```sh
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
```

The command runs the TypeScript typecheck and Vite production build before
compiling the native release executable. Installer bundling is currently
disabled, so `--no-bundle` intentionally creates only the application binary.

### Windows

Supported and verified target: Windows 11 x64.

Install:

- Visual Studio Build Tools with **Desktop development with C++**, the MSVC x64
  build tools, and a Windows SDK
- Microsoft Edge WebView2 Runtime, which is normally included with Windows 11
- Rust's `x86_64-pc-windows-msvc` toolchain

Build from native PowerShell or a Visual Studio Developer PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
```

Output:

```text
src-tauri\target\release\local-pdf-reader.exe
```

Do not build from a checkout stored inside WSL and do not share `node_modules`
between Windows and WSL. Keep a separate checkout on the Windows filesystem.
The resulting executable is unsigned, so Windows SmartScreen may warn when it
is first opened.

To run the native Windows shell smoke test after building:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-shell-smoke.ps1
```

### Linux

Linux builds require Tauri's WebKitGTK and native development libraries. On
Debian, Ubuntu, or WSL, install them with:

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev
```

Then build:

```sh
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
```

Output:

```text
src-tauri/target/release/local-pdf-reader
```

The executable still depends on compatible system runtime libraries, including
WebKitGTK. Native Linux behavior and distribution compatibility have not yet
been verified by this project. See the
[official Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux)
for packages used by other distributions.

### macOS

Install Xcode Command Line Tools:

```sh
xcode-select --install
```

Then build on the Mac architecture you want to target:

```sh
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
```

Output:

```text
src-tauri/target/release/local-pdf-reader
```

This produces an unsigned standalone Mach-O executable, not a `.app`, DMG, or
notarized release. Native macOS behavior and minimum OS compatibility have not
yet been verified by this project.

## Development

Install dependencies and run the checks:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

The complete test suite also validates deterministic PDF fixtures. Set up its
development-only Python environment and `FIXTURE_PYTHON` as described in
[`fixtures/README.md`](fixtures/README.md), then run:

```sh
pnpm test
```

Run the native development application after installing the prerequisites for
your OS:

```sh
pnpm tauri dev
```

Run the Rust checks directly:

```sh
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Additional architecture, design, acceptance criteria, and verification details
are available in [`docs/`](docs/).
