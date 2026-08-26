# Plan 0002 — OSS pivot: openark, multi-agent

Date: 2026-08-25 · Status: decided (current)

## Changes from 0001

The project becomes an OSS project named **openark**. `defoko` is demoted to
mascot/default persona. Multiple agents per user, each with its own
personality, memory, and home directory; memories/lessons shareable between
agents.

## Decisions (Q&A with owner)

| Question | Decision |
| --- | --- |
| Runtime state layout | Single root `~/.openark/` (owner declined XDG split) |
| Shared memory | Tagged channels: items pushed into `#channel`s; agents subscribe; items carry source-agent provenance; private memory takes precedence |
| Agent switching in opencode | One generated opencode agent file per openark agent; switch with opencode's native agent switcher |
| Stack | Keep TS plugin + Python service; versioned `/v1` REST contract between them |
| License | AGPL-3.0-or-later |
| Repo location | `~/me/projects/openark` |

## Consequences

- Contributor-facing contracts become first-class: `docs/MODULE_SPEC.md`,
  `docs/PROMPTS.md`, OpenAPI-generated TS types, `make create-module`.
- Runtime layout (single root):

```
~/.openark/
├── openark.json            port + per-task model routing
├── venv/                   service virtualenv (bootstrapped)
├── agents/<name>/          persona.core.md · persona.evolving.md · lessons.md
│                           skills/ · data/ · logs/audit.log · agent.json
└── channels/<name>/        shared items with source provenance
```

- Agent manifests (`agent.json`) carry per-agent module toggles.
- ADRs added for: dual stack, AGPL, single-root state, channels, file-size cap.
