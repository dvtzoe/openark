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

- [x] `plugin/package.json`: `engines.bun` instead of `engines.node`, add
      `packageManager: "bun@1.4.0"`
- [x] Delete `plugin/package-lock.json`; regenerate `plugin/node_modules` +
      `plugin/bun.lock` via `bun install`
- [x] `plugin/src/cli.ts`: shebang `#!/usr/bin/env node` → `bun`
- [x] `plugin/src/core/installer.ts` + `doctor.ts`: user-facing hint strings
      `npm run build` → `bun run build`
- [x] `Makefile`: `npm ci`/`npx`/`npm run` → `bun install`/`bunx`/`bun run`
      across `dev`, `fmt`, `plugin-lint`, `plugin-test`, `plugin-build`,
      `gen-types`; `create-module` → `bun scripts/create_module.mjs`
- [x] `scripts/create_module.mjs`: shebang `node` → `bun`
- [x] `.github/workflows/ci.yml`: plugin job uses `oven-sh/setup-bun`
      (`bun-version: latest`) instead of the Node 20/22 matrix + `setup-node`
- [x] `scripts/check_file_sizes.sh`: exempt `bun.lock` instead of
      `package-lock.json`
- [x] `CONTRIBUTING.md`: requirements line, `make dev` comment, the
      `node plugin/dist/cli.js` example
- [x] Verify: `bun install`, `bunx biome check src tests`, `bunx vitest run`,
      `bun run build`, `scripts/check_file_sizes.sh`, and a smoke-run of the
      built CLI via `bun dist/cli.js version`
- [x] Commit in logical chunks, tests/build green before each commit

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

### 2026-08-28 — Executed; migration complete

- Applied every checklist item above in three commits: (1) this plan + ADR
  0006, (2) `plugin/` package management + CLI runtime (`package.json`,
  `bun.lock`, `cli.ts` shebang, `installer.ts`/`doctor.ts` hint strings),
  (3) build tooling/CI/docs (`Makefile`, `ci.yml`, `check_file_sizes.sh`,
  `create_module.mjs`, `CONTRIBUTING.md`).
- **Found and fixed a real dependency-resolution bug along the way, not
  anticipated in the original checklist:** `bun install` initially resolved
  our own `"zod": "^4.1.8"` to `4.4.3` (newest matching), while
  `@opencode-ai/plugin` depends on an exact `zod: 4.1.8` — Bun installed
  *both* as separate copies (top-level + nested in
  `@opencode-ai/plugin/node_modules/`), and TypeScript's structural check on
  Zod v4's internal version branding then failed
  (`src/index.ts` — `_zod.version.minor` `4` not assignable to `1`) on
  `bun run build`. Confirmed via `git show HEAD:plugin/package-lock.json`
  that npm's old lockfile had happened to dedupe both requirements down to a
  single `zod@4.1.8` — the range was always looser than the real constraint,
  npm's resolver just papered over it. Fixed by pinning our own dependency
  to the exact `"zod": "4.1.8"` @opencode-ai/plugin already requires (not a
  Bun workaround — this is the correct fix under any package manager).
  Verified: single `node_modules/zod` after the fix, `bun run build` clean.
- Two devDependency postinstall scripts were blocked by Bun's default
  lifecycle-script sandboxing (a security feature npm didn't have):
  `@biomejs/biome` (platform binary selection) and, after the zod fix
  changed resolution, `esbuild` (platform binary) and `msgpackr-extract`
  (native N-API binary, transitive). All three are well-known packages with
  standard, legitimate binary-selection postinstalls — trusted via
  `bun pm trust`, which recorded them in `package.json`'s
  `trustedDependencies` so future installs aren't blocked.
- **Full verification, all green:** `bunx biome check src tests` (35 files,
  clean), `bunx vitest run` (120/120 tests, 15 files), `bun run build` (tsc,
  clean), `bun dist/cli.js version` (prints `0.1.0`, confirming the CLI runs
  correctly under Bun via its new shebang), `scripts/check_file_sizes.sh`
  (clean, confirms `bun.lock`'s exemption works).
- **Migration complete.** No follow-up work identified — `service/`
  (Python/uv) was out of scope and untouched.
