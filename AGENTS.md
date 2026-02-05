# AGENTS

This monorepo builds a Vim-style PDF/EPUB viewer (web-first) with a minimal, boxy UI and TokyoNight Storm as the default theme.

## Tooling

- Package manager: `pnpm` workspaces
- Dev: `pnpm dev` or `pnpm dev:web`
- Build: `pnpm build`
- Typecheck: `pnpm check-types`

## Scope Hints

- Web app lives in `apps/web`.
- Keep UI minimal and boxy; avoid extra chrome or placeholders.
