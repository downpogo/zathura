# Zathura

A local, keyboard-first desktop PDF reader using **Tauri 2, TypeScript, Vite,
and locally bundled PDF.js**, packaged with Tauri's bundler. Use **pnpm**
for JavaScript dependencies and commands.

## Current Status

**CORE-01 through CORE-07 are verified on Windows 11 x64.** The reader opens
local PDFs through the native picker (button or Ctrl+O) and reads them in a
continuous scrolling view with a bundled PDF.js 6.3.289 module worker. The UI
is minimal by design — Open PDFs is the only button; everything else is
keyboard-driven:

| Keys | Action |
| --- | --- |
| j / k / h / l | Scroll down / up / left / right |
| Ctrl+D / Ctrl+U | Half viewport down / up |
| Ctrl+F / Ctrl+B | Full viewport down / up |
| gg / G | First / last page |
| 42G | Jump to physical page 42 |
| + / - / = | Zoom in / out / reset |
| a / s | Fit page / fit width |
| Ctrl+L | List open documents; j/k or arrows + Enter to switch |
| gt / gT | Next / previous document |
| : then q, Enter | Close the current document (`:q`) |
| Tab | Toggle the outline / table-of-contents sidebar |
| Ctrl+N | Toggle the status bar for full-bleed reading |
| Ctrl+R | Toggle light / dark theme (remembers your choice) |
| Escape | Clear pending keys |

The sidebar lists the PDF's embedded table of contents: click a section (or
expand a group) to jump to it; PDFs without an embedded outline say so.
Multiple documents are managed invisibly — Ctrl+L lists the open ones on
demand.

**Zathura remembers**: your status-bar and theme preferences and each
document's last page and zoom (keyed by file content, never paths), restored
when you reopen the same file. Use `:clear-history` in the command prompt to
forget everything and follow the OS theme again. Press Ctrl+O any time to add
more PDFs.

Tabs keep one session per document (duplicate selections focus the existing
tab), positions persist while switching, and password retry/cancel plus
corrupt-file recovery are verified offline. See
[verification evidence](docs/verification/core-01.md),
[tabs](docs/verification/core-06.md) and
[keyboard](docs/verification/core-07.md). The outline sidebar (CORE-08),
`?` help and final focus rules (CORE-09) are next. There is no installer.

The shell has a token-based design system with **OS-selected light and dark
themes**, including live preference changes, system fonts, shared sizing/spacing,
control states and accessibility defaults. No manual theme override is stored.

- [Implementation plan and acceptance criteria](docs/implementation-plan.md)
- [Desktop PDF stack research and sources](docs/research/desktop-pdf-stack.md)
- [Design tokens and component guidelines](docs/design-system.md)
- [Windows theme verification](docs/verification/design-system.md)
- [PDF.js renderer module contract](docs/verification/core-04-renderer.md)

## Proposed Test Matrix

These are validation targets, not claims of supported platforms. Windows testing
is the priority; the macOS target remains pending user confirmation.

| Target | Architecture | Native Webview | Validation Status |
| --- | --- | --- | --- |
| Windows 11 build 26200, primary | x64 | WebView2 152.0.4191.66 | Bootstrap release compile and native launch/content/close pass; PDF and installer acceptance pending. |
| Ubuntu 24.04, secondary | x64 | WebKitGTK 4.1 | Native compile and launch blocked by missing Rust/Cargo; clean native Linux validation unavailable. |
| macOS, pending confirmation | Version and Apple Silicon/Intel pending | System WKWebView | No confirmed target or available validation evidence; support is not claimed. |

Record the exact OS build, architecture, toolchain versions, webview version,
commands, and results for each future native test. Confirm the user's macOS
version and hardware before selecting a macOS support target. Windows ARM and
other Linux distributions are not established targets.

### Available Environment

The development host is **WSL2 Ubuntu 24.04.4 x86_64**, with **Node.js 24.14.0**
and **pnpm 10.32.1**. Neither Rust nor Cargo is installed. Selected versions are
Rust 1.93.0, Tauri 2.11.5, tauri-build 2.6.3, Tauri CLI 2.11.4, TypeScript 5.9.3,
and Vite 7.3.1. JavaScript and Rust dependencies are locked. PDF.js is intentionally
deferred to CORE-04. The separate Windows build environment uses Node 24.19.0,
pnpm 10.32.1, and Rust 1.93.0 with the x86_64-pc-windows-msvc toolchain.

Windows PowerShell is accessible from WSL. Node, pnpm, and Rust were installed
with user authorization after the initial missing-toolchain probe. Visual Studio
2019 Build Tools and the installed Windows SDK successfully compile the shell.
The Windows registry reports WebView2 152.0.4191.66, on Windows build 26200.

WSL frontend checks do not validate Windows. A Linux Tauri process launched via
WSLg uses Linux WebKitGTK, not Windows WebView2, and is not a clean native Ubuntu
desktop validation either. A browser preview does not establish native-webview
or packaged-application compatibility.

## Development Prerequisites

### Native Windows 11 x64

- Install native Windows Node.js and pnpm; use Node.js 24.14.0 and pnpm 10.32.1
  or a newer Node 24 patch. Windows verification uses Node 24.19.0.
- Install Rust and Cargo through rustup with the `x86_64-pc-windows-msvc`
  toolchain. `rust-toolchain.toml` selects Rust 1.93.0.
- Install Microsoft Visual Studio Build Tools with **Desktop development with
  C++**, the MSVC x64 build tools, and a Windows SDK. Verify installed components
  through Visual Studio Installer or a component-aware `vswhere` query. Check
  `cl` from a Visual Studio developer shell; absence from ordinary PowerShell's
  PATH alone is not conclusive.
- Verify Microsoft Edge WebView2 Runtime is available. It is normally present
  on Windows 11, but the actual test machine and runtime version need checking.

Use a separate native Windows checkout on the Windows filesystem, for example
`C:\zathura`, and run the workflow in native PowerShell or a Visual Studio
developer PowerShell. Do not use the WSL checkout as the native Windows build
directory. Install dependencies separately in each environment; **never share
`node_modules` between Windows and WSL**. Keep Rust build outputs separate too.

### Ubuntu 24.04 x64 / WSL Development

Frontend work needs Node.js and pnpm. Native Tauri development additionally needs
Rust/Cargo, a native compiler, and Tauri's Linux system development libraries.
The documented Debian/Ubuntu prerequisite set is:

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev
```

Install Rust/Cargo through rustup separately. A native launch also needs a working
graphical session (WSLg for WSL development). These installation steps have not
been performed or validated by this README change. Missing Rust/Cargo currently
blocks native checks and Cargo lockfile generation; the remaining native
libraries and graphical environment are unverified.

### macOS

Once a version and architecture are confirmed, plan for a native Mac with Node.js,
pnpm, Rust/Cargo, and Xcode Command Line Tools. WKWebView comes from the OS.
Signing/notarization is a separate release concern. Neither a Windows nor a WSL
build validates macOS compatibility.

See the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for platform setup details.

## Development Workflow

Run these commands from the application checkout root. First set up the isolated,
development-only Python fixture tools in [fixtures/README.md](fixtures/README.md)
and set `FIXTURE_PYTHON`. The first four work in WSL and Windows; native commands
require platform-specific prerequisites above.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm tauri dev
pnpm tauri build
```

| Command | Intended Scope |
| --- | --- |
| `pnpm install --frozen-lockfile` | Install the locked JavaScript dependencies without updating the lockfile. Initial lockfile creation must happen first. |
| `pnpm typecheck` | Check the TypeScript frontend. |
| `pnpm test` | Run bootstrap, native boundary, fixture parser/regeneration, design-token/contrast, PDF asset and renderer lifecycle tests. |
| `pnpm test:theme:windows` | Launch the Windows release executable to check actual WebView2 themes, token propagation and accessibility styles. No OS theme changes or global keyboard input. |
| `pnpm test:pdf:windows` | Offline native Windows proof: real picker, PDF.js worker rendering, passwords, recovery and worker cleanup against the generated fixtures. Opens test windows; do not use the machine during the run. |
| `pnpm build` | Build frontend production assets; this does not compile the native shell or produce a validated installer. |
| `pnpm tauri dev` | Compile and launch the native development shell on the current OS, once its native prerequisites are met. |
| `pnpm tauri build` | Build the native application on the current OS. Installer bundling is disabled at bootstrap and will be configured in later gates. |

The checked-in `src-tauri/Cargo.lock` was generated and verified on Windows. Run:

```sh
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

For a release-mode Windows bootstrap smoke check, run:

```powershell
pnpm tauri build --no-bundle -- --locked
powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-shell-smoke.ps1
```

The smoke test launches only the built app, checks its accessibility content,
and closes it. Its accessibility flag and execution-policy override are local to
the test process; it does not modify system policy or shipped WebView2 settings.

Retain commit-ready pnpm and Cargo lockfiles and record exact selected dependency
and toolchain versions. Do not describe unlocked resolution as a reproducible
native check. Run native Windows checks independently of WSL checks. Later PDF.js
acceptance must exercise offline packaged assets and workers in the actual target
webviews, not just the frontend build or configuration smoke tests.

## End-User Requirements

There is no end-user release yet. For future packaged releases, users should not
need Node.js, pnpm, Rust, Cargo, C++ Build Tools, or Xcode to read PDFs.

- Windows will require a working WebView2 Runtime. Its installer detection or
  provisioning strategy and clean-machine behavior remain to be validated.
- Ubuntu packages will require compatible runtime libraries, including WebKitGTK;
  exact package dependencies and clean-machine installation remain unverified.
  Development headers and compiler packages are not intended end-user requirements.
- macOS would use the system WKWebView, but no minimum OS version or supported
  architecture is established yet.

Native compilation, packaged offline behavior, installation/uninstallation,
dependency notices, and platform acceptance remain release gates. Unsigned local
development artifacts are not equivalent to signed public releases; Windows
signing and macOS signing/notarization require separate user-controlled setup.
