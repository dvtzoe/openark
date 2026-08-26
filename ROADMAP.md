# Roadmap

Status legend: [x] done · [~] in progress · [ ] not started

## Now (post-scaffold)

- [ ] Polish: VCS-aware reverted-edit detection for the reflection trigger
- [ ] Prompt iteration on real conversations (bump `version` per change)
- [ ] Publish `openark` (npm) and `openark-service` (PyPI)
- [ ] GitHub labels: `good-first-issue`, `area/plugin`, `area/service`, `area/docs`

## Next

- [ ] Idle-time memory consolidation (dedupe/merge across sessions)
- [ ] Channel curation tools (ignore by source agent, per-channel trust)
- [ ] Per-agent model route overrides (not just global `openark.json`)
- [ ] Lesson conflict resolution when channel lessons land

## Later

- [ ] Alternative vector stores behind `/v1` (pgvector, qdrant)
- [ ] Skill compositional verification (test that referenced skills exist)
- [ ] Multi-user / remote service mode
