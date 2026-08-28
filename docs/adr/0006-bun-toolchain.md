# ADR 0006 — Bun as the plugin's package manager, script runner, and CLI runtime

Date: 2026-08-28 · Status: accepted

## Context

`plugin/` (the TS half of the dual stack from ADR 0001) has used npm + Node
since the initial scaffold: `npm ci`/`npx` in the Makefile and CI, `#!/usr/bin/env
node` on the published `openark` CLI (`bin` in `plugin/package.json`),
Node 20/22 tested in CI.

The package has never been published (confirmed: no `openark` release exists
yet), so there is no installed base to keep compatible. The owner asked to
switch to Bun outright rather than adopt it only for local dev speed.

## Decision

Bun (latest, currently 1.4.0) becomes the plugin's package manager, script
runner, and CLI runtime — a full switch, not a dev-only convenience:

- **Package manager:** `bun install` replaces `npm ci`; `bun.lock` (Bun's
  text lockfile) replaces `package-lock.json`. Pinned via
  `"packageManager": "bun@1.4.0"` in `plugin/package.json`.
- **Scripts/CI:** `bunx`/`bun run` replace `npx`/`npm run` in the Makefile
  and `.github/workflows/ci.yml`; CI installs Bun via `oven-sh/setup-bun`
  (`bun-version: latest`) instead of a Node 20/22 matrix.
- **CLI runtime:** the published `openark` bin's shebang becomes
  `#!/usr/bin/env bun`. Once published, `bunx openark install` (etc.)
  requires Bun — there is no npm/Node fallback path.
- **Test framework unchanged:** Vitest stays (`vitest.config.ts`,
  `vi.fn`/`vi.stubGlobal` mocking used across 8 test files). Bun runs Vitest
  directly; migrating to `bun:test`'s own mocking API is a separate,
  larger change not covered by this ADR.
- **Build step unchanged:** `tsc` still compiles `dist/`; this ADR doesn't
  adopt Bun's bundler.
- `service/` (Python/uv) is unaffected — this ADR only concerns the TS side.

## Consequences

- Faster installs/tests/CI for the plugin (Bun's install and test startup
  are materially faster than npm/Node for this size of project).
- The published CLI will require Bun — a deliberate scope narrowing, made
  possible only because nothing has shipped yet. Revisiting this after
  publishing would be a breaking change for CLI users and would need a new
  ADR.
- Contributors need Bun ≥1.4 installed instead of Node ≥20 (`CONTRIBUTING.md`
  updated accordingly).
- Native npm deps (e.g. `msgpackr-extract`, a transitive dep pulled in via
  `@opencode-ai/plugin`) must resolve correctly under Bun's installer —
  verified working as part of this migration, not just assumed.
