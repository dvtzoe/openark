# Plan 0004 — Migrate the plugin toolchain to Bun

Owner: jg.tabudda. Executor: Claude, single session. Decision recorded in
[ADR 0006](../adr/0006-bun-toolchain.md) — read that first for the *why*;
this doc tracks the *how* and the execution log.

## Goal

Switch `plugin/`'s package manager, script runner, CI, and published CLI
runtime from npm/Node to Bun (latest, 1.4.0), fully — not just for local dev
speed. Confirmed feasible before starting: no native/Node-only APIs in
`plugin/src` (only `node:fs`/`node:path`/`node:os`/`node:child_process`/
`node:url`, all Bun-compatible), no publish yet so no installed base to keep
compatible, and the one transitive native dep (`msgpackr-extract`) ships
prebuilt N-API binaries.

Owner decision (asked up front, see AskUserQuestion in session transcript):
**full switch**, including the published CLI's shebang — Bun becomes a hard
requirement for `openark` end users once published, not just for
contributors. Vitest stays as the test framework (8 test files use
`vi.fn`/`vi.stubGlobal` — rewriting to `bun:test`'s mocking API is a
separate, larger change, not requested here).

## Checklist

- [ ] `plugin/package.json`: `engines.bun` instead of `engines.node`, add
      `packageManager: "bun@1.4.0"`
- [ ] Delete `plugin/package-lock.json`; regenerate `plugin/node_modules` +
      `plugin/bun.lock` via `bun install`
- [ ] `plugin/src/cli.ts`: shebang `#!/usr/bin/env node` → `bun`
- [ ] `plugin/src/core/installer.ts` + `doctor.ts`: user-facing hint strings
      `npm run build` → `bun run build`
- [ ] `Makefile`: `npm ci`/`npx`/`npm run` → `bun install`/`bunx`/`bun run`
      across `dev`, `fmt`, `plugin-lint`, `plugin-test`, `plugin-build`,
      `gen-types`; `create-module` → `bun scripts/create_module.mjs`
- [ ] `scripts/create_module.mjs`: shebang `node` → `bun`
- [ ] `.github/workflows/ci.yml`: plugin job uses `oven-sh/setup-bun`
      (`bun-version: latest`) instead of the Node 20/22 matrix + `setup-node`
- [ ] `scripts/check_file_sizes.sh`: exempt `bun.lock` instead of
      `package-lock.json`
- [ ] `CONTRIBUTING.md`: requirements line, `make dev` comment, the
      `node plugin/dist/cli.js` example
- [ ] Verify: `bun install`, `bunx biome check src tests`, `bunx vitest run`,
      `bun run build`, `scripts/check_file_sizes.sh`, and a smoke-run of the
      built CLI via `bun plugin/dist/cli.js --help` (or equivalent)
- [ ] Commit in logical chunks, tests/build green before each commit

## Log

Newest entry last.

### 2026-08-28 — Setup

- Confirmed feasibility (see Goal above) and got the owner's call on the CLI
  shebang question (full switch, Bun-only CLI) before drafting this plan.
- Wrote ADR 0006 recording the decision.
- Wrote this plan.
- **Next:** execute the checklist above, one commit per logical chunk,
  verifying `bunx vitest run` + `bun run build` + `bunx biome check` +
  `scripts/check_file_sizes.sh` before each commit.
