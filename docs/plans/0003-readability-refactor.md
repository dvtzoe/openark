# Plan 0003 — Readability & robustness refactor

Owner: jg.tabudda (project owner, taking over maintenance from the initial
vibecoded scaffold). Executor: Claude, across multiple sessions. This doc is
the resumable source of truth — **read this file first** if picking this
work back up.

## Goal

The owner didn't write the original scaffold and wants to actually
understand and maintain it. Goal is not new features — it's:

1. Verify the code matches the documented architecture (`ARCHITECTURE.md`,
   `docs/DESIGN.md`, `docs/MODULE_SPEC.md`); fix drift.
2. Refactor for readability per `docs/READABILITY.md`, even at the cost of
   micro-optimizations.
3. Strip useless comments, add comments that explain non-obvious *why*.
4. Maximize type safety and error handling so the system degrades instead of
   breaking (this is already a stated project principle — see
   `MODULE_SPEC.md` "failures degrade to no-op" — the audit checks it's
   actually true everywhere, not just where convenient).
5. Keep it real: run `make test` / `make lint` after every step. A
   readability refactor that breaks behavior is a regression, not a win.

## Process (per the owner's explicit instructions)

1. ~~Research what makes code readable~~ → `docs/READABILITY.md`. Done.
2. Audit the code against that + architecture docs, module by module. Note
   suspected bad patterns; verify each is actually a problem (not just
   unfamiliar) before flagging it.
3. For each area, draft the fix **in natural language** in this doc (or a
   linked per-area file) — no code changes yet.
4. Review the draft (owner can read/redirect here).
5. Implement, verified by `make test && make lint`, one focused commit per
   step on the `refactor/readability` branch.
6. Update the log below after every step, and *especially* before context or
   rate limits force a stop, so a fresh session can resume without
   re-deriving context.

## Ground rules for every session picking this up

- Branch: `refactor/readability`. Commit after each verified step (tests +
  lint green). Do not merge to `main` without the owner's go-ahead.
- Read `docs/READABILITY.md` and this file before touching code.
- Check the log at the bottom for the last completed step and what's next.
- One logical change per commit, conventional commit prefixes
  (`refactor:`, `fix:`, `test:`, `docs:`), matching `CONTRIBUTING.md`.
- Files stay ≤999 lines (ADR 0005) — if a per-area findings doc grows large,
  split it (e.g. `0003-findings-plugin.md`, `0003-findings-service.md`).
- Tests may be added/expanded where coverage is thin (owner approved this
  explicitly), not just preserved.

## Scope map

Status legend: `[ ]` not started · `[~]` audited, fix not yet applied ·
`[x]` audited and fixed (tests+lint green). Ordered roughly core-outward,
since core types/contracts are what everything else depends on (fixing a
shared type once beats fixing five call sites separately):

- [~] **Plugin core** — `plugin/src/core/{types,config,service,loader,
      lifecycle,runtime,hooks,bootstrap,agent-template,installer,doctor}.ts`
      — audited (findings in `0003-findings-plugin-core.md`), not yet fixed
- [~] **Plugin modules** — `plugin/src/modules/{memory,personality,
      reflection,skills,index}.ts`, `plugin/src/index.ts`, `plugin/src/cli.ts`
      — audited (findings in `0003-findings-plugin-modules.md`), not yet fixed
- [~] **Service core** — `service/openark/core/{config,models,registry,llm,
      prompts}.py`, `service/openark/app.py` — audited (findings in
      `0003-findings-service-core.md`), not yet fixed
- [ ] **Service modules** — `service/openark/modules/{base,memory,persona,
      lessons,skills,channels}.py`
- [ ] **Service API layer** — `service/openark/api/v1/*.py`
- [ ] **Cross-cutting** — error handling audit, type-safety audit
      (`Any`/`unknown`/untyped dict usage), comment audit, doc-vs-code drift
      list

`plugin/src/generated/api-types.ts` is generated (OpenAPI → TS) — out of
scope for hand-editing; if its *shape* needs to change, that's a service API
change, not a plugin readability fix.

## Findings & draft-fix documents

Per-area audit findings and natural-language draft fixes live in sibling
files, linked here as they're written:

- [0003-findings-plugin-core.md](0003-findings-plugin-core.md) — timeouts,
  manifest caching, `venvPython` naming collision, dead code, magic numbers
- [0003-findings-plugin-modules.md](0003-findings-plugin-modules.md) —
  **cross-agent/cross-session buffer leak in memory+reflection modules**
  (highest-priority finding so far), repeated ad hoc arg validation
- [0003-findings-service-core.md](0003-findings-service-core.md) — **no
  Python type checker configured anywhere** (type hints unenforced), one
  corrupted `agent.json` can 500 the whole agent-list endpoint, an
  undocumented model-routing fallback, a stale `type: ignore`

## Log

Newest entry last. Each entry: date, what was done, what's next.

### 2026-08-28 — Setup

- Read all of `docs/`, `ARCHITECTURE.md`, `ROADMAP.md`, `CONTRIBUTING.md`.
  Confirmed with the owner: work on `refactor/readability` branch,
  commit-per-verified-step; tests may be expanded, not just preserved.
- Measured scope: ~3.8k lines TS (plugin, excl. generated api-types.ts which
  is ~1.5k of that) + ~2.2k lines Python (service). All files already under
  the 999-line cap.
- Wrote `docs/READABILITY.md` (research: Ousterhout's deep-modules/complexity
  framing, parse-don't-validate, comment "why not what" consensus, naming
  and cognitive-load research) — the checklist the audit will use.
- Wrote this plan doc.
- **Next:** start the audit at the plugin core (`plugin/src/core/`), since
  everything else depends on its types/contracts. Read each file, check
  against `MODULE_SPEC.md` + `READABILITY.md`, note findings (don't fix).

### 2026-08-28 — Plugin audit (core + modules)

- Audited all of `plugin/src/core/*.ts`, `index.ts`, `cli.ts`. 8 findings,
  written to `0003-findings-plugin-core.md`. Verified each with grep/reading
  call sites before writing it up (not guessing) — e.g. confirmed
  `manifestAllows` truly has zero callers, confirmed `venvPython` really is
  two different functions with the same name, confirmed `getJSON`/`postJSON`
  really have no timeout unlike `health()`.
- Audited all of `plugin/src/modules/*.ts`. Found a real correctness bug,
  not just style: `memory.ts` and `reflection.ts` keep their session
  transcript/failure buffers as **module-scope singletons**, shared across
  every agent and session in the process, despite the documented
  multi-agent/private-memory architecture and `runtime.ts`'s explicit
  agent-switching support. Verified via grep that the `ctx` parameter
  in the affected handlers is literally named `_ctx` (unused) at all three
  call sites. Written up in `0003-findings-plugin-modules.md` with a
  concrete two-concurrent-session failure scenario. This is the
  highest-priority finding of the audit so far.
- Also found: every module tool (~15 call sites across all 4 modules)
  hand-validates its own args with ad hoc `typeof`/`Array.isArray` checks
  instead of a zod schema, even though zod is already used elsewhere in the
  plugin for the outer tool-args envelope — a direct match for the
  "parse, don't validate" gap called out in `READABILITY.md` §5.
- **Next:** audit the service (Python) side — start with `service/openark/
  core/` (config, models, registry, llm, prompts), then `modules/`, then
  `api/v1/`. Same process: read against `MODULE_SPEC.md`/`DESIGN.md` +
  `READABILITY.md`, verify suspicions before writing them up, draft fixes in
  natural language only.

### 2026-08-28 — Service core audit

- Audited `service/openark/core/{config,models,registry,llm,prompts}.py` +
  `app.py`. Findings in `0003-findings-service-core.md`.
- Biggest one: verified (checked `pyproject.toml`, `Makefile`, and
  `.github/workflows/ci.yml` directly) that **no Python static type checker
  is configured anywhere** — only `ruff check` runs, which doesn't
  type-check. A stray `# type: ignore[union-attr]` in `llm.py` is a fossil
  from a check that no longer runs. This is the highest-leverage fix for
  the owner's "maximum type safety" goal on the Python side — recommend
  doing it early (adding pyright/mypy to `make lint` + CI) so the rest of
  the type-safety pass has a tool driving it instead of manual inspection.
- Also found a real robustness gap matching the "impossible to break"
  goal: `AgentRegistry.list()` has no per-agent error handling, so one
  corrupted `agent.json` 500s the entire `GET /v1/agents` endpoint instead
  of degrading just that one agent (contradicts ADR 0004's "one polluted
  agent cannot poison everyone" philosophy, which the plugin side already
  respects for the single-agent-load case).
- **Next:** audit `service/openark/modules/{base,memory,persona,lessons,
  skills,channels}.py`.
