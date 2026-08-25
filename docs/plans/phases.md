# Build phases

Status legend: [x] done · [~] in progress · [ ] not started

## Phase 1 — Scaffold [x]

- [x] Repo layout, AGPL-3.0 license, CI (biome/vitest + ruff/pytest + size cap)
- [x] Plugin skeleton: config, service client, module loader, 4 module stubs
- [x] Service skeleton: FastAPI `/v1` (health, agents CRUD, persona read,
      stubbed module endpoints), agent registry, audit log
- [x] chiai persona template, command templates, docs + plans + ADRs
- [x] `make dev/test/lint`, `openark` CLI (list/create/rm/start/status)

## Phase 2 — Service core + memory [ ]

- [ ] Model routing client (inherit main/small or explicit endpoint) in service
- [ ] Mem0 embedded behind `modules/memory.py` (Chroma file store, local
      embedder default), wired to recall/add/ingest endpoints
- [ ] OpenAPI → generated TS types; plugin memory module goes live
- [ ] Extraction prompt pipeline (extraction.md) on session end

## Phase 3 — Plugin live wiring [ ]

- [ ] Real hook shapes verified against opencode runtime (system transform,
      tool.after, session end); fix defensive code in `src/index.ts`
- [ ] Agentic tools (`memory_search`, `memory_add`) registered via `tool:`
- [ ] Service lifecycle: plugin spawns/bootstraps venv on demand

## Phase 4 — Personality [ ]

- [ ] Persona serve/evolve endpoints; threshold-gated evolving layer
- [ ] Audit log with diffs on every evolving-persona change
- [ ] chiai default persona wired into agent creation

## Phase 5 — Reflection + lessons [ ]

- [ ] Failure capture (non-zero exits, reverted edits, user corrections)
- [ ] reflection.md pipeline → lessons.md (dedupe, hit counters, retirement)
- [ ] `/learn` command end-to-end

## Phase 6 — Skills [ ]

- [ ] Distillation (distillation.md) from successful multi-step traces
- [ ] Draft → verified lifecycle; per-agent skills dir registered via
      `skills.paths`

## Phase 7 — Channels [ ]

- [ ] Channel store with provenance, subscriptions, push/share tools
- [ ] Channel memory merged after private memory in recall

## Phase 8 — CLI + installer [ ]

- [ ] `openark install`: plugin entry in opencode.json, venv bootstrap,
      generated opencode agent files, `skills.paths` registration
- [ ] `openark create` seeds from bundled personas (incl. chiai)

## Phase 9 — Docs + community [ ]

- [ ] DESIGN.md/MODULE_SPEC.md finalized against implementation
- [ ] Good-first-issue labels, ROADMAP, user-facing docs
