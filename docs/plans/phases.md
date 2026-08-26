# Build phases

Status legend: [x] done · [~] in progress · [ ] not started

## Phase 1 — Scaffold [x]

- [x] Repo layout, AGPL-3.0 license, CI (biome/vitest + ruff/pytest + size cap)
- [x] Plugin skeleton: config, service client, module loader, 4 module stubs
- [x] Service skeleton: FastAPI `/v1` (health, agents CRUD, persona read,
      stubbed module endpoints), agent registry, audit log
- [x] chiai persona template, command templates, docs + plans + ADRs
- [x] `make dev/test/lint`, `openark` CLI (list/create/rm/start/status)

## Phase 2 — Service core + memory [x]

- [x] Model routing client (inherit main/small or explicit endpoint) in service
- [x] Mem0 embedded behind `modules/memory.py` (Chroma file store, local
      embedder default), wired to recall/add/ingest endpoints
- [x] OpenAPI → generated TS types; plugin memory module goes live
- [x] Extraction prompt pipeline (extraction.md) on session end

## Phase 3 — Plugin live wiring [x]

- [x] Real hook shapes verified against opencode runtime (system transform,
      tool.after, session end); fix defensive code in `src/index.ts`
- [x] Agentic tools (`memory_search`, `memory_add`) registered via `tool:`
- [x] Service lifecycle: plugin spawns/bootstraps venv on demand

## Phase 4 — Personality [x]

- [x] Persona serve/evolve endpoints; threshold-gated evolving layer
- [x] Audit log with diffs on every evolving-persona change
- [x] chiai default persona wired into agent creation

## Phase 5 — Reflection + lessons [x]

- [x] Failure capture (tool errors incl. failed edits/tests, user corrections
      following failures; VCS-aware reverted-edit detection is future work)
- [x] reflection.md pipeline → lessons.md (dedupe, hit counters, retirement)
- [x] `/learn` command end-to-end (reflect / lessons_list / lessons_retire tools)

## Phase 6 — Skills [x]

- [x] Distillation (distillation.md) from successful multi-step traces
- [x] Draft → verified lifecycle; verified skills symlinked into
      `~/.config/opencode/skills/` (no `skills.paths` config exists in
      opencode — native discovery is directory-based)

## Phase 7 — Channels [x]

- [x] Channel store with provenance, subscriptions, push/share tools
- [x] Channel memory merged after private memory in recall

## Phase 8 — CLI + installer [x]

- [x] `openark install`: plugin shim in opencode's plugins dir, venv bootstrap
      (~/.openark/venv), generated opencode agent files, verified skills
      symlinked into ~/.config/opencode/skills, command templates copied
- [x] `openark create` seeds from bundled personas (incl. chiai)

## Phase 9 — Docs + community [x]

- [x] DESIGN.md/MODULE_SPEC.md finalized against implementation
- [x] ROADMAP.md; good-first-issue labels listed for maintainers to apply
- [x] User-facing quick start in README (create → install → start)
