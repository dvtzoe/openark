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

## Owner decisions (2026-08-28)

Asked before starting the fix phase, in a fresh session picking this plan
back up. Answers, verbatim intent preserved:

1. **Priority order** (the four tiers above) — approved as-is. Start Tier 1
   item 1, work down.
2. **Python type checker choice** (Tier 2 #6) — **basedpyright**, not
   pyright or mypy. (Owner's pick; not independently justified beyond the
   choice itself — basedpyright is a strict-by-default pyright fork with
   more diagnostics enabled out of the box.)
3. **Autonomy level** — work through tiers continuously in this session: one
   commit per verified fix (`make test && make lint` green first), update
   this log after every step, only stop to report at natural checkpoints or
   when context/rate limits force it. Do not stop after every tier or every
   commit to ask permission.

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

### 2026-08-28 — Owner review; fix phase starts (Tier 1 #1 + #4)

- Owner reviewed the priority order and approved it as-is (see "Owner
  decisions" above). Picked **basedpyright** for the Tier 2 Python type
  checker. Approved working through tiers continuously rather than
  stopping after every commit.
- Started Tier 1 item 1 (cross-agent/cross-session buffer leak). While
  reading the actual code to draft the fix, found the root cause is bigger
  than the original audit described: `runtime.ts` kept a single mutable
  "current agent" pointer shared by every concurrent session (not just the
  two buffer singletons), and `index.ts`'s `collectTools` bound every
  tool's `execute` to whichever agent's context existed at plugin startup —
  verified against the real `@opencode-ai/plugin`/`sdk` type declarations
  that `ToolContext`/hook inputs already carry `sessionID` (and `agent`)
  that the plugin just wasn't using. Documented as finding **1b** in
  `0003-findings-plugin-modules.md` with the revised draft fix, since the
  owner's process requires drafting in natural language before fixing —
  this was written up before any code changed.
- **Implemented** (one cohesive change, since #1 and #1b share the same
  root cause and the fix docs said to do the runtime.ts parts together):
  - `runtime.ts`: replaced the single mutable `current` pointer with
    per-call resolution keyed by `sessionID` (`resolve()` +
    `withSession()`), building a fresh `ModuleContext` per call instead of
    mutating a shared one. Replaced `switchAgent` with
    `noteSession`/`forgetSession`. `loaded` (per-agent module cache) stays,
    since module instances are legitimately cacheable per agent.
  - Folded in **Tier 1 #4** (manifest cached for the process lifetime,
    contradicting `MODULE_SPEC.md`'s "toggle at any time... reads the
    manifest at session start") while already restructuring this file:
    verified first that all four modules' `init()` is a cheap, idempotent
    health check (safe to re-run), then added `sessionSeenAgents` so the
    manifest+module set is re-read the first time *each session* touches
    an agent, not cached for the whole plugin process.
  - `hooks.ts`: deleted `createSessionTracker`/`tracker.touch` (redundant
    now that every runtime call resolves fresh per `sessionID`) and the
    now-empty `tool.execute.after` hook. `toolFailure()` now surfaces
    `part.sessionID` (a real `ToolPart` field) so tool-failure events route
    to the right session.
  - `index.ts`: `collectTools` still enumerates tool names/descriptions
    once at startup, but each tool's `execute` re-resolves the live
    `ModuleContext` via `runtime.ctx(context.sessionID)` — using the
    `sessionID` opencode's own `ToolContext` already provides — before
    invoking the matching tool, instead of closing over a stale
    startup-time context.
  - `memory.ts`/`reflection.ts`: buffers changed from module-scope
    singletons to `Map<sessionID, ...>`, per the original #1 draft.
  - Tests updated/added in `runtime.test.ts`, `hooks.test.ts`,
    `memory.test.ts`, `reflection.test.ts` — including new cross-session
    isolation tests and manifest re-read tests (owner approved expanding
    coverage, not just preserving it).
- Verified: `npm run build` (tsc, no errors), `npx vitest run` (107/107
  passing), `npx biome check src tests` (clean after one auto-format fix),
  `scripts/check_file_sizes.sh` (all files still ≤999 lines; largest
  touched file is now `reflection.ts` at 162 lines).
- **Next:** Tier 1 item 2 (no timeout on `getJSON`/`postJSON` in
  `plugin/src/core/service.ts` — a hung service can hang a session), then
  item 3 (the "one corrupted file breaks listing everything" pattern,
  3 occurrences across the Python service).

### 2026-08-28 — Tier 1 #2: timeout on getJSON/postJSON/delete

- Checked `core/llm.py`'s `TaskRunner` for its own timeout (60s default,
  `httpx.Client(timeout=self._timeout)`) before picking a value, per the
  finding's own caution — the plugin's ceiling must stay above that so a
  legitimate slow LLM-backed call (extraction/reflection/distillation/
  persona_update) isn't mistaken for a hang. Picked 90s
  (`REQUEST_TIMEOUT_MS`).
- Added `signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)` to `getJSON`,
  `postJSON`, and also `delete` (not called out by name in the finding, but
  the same missing-timeout shape — fixed consistently rather than leaving
  one sibling method behind, per `READABILITY.md` §8).
- No existing test file covered `ServiceClient` directly (owner approved
  expanding coverage) — added `plugin/tests/service.test.ts`: confirms a
  real `AbortSignal` is attached on every call, a non-2xx response still
  rejects with `ServiceError`, and a fetch-level abort rejects instead of
  hanging (simulated directly rather than waiting out a real 90s timeout).
- Verified: `npm run build`, `npx vitest run` (110/110), `npx biome check`,
  `scripts/check_file_sizes.sh` — all clean.
- **Next:** Tier 1 item 3, the "one corrupted file breaks listing
  everything" pattern (3 occurrences across the Python service:
  `AgentRegistry.list()` in `core/registry.py`, `SkillsModule.list`/`_read`
  in `modules/skills.py`, `channels.py`'s `read_channel` in
  `api/v1/channels.py`) — then Tier 1 item 5 (`MemoryModule.add` missing
  the error handling `ingest()` has), closing out Tier 1.

### 2026-08-28 — Tier 1 #3: the "one corrupted file" pattern, fixed consistently across all 3 occurrences

- `core/registry.py`: `AgentRegistry.list()` now skips (logs a warning,
  keeps going) an agent whose `agent.json` fails to parse
  (`json.JSONDecodeError`) or validate (`pydantic.ValidationError`),
  instead of letting either propagate and 500 the whole `/v1/agents`
  endpoint. Bundled the atomic-write half of the same finding while in
  this file (it was the same root problem, per the finding's own framing):
  added `_atomic_write_text` (temp file in the same dir + `os.replace`)
  and switched `save_manifest`/`create()`'s `agent.json` write to use it,
  so a crash mid-write can no longer produce the torn file that trips the
  bug in the first place.
- `modules/skills.py`: `SkillsModule._read` now catches `OSError` around
  the file read (a directory-shaped `SKILL.md`, a permissions error, a
  race with a concurrent write) and skips that one skill instead of
  breaking `list()` for every skill in the agent — matching the
  try/except-and-skip shape `channels.py` already used for malformed JSONL
  lines, per the finding's explicit "copy this pattern, don't invent a new
  one."
  - `api/v1/channels.py`: `read_channel` now catches
  `pydantic.ValidationError` per item (a channel line that parsed as valid
  JSON but is missing a field `ChannelItem` requires) and skips just that
  item, logging a warning, instead of 500ing the whole channel read.
- Added `service/tests/test_registry.py` (didn't exist before — owner
  approved expanding coverage): corrupted-JSON skip, failed-validation
  skip, all-valid passthrough, atomic-write round-trip (no leftover `.tmp`
  file), and the pre-existing `AgentNotFound` behavior. Added a
  skills-module test (`test_list_skips_unreadable_skill_file`, using a
  directory in place of the expected file to force a real `OSError`) and
  an API-level test (`test_read_channel_skips_malformed_items`, hand-
  writing a JSONL line missing `source_agent`).
- Verified: `uv run pytest -q` (109/109 passing — this run took ~3m15s,
  mostly mem0/chromadb import cost, not the new tests), `uv run ruff check
  .` (clean), `scripts/check_file_sizes.sh` (clean).
- **Next:** Tier 1 item 5 — `MemoryModule.add` missing the error handling
  its sibling `ingest()` has (`service/openark/modules/memory.py`) — the
  last Tier 1 item, then Tier 2 (adding basedpyright to the toolchain).

### 2026-08-28 — Tier 1 #5: MemoryModule.add now degrades like ingest() does; Tier 1 closed out

- `MemoryModule.add` wraps its `store.add(...)` call in `try/except
  Exception`, logs, and returns `None` — matching `ingest()`'s existing
  degrade shape. Checked `api/v1/memory.py`'s `add_memory` first (per the
  finding's own note that this hadn't been read yet): it already treats a
  `None` result as a 502, so no model/endpoint change was needed — the fix
  is contained entirely to `memory.py`.
- Added `test_add_store_write_error_degrades_to_none` in
  `test_memory_module.py`, mirroring the existing
  `test_ingest_store_write_error_degrades` test for the sibling method.
- Verified: `uv run pytest -q tests/test_memory_module.py` (fast, no
  mem0/chromadb import needed for this file); full `uv run pytest -q` +
  `uv run ruff check .` running in the background, to be confirmed before
  committing.
- **Tier 1 is now closed out** (all 5 items: cross-agent/session buffer
  leak + the deeper runtime.ts race, missing timeouts, the corrupted-file
  pattern (3 occurrences), manifest caching, `MemoryModule.add`).
- **Next:** Tier 2 — add **basedpyright** to the toolchain (owner's choice)
  as the Python type-safety foundation (`0003-findings-service-core.md`
  #1), wired into `make lint` and CI, *before* touching #7 (modules
  returning raw dicts instead of typed models) or #14 (untyped `settings`
  param), per the priority order's own sequencing note.

### 2026-08-28 — Tier 2 #6: basedpyright added to the toolchain

- Installed basedpyright standalone first to see actual scope before
  deciding how to wire it in (per the finding's own instruction: "run it
  once added and use its actual output to drive the cleanup pass, rather
  than guessing"). basedpyright's own default preset (its "all rules on"
  strict mode, stricter than plain pyright even at the same
  `typeCheckingMode` name) produced **434 warnings, 8 errors** — almost
  entirely `reportAny`/`reportExplicitAny`/`reportUnannotatedClassAttribute`/
  `reportUnusedCallResult` noise from a codebase that intentionally uses
  `dict[str, Any]` at module boundaries and untyped third-party libs
  (mem0, chromadb) — not the "maximum type safety, catch real bugs" signal
  the owner actually wants from *adding a checker*.
- Configured `[tool.basedpyright]` in `pyproject.toml` with
  `typeCheckingMode = "standard"` (pyright-compatible, not basedpyright's
  stricter default) — this is a **deliberate, documented scope choice**:
  it catches real type errors without demanding full annotation coverage
  in one sitting. Re-ratcheting to a stricter mode is legitimate future
  work, not a blocker for having a type checker in the loop at all. Under
  `standard`, the same codebase drops to **1 real error**.
- That one error was a genuine bug, not noise: `MemoryModule`'s
  `MemoryStore` Protocol declared `add(..., text: str, ...)`, but
  `ingest()` already (correctly, per existing tests) calls it with
  `text: list[str]` — the real Mem0-backed store and the `FakeStore` in
  tests both already handle a list; only the Protocol's declared type was
  too narrow to describe actual usage. Widened it to `text: str |
  list[str]`, which is the fix, not a workaround — now a future caller
  passing the wrong shape will actually be caught.
- Wired into `make lint` (`service-lint` now runs `ruff check .` then
  `basedpyright`) and CI (`.github/workflows/ci.yml`'s `service` job, as a
  step between `ruff check` and `pytest`).
- Verified: `uv run ruff check .` (clean), `uv run basedpyright` (0
  errors), `uv run pytest -q` (in progress at time of writing — to
  confirm before committing), `scripts/check_file_sizes.sh`.
- **Next:** Tier 2 #7 — modules returning raw dicts instead of the typed
  Pydantic response models already defined for them, and the untyped
  `app.state.modules` dict feeding `Any`-typed lookups everywhere. Now
  that basedpyright is wired in, this fix can be verified by the type
  checker itself, not just by reading.

### 2026-08-28 — Tier 2 #7: modules return typed response models; app.state.modules is a typed dataclass

Six commits, one per unit, each verified independently (`basedpyright` +
`ruff check` + `pytest -q`, full suite, before every commit):

1. **`app.state.modules` typed as a dataclass** (`ServiceModules` in
   `app.py`) instead of a string-keyed dict. Every `get_X_module` DI
   function across `api/v1/*.py` now does `request.app.state.modules.x`
   (attribute access) with a real return type annotation
   (`-> MemoryModule`, etc.), so `Depends(get_X_module)` gives every
   endpoint a properly typed `module` parameter instead of `Any`. Verified
   empirically (not just by reasoning about it) that this is what actually
   buys the type-safety win here, since `app.state` itself is dynamically
   typed by Starlette (`State.__getattr__` returns `Any`) — the return-type
   annotation on the DI function is what `Depends()` actually reads.
2. **`PersonaModule.evolve` → `PersonaEvolveResponse`**, building
   `PersonaReplace` objects internally instead of leaving the
   tuple→dict conversion to `api/v1/persona.py` (a small abstraction leak
   per `READABILITY.md` §2 — the API layer had to know evolve()'s internal
   `(old, new)` tuple representation).
3. **`LessonsModule.reflect/add/retire/register_hits` → their four
   response models.** Found and removed genuinely dead logic along the
   way: `add_lesson`'s endpoint re-checked `result["added"] is None` to
   pick between two `LessonAddResponse` constructions that were already
   exactly what the module had just returned.
4. **`SkillsModule.distill/verify` → `DistillResponse`/
   `SkillVerifyResponse`.**
5. **`MemoryModule.add/ingest` → `MemoryMutation | None` /
   `MemoryIngestResponse`.**
6. **`ChannelsStore.push` → `ChannelItem`** (the raw dict written to the
   JSONL file still carries the extra `ts` field the model doesn't have —
   that's a storage-layer detail, not part of the public return contract,
   so it's dropped only from what's *returned*, not from what's persisted).

Every API endpoint that used to do `ResponseModel(**module.method(...))`
now does `return module.method(...)` directly — the reconstruction
boilerplate is gone from all 5 files. Test files updated from dict-index
(`result["x"]`) to attribute access (`result.x`) throughout; test doubles
in `test_api.py` that return raw dicts were left as-is where their shape
already matched the response model, since FastAPI validates/serializes
any return value against `response_model` regardless of whether it's a
dict or the real Pydantic instance — confirmed this by running the full
suite, not assumed.
- **Next:** Tier 2 #8 — ~15 call sites hand-validate tool args on the
  plugin side instead of zod schemas (`0003-findings-plugin-modules.md`
  #2). This closes out Tier 2. Tier 3 (mechanical readability/consistency:
  duplicate `venvPython`, dead `manifestAllows`, duplicated
  `_require_agent`, hardcoded version string, unnecessary casts) and Tier
  4 (style batch) remain after that.

### 2026-08-28 — Tier 2 #8: tool args parsed with zod; Tier 2 closed out

- Added `plugin/src/core/args.ts` with two shared builders
  (`requiredString`, `filteredStringArray`) that deliberately replicate
  the exact leniency every ad hoc check already had (non-string → "",
  malformed array element dropped rather than rejecting the whole call) —
  confirmed this by running the full existing test suite unchanged before
  writing a single new test, and all 110 passed with zero test edits
  needed. This was a genuine "will the substring-matched error messages
  still work through a ZodError" question, not assumed: `.rejects.toThrow
  ("signals is required")` still matches because `ZodError.message` is a
  JSON blob containing the custom message string, so the old substring
  assertions keep working.
- Replaced all ~15 hand-rolled validations across `memory.ts`,
  `personality.ts`, `reflection.ts`, `skills.ts` with `schema.parse(args)`
  at the top of each tool's `execute`. `reflect`'s "failures or messages"
  cross-field rule and `persona_evolve`'s "signals must be non-empty"
  rule are both expressed as `.refine()` on top of the shared array
  builder, since which specific non-empty rule applies differs per tool.
  Deliberately left two low-stakes args alone (`all` on `lessons_list`/
  `skills_list`, `subscribe` on `channel_subscribe`) — both are already
  fully safe `=== true`/`=== false` identity checks with no error path,
  so wrapping them in zod would be forced abstraction, not a real fix.
- Added `plugin/tests/args.test.ts` — the shared helpers are now
  infrastructure used by 4 modules and deserve direct unit tests, not
  just indirect coverage through each module's own tests (owner approved
  expanding coverage).
- Verified: `npm run build` (tsc clean), `npx vitest run` (117/117,
  including the 7 new direct tests), `npx biome check` (clean),
  `scripts/check_file_sizes.sh` (clean).
- **Tier 2 is now closed out** (basedpyright added, modules return typed
  models, tool args parsed with zod).
- **Next:** Tier 3 — mechanical, low-risk readability/consistency fixes:
  duplicate-named `venvPython` functions (`0003-findings-plugin-core.md`
  #3), dead `manifestAllows` code (`...plugin-core.md` #4), duplicated
  `_require_agent` across 5 API files (`0003-findings-service-api.md`
  #1), hardcoded version string in 6 places
  (`...service-api.md` #4), unnecessary `as ModuleContext` cast
  (`...plugin-core.md` #7), untyped `settings` param + stale
  `# type: ignore` in `llm.py` (`...service-core.md` #4 — now unblocked
  since basedpyright landed).
