# CORE-01 Verification

Date: 2026-09-07. Owner: OpenCode / gpt-6-astra.
Status: done for Windows bootstrap; Linux/macOS and full-reader acceptance pending.

## Windows Gate Resolution

Relocation follow-up: the Windows copy now lives at `C:\zathura`. Moved source
and fixtures, recreated pnpm dependencies using `pnpm install --frozen-lockfile`,
and ran `cargo clean --manifest-path src-tauri/Cargo.toml` to remove cached Tauri
permission paths referring to the former location. At the new path, `pnpm test`
passes 18/18, `pnpm tauri build --no-bundle -- --locked` passes from a clean native
cache, and `pnpm test:theme:windows` passes in WebView2 152.0.4191.66. WSL source
location is unchanged. The old Windows project directory was removed, not aliased.

With explicit user authorization, installed through Windows winget:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --version 24.19.0 --accept-source-agreements --accept-package-agreements --silent --disable-interactivity
winget install --id Rustlang.Rustup --exact --accept-source-agreements --accept-package-agreements --silent --disable-interactivity --override "-y --default-toolchain 1.93.0 --profile minimal"
npm.cmd install --global pnpm@10.32.1
```

Windows environment: build 26200 x64, Node 24.19.0, pnpm 10.32.1, Rust/Cargo
1.93.0, rustup 1.29.1, MSVC Build Tools 2019, WebView2 152.0.4191.66.
Source copy: C:\zathura, with independent node_modules and target outputs
(subsequently relocated at the user's request; initial checks predate the move).
WSL remains the authoritative source workspace and has no Rust installation.

The first native check discovered Tauri 2.10.2 incompatible with the current
resolved runtime (E0308 in upstream new_window_handler). Updated direct pins to
Tauri 2.11.5 / tauri-build 2.6.3 and regenerated Cargo.lock. All following checks
passed with that lock, copied back to the source workspace. Wry resolves to 0.55.1
and Tao to 0.35.3. Generated app icons from the original app-icon.svg with
`pnpm tauri icon app-icon.svg`; no third-party image assets used.

| Windows command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed on separate Windows dependency installation. |
| `pnpm typecheck` | Passed. |
| `pnpm test` | Passed, 3/3 bootstrap tests. |
| `pnpm build` | Passed. |
| `cargo generate-lockfile --manifest-path src-tauri/Cargo.toml` | Passed, 431 locked packages. |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | Passed. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | Passed; zero Rust unit tests in this empty shell. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed. |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings` | Passed. |
| `pnpm tauri build --no-bundle -- --locked` | Passed; src-tauri/target/release/local-pdf-reader.exe. |
| `powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-shell-smoke.ps1` | Passed: expected native window title, responsive process, bundled "No document open." text in WebView2 accessibility tree, clean exit on window close. |

The smoke script was executed from its WSL UNC path with `-Executable` pointing
to the Windows build. It enables renderer accessibility only for its child app,
restores its process environment, and closes the app. No remote debugging port
or global execution-policy changes. No Vite server was running for the release
smoke check. This proves bundled shell content, not offline PDF rendering.

CORE-01 dependency gate is open. No installers, signing, publishing, macOS
support, or clean native Ubuntu validation are claimed.

## Initial Investigation (Historical)

## Environment

- Workspace: WSL2 Ubuntu 24.04.4, x86_64, kernel 6.6.87.2-microsoft-standard-WSL2.
- Node 24.14.0; pnpm 10.32.1.
- `pkg-config --modversion webkit2gtk-4.1 gtk+-3.0`: 2.52.6 and 3.24.41.
- `rustc --version` and `cargo --version`: command not found; no ~/.cargo directory.
- Windows PowerShell 5.1.26100.9168; Windows OS build 26200.
- Windows `Get-Command node,pnpm,rustc,cargo,cl -ErrorAction SilentlyContinue`:
  no resolved commands. This is PATH evidence, not proof of absent installations.
- Windows `vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`:
  `C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools`.
- Windows EdgeUpdate Clients registry: Microsoft Edge WebView2 Runtime 152.0.4191.66.

## Commands And Results

| Command | Result |
| --- | --- |
| `pnpm install` | Passed; created pnpm-lock.yaml from the initially empty workspace. |
| `pnpm install --frozen-lockfile --force` | Passed; reinstalled locked dependencies. Retried registry timeouts for optional platform binaries; no lockfile resolution update. |
| `pnpm typecheck` | Passed. |
| `pnpm test` | Passed, 3 tests: no native capability grants, restrictive production CSP, pnpm/loopback development hooks. |
| `pnpm build` | Passed; generated local HTML/CSS/JS in dist. |
| `pnpm tauri info` | Reported GTK/WebKitGTK available; Rust, Cargo, rustup absent. |
| `pnpm tauri build --no-bundle` | Failed before compilation: cargo metadata cannot execute, OS error 2. |

These are configuration tests, not rendering, accessibility, or native smoke tests.
No native launch, offline package check, installer, or Windows build has passed.

## Scope And Blockers

The bootstrap has no plugins, commands, filesystem permissions, remote assets,
or global Tauri bridge. Installer bundling is disabled. PDF.js, file opening,
and reader controls are deliberately absent rather than represented by mock UI.

JavaScript versions are pinned and locked. Rust 1.93.0 is selected, and direct
Tauri crate versions are pinned; their existence was checked against crates.io.
Transitive Rust resolution and Cargo.lock generation require Cargo and have not
been performed. Native resource/build issues may still be discovered at compile.

Initial next action (resolved above): make native Windows Node/pnpm and the Rust MSVC toolchain available,
generate/review Cargo.lock, run locked Rust checks, and compile/launch from a
separate Windows filesystem checkout. Check SDK prerequisites if compilation
fails. Do not share WSL node_modules or target outputs with Windows.

At this initial investigation, no system toolchain installation, publishing,
signing setup, or commits had been performed. Windows prerequisites were then
installed with user authorization as recorded above; no publishing or commits.
