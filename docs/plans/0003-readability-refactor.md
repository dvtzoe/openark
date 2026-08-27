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

Ordered roughly core-outward, since core types/contracts are what everything
else depends on (fixing a shared type once beats fixing five call sites
separately):

- [ ] **Plugin core** — `plugin/src/core/{types,config,service,loader,
      lifecycle,runtime,hooks,bootstrap,agent-template,installer,doctor}.ts`
- [ ] **Plugin modules** — `plugin/src/modules/{memory,personality,
      reflection,skills,index}.ts`, `plugin/src/index.ts`, `plugin/src/cli.ts`
- [ ] **Service core** — `service/openark/core/{config,models,registry,llm,
      prompts}.py`, `service/openark/app.py`
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

- (none yet — audit not started)

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
