# Plan 0001 — Research and initial design

Date: 2026-08-25 · Status: decided (superseded in part by 0002)

## Goal

A modular agent system for opencode with persistent memory, personality, and
self-learning from mistakes — every module independently toggleable.

## Research summary

### Persistent memory

| Method | Approach | Pros | Cons |
| --- | --- | --- | --- |
| Mem0 (OSS) | LLM fact extraction → vector store; LLM judge resolves contradictions | Bolt-on, light SDKs, ~90% fewer tokens than raw-history RAG, self-hostable | No temporal reasoning, double-writes under bursty updates, extraction costs LLM calls |
| Letta (MemGPT) | OS-style tiered memory; agent edits its own memory blocks | Highest LongMemEval (83.2%), self-editing memory, persona blocks | Wants to *be* the agent runtime — conflicts with opencode; lock-in |
| Zep / Graphiti | Temporal knowledge graph, facts have validity windows | Best temporal correctness, native contradiction handling | Needs Neo4j; heaviest option |
| SQLite + embeddings (DIY) | File store + hybrid retrieval injected into context | Zero deps, fully inspectable | We write retrieval + consolidation ourselves |

### Self-learning

| Method | Approach | Pros | Cons |
| --- | --- | --- | --- |
| Reflexion (NeurIPS 2023) | Actor → evaluator → verbal critique stored in memory | Proven (HumanEval 91%), interpretable, no training | 10–30× cost; stores wrong lessons without a reliable failure signal |
| ExpeL (AAAI 2024) | Batch success/failure trajectories → distilled insight rules | Cross-task transfer, compact | Designed for offline training sets |
| Voyager skill library (TMLR 2024) | Verified executable skills stored + indexed by description | 15.3× speedup; "verified before stored" | Embodied origin; needs verification step |
| Agent Workflow Memory (2024) | Reusable workflows extracted from traces | Procedural memory that generalizes | Research code only |
| Prompt self-editing (Madaan 2022) | Model proposes edits to its own prompt rules from feedback | Direct precedent for a lessons file | Pattern only, no library |

### Personality

| Method | Pros | Cons |
| --- | --- | --- |
| Static persona file | Simple, stable | Drifts, never adapts |
| Letta persona blocks | Agent-curated | Locked to Letta runtime |
| Big Five conditioning | Measurable | Academic, overkill |
| Two-timescale evolution (StableMind pattern) | Fast preferences + slow threshold-gated traits | No maintained implementation — we implement the pattern |

## What did not exist (and must be written)

1. The opencode orchestrator plugin with runtime module toggles.
2. The Reflexion/ExpeL pipeline as reusable code.
3. Skill distillation into opencode skills (Voyager pattern → SKILL.md).
4. Lessons lifecycle (dedupe, hit counters, retirement, audit).

## Decisions (Q&A with owner)

- Runtime: TS plugin + local Python service.
- Memory backend: Mem0 OSS embedded.
- Personality: layered — static core (user-authored) + threshold-gated evolving layer.
- Learning trigger: hybrid (auto on strong failure signals + `/learn`).
- Scope: global state with per-project tagging.
- Background models: per-task routing ("depends on the task").
