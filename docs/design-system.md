# Design System

The application shell uses semantic CSS custom properties in `src/tokens.css`.
`src/style.css` declares the cascade order (`tokens`, `base`, `components`,
`app`) and imports those tokens. `index.html` loads the stylesheet before the
application script so theme selection does not depend on JavaScript startup.

## Theme Policy

The default `:root` palette is light. `prefers-color-scheme: dark` replaces every
color token and selects the dark `color-scheme` for browser-rendered controls.
The OS preference is the source of truth, including changes while the app is
open. There is no manual theme toggle, stored theme preference, or startup script
that chooses a palette. Do not add theme classes, inline styles, or TS palettes.

`forced-colors: active` replaces semantic colors with system colors and removes
the control shadow. Do not disable forced-color adjustment. Keyboard focus uses
a real outline, not only a shadow. `prefers-reduced-motion: reduce` sets the fast
duration to zero; new motion durations need corresponding reduced-motion values.
Coarse pointers increase the minimum control size via a token override.

## Token Categories

| Category | Examples | Purpose |
| --- | --- | --- |
| Typography | `--font-family-ui`, `--font-family-mono`, `--font-size-body`, `--font-weight-medium`, `--line-height-body`, `--letter-spacing-heading` | Families, sizes, weights, leading, tracking |
| Spacing | `--space-0`, `--space-3`, `--space-6` | Margins, padding, gaps, including zero |
| Sizing | `--size-viewport-block`, `--size-content-inline`, `--size-control-min`, `--size-icon` | Viewport, content, controls, icons |
| Shape | `--radius-small`, `--radius-pill`, `--border-width`, `--border-width-focus`, `--focus-offset` | Corners, borders, focus geometry |
| Elevation | `--shadow-offset`, `--shadow-control`, `--layer-popover` | Shadow geometry/composition and stacking |
| Motion | `--duration-fast`, `--ease-standard` | Transition timing |
| Colors | `--color-canvas`, `--color-surface`, `--color-text`, `--color-text-muted` | Shell surfaces and text |
| Interaction colors | `--color-control`, `--color-control-hover`, `--color-control-active`, `--color-border-control`, `--color-focus` | Control states and visible boundaries |
| Other semantic colors | `--color-text-disabled`, `--color-selection`, `--color-on-selection`, `--color-accent`, `--color-danger`, `--color-shadow` | Disabled, selected, accented, error, shadow roles |
| Browser theme | `--theme-color-scheme` | Browser-rendered control appearance |

`--color-border` is a subtle decorative separator. Use
`--color-border-control` when a boundary is needed to identify an interactive
control. Do not substitute the decorative border for a focus indicator.

## Adding Components

Reuse semantic tokens rather than copying their current values. For example:

```css
@layer components {
  .document-action {
    min-block-size: var(--size-control-min);
    padding: var(--space-1) var(--space-3);
    border: var(--border-width) solid var(--color-border-control);
    border-radius: var(--radius-small);
    font-size: var(--font-size-small);
    color: var(--color-text);
    background-color: var(--color-control);
    transition: background-color var(--duration-fast) var(--ease-standard);
  }
}
```

Raw colors, fonts, typography metrics, spacing, sizes, radii, shadows, border
widths, and durations belong in `tokens.css`, not component rules or markup.
Structural CSS such as `display: grid`, `flex: 1`, `auto`, `inherit`, `none`, and
the `solid` border style can remain literal. A `var()` elsewhere in a declaration
does not excuse a hardcoded design value in the same declaration.

Add a token only when the existing roles do not express the need. Define it on
the default `:root`; add every new color to both the dark and forced-colors
overrides. References must resolve without cycles in all modes. Components use
the same token names in both themes, rather than maintaining their own palettes.
Add contrast pairs to the tests when introducing new foreground/background
combinations. Normal text must reach 4.5:1; focus and identifying control borders
must reach 3:1. The tests also enforce 4.5:1 for the current disabled text pair as
a project policy, even though disabled controls are exempt from WCAG contrast.

## Native And Document Boundaries

CSS styles the WebView content, not Tauri's native title bar, window frame, or
native file dialogs. Tauri window configuration leaves `theme` unset so native
chrome follows the OS. Native appearance cannot be customized with these CSS
tokens and requires separate platform verification.

The PDF.js viewer components ship their own stylesheet, loaded as
`pdfjs-dist/legacy/web/pdf_viewer.css` from `src/main.ts`. Upstream rules are
unlayered and therefore win the cascade over our `@layer` rules regardless of
order. Token-based viewer overrides live in `src/viewer-overrides.css`, which
is imported after the vendored sheet and is the only place allowed to restyle
viewer internals (currently: shell color-scheme, page shadow, text-selection
colors). Page artwork keeps the document's own colors; do not invert, filter,
or recolor PDF page content when the shell changes theme.

## Verification

Run `pnpm exec node --test tests/design-system.test.mjs` for focused policy checks,
or `pnpm test` for the full suite (requires the dev-only fixture Python setup in
fixtures/README.md). The design-system tests use
PostCSS ASTs for theme parity, token references/cycles, component declarations,
accessibility media conditions, and stylesheet wiring. They calculate contrast
from the current opaque six-digit hex foreground/background pairs rather than
freezing palette values or token counts. Lightweight source guards reject inline
styles and embedded hex/function palettes in application TS and HTML.

These source-level tests are not a complete CSS/TS interpreter. Computed styles
and actual bundled WebView2 content are checked separately on native Windows:

```powershell
pnpm tauri build --no-bundle -- --locked
pnpm test:theme:windows
```

The native test starts its own release executable and isolated temporary WebView2
profile. A process-local loopback CDP endpoint lets Playwright Core inspect that
webview, not a Chromium preview. No browser download, runtime testing dependency,
global keyboard input, file selection, Windows theme changes, persisted theme,
or shipped debugging configuration is added. The test closes its app and removes
its temporary profile. Announce this test before running because it opens a window.

Both tests pass on Windows build 26200 x64, WebView2 152.0.4191.66. The native test
checks startup against the current OS preference, live emulated light/dark changes,
computed token propagation, hover/focus, a 360x320 emulated webview viewport,
enlarged text, reduced motion and forced colors. OS setting changes and title-bar
colors are not automated; macOS and native Linux remain unverified. See
[verification evidence](verification/design-system.md) for exact results.
