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
- [~] **Service modules** — `service/openark/modules/{base,memory,persona,
      lessons,skills,channels}.py` — audited (findings in
      `0003-findings-service-modules.md`), not yet fixed
- [~] **Service API layer** — `service/openark/api/v1/*.py` — audited
      (findings in `0003-findings-service-api.md`), not yet fixed
- [x] **Cross-cutting** — error handling, type-safety, comments, and
      doc-vs-code drift were checked as part of each area above rather than
      as a separate pass (each findings doc calls out which category a
      finding belongs to). See "Priority order for fixing" below for the
      cross-area synthesis.

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
- [0003-findings-service-modules.md](0003-findings-service-modules.md) —
  modules return raw dicts instead of the typed Pydantic response models
  already defined for them (validated only at the outermost API layer,
  a call away from where the dict is built), an error-handling
  inconsistency between `MemoryModule.add`/`ingest`, and the same
  "one corrupted file breaks the whole list" shape as service-core #2,
  found again in `SkillsModule.list`
- [0003-findings-service-api.md](0003-findings-service-api.md) — the same
  "look up agent, 404 if missing" check implemented 5 different ways
  across 5 files, a 3rd occurrence of the "one corrupted item breaks the
  whole list" pattern, an untyped `app.state.modules` dict feeding
  `Any`-typed module lookups everywhere, and the version string hardcoded
  independently in 6 places across both runtimes

## Priority order for fixing

Synthesized across all five findings docs once the audit phase finished
(2026-08-28). This is a recommendation, not a decision — **awaiting owner
review before any fixing starts**, per the agreed process. 23 findings
total across 5 docs.

**Tier 1 — correctness/robustness (fix first; these are real bugs, not
style):**

1. Cross-agent/cross-session buffer leak in `memory.ts`/`reflection.ts`
   (`0003-findings-plugin-modules.md` #1) — highest priority, touches data
   privacy between agents.
2. No timeout on `getJSON`/`postJSON` — a hung service can hang a session
   (`0003-findings-plugin-core.md` #1).
3. The "one corrupted file breaks listing everything" pattern — 3
   occurrences, fix consistently in one pass
   (`0003-findings-service-core.md` #2, `0003-findings-service-modules.md`
   #3, `0003-findings-service-api.md` #2).
4. Manifest caching contradicts documented "toggle at any time" behavior
   (`0003-findings-plugin-core.md` #2) — do together with #1 above, both
   touch `runtime.ts`.
5. `MemoryModule.add` missing the error handling its sibling `ingest()` has
   (`0003-findings-service-modules.md` #2).

**Tier 2 — type-safety infrastructure (high leverage, do before the type
fixes that depend on them):**

6. Add a Python type checker to the toolchain — nothing else Python-side
   type-safety-related can be verified without this
   (`0003-findings-service-core.md` #1). Do this **before** #7 and #14.
7. Modules return raw dicts instead of the typed response models already
   defined for them; `app.state.modules` is an untyped dict feeding
   `Any`-typed lookups everywhere — related, same root cause, fix together
   (`0003-findings-service-modules.md` #1, `0003-findings-service-api.md`
   #3).
8. ~15 call sites hand-validate tool args instead of zod schemas
   (`0003-findings-plugin-modules.md` #2).

**Tier 3 — readability/consistency (safe, mechanical, low risk):**

9. Duplicate-named `venvPython` functions (`0003-findings-plugin-core.md`
   #3). 10. Dead code `manifestAllows` (`...plugin-core.md` #4). 11.
   Duplicated `_require_agent` across 5 API files (`...service-api.md` #1).
   12. Version string hardcoded in 6 places (`...service-api.md` #4). 13.
   Unnecessary `as ModuleContext` cast(s) (`...plugin-core.md` #7). 14.
   Untyped `settings` param + stale `type: ignore` in `llm.py`
   (`...service-core.md` #4, do after #6).

**Tier 4 — style batch (bundle into one or two cleanup commits):**

15. Port default duplicated in 2 TS files. 16. Inconsistent silent-catch
    commenting for agent.json description parsing. 17. Redundant `|
    undefined` in `types.ts`. 18. Duplicated bounded-buffer FIFO logic
    (fix alongside #1). 19. Split `import type` statements in 2 module
    files. 20. Undocumented model-routing fallback + missing why-comment.
    21. Mixed Pydantic default-value idiom in `models.py`. 22. Inconsistent
    `OSError`/`ValueError` catching in `lessons.py`. 23. Stale Mem0
    store-cache comment opportunity.

(15–23 map to the remaining minor findings in each doc, referenced there by
number.)

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

### 2026-08-28 — Service modules audit

- Audited all six files in `service/openark/modules/`. Findings in
  `0003-findings-service-modules.md`. These are well-decomposed overall
  (small pure helpers, dataclasses for parsed file state) — findings are
  real, targeted gaps, not a rewrite verdict.
- Biggest one: every module method builds and returns a raw `dict[str,
  Any]`, even though `core/models.py` already defines the exact Pydantic
  response shape for each of them — confirmed by reading `api/v1/persona.py`
  and `api/v1/lessons.py`, where *every* endpoint re-wraps the module's dict
  into the real response model on its last line. The type contract exists
  but is enforced one call away from where the data is actually built, so
  module-level unit tests (required per module by `CONTRIBUTING.md`) can't
  catch a shape mismatch the way they could against a real typed return.
  Also found the same "one corrupted file breaks listing everything" shape
  from `0003-findings-service-core.md` #2 recurring in
  `SkillsModule.list`/`_read` — and a good existing counter-example already
  in the codebase (`channels.py`'s per-line try/except) that both should be
  made consistent with, rather than inventing a new pattern.
- **Next:** audit `service/openark/api/v1/*.py` (the versioned REST
  contract layer) — check each endpoint against its module + against
  `MODULE_SPEC.md`'s "modules never import each other; cross-module
  composition happens in the API layer" rule, and reconcile with findings
  already surfaced from reading `persona.py`/`lessons.py` above (already
  read during the modules pass; still need `agents.py` cross-checked
  against `0003-findings-service-core.md` #2, plus `memory.py`, `skills.py`,
  `channels.py`, `health.py`, `router.py`). After that, the audit phase is
  complete and findings should be summarized for owner review before any
  fixing starts, per the agreed process.

### 2026-08-28 — Service API layer audit; audit phase complete

- Audited all of `service/openark/api/v1/*.py`. Findings in
  `0003-findings-service-api.md`. Confirmed (by grep) that `MODULE_SPEC.md`'s
  "modules never import each other" rule is genuinely respected — zero
  cross-module imports anywhere in `service/openark/modules/`.
- Found the same "look up agent, 404 if missing" logic implemented 5
  different ways across 5 files (3 identical private copies, 1 superset
  version, 1 inlined-without-a-helper) — a clean, low-risk, mechanical
  consolidation.
- Found a 3rd occurrence of the "one corrupted item breaks the whole list"
  pattern (in `channels.py`'s `read_channel`), confirming it's systemic
  (3 occurrences across 2 layers) rather than 3 unrelated one-offs — should
  be fixed consistently in one pass, not patched separately.
- Found the version string hardcoded independently in 6 places across both
  runtimes (only 2 of the 6 should be sources of truth).
- **Audit phase is done.** 23 findings total across 5 docs. Wrote a
  cross-area "Priority order for fixing" section above, synthesizing all
  five findings docs into four tiers (correctness/robustness first, then
  type-safety infrastructure, then mechanical readability fixes, then a
  style batch). **Stopping here for owner review, per the agreed process —
  no fixes have been applied yet.** Whoever resumes this (owner or a future
  session): start by reading the priority order above, confirm/adjust it,
  then begin with Tier 1 item 1 (or wherever the owner redirects), one
  commit per verified fix (`make test && make lint` green before each
  commit), updating this log after every step.
