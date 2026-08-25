# openark architecture

How the pieces fit together. For per-module design see
[docs/DESIGN.md](docs/DESIGN.md); for the module contract see
[docs/MODULE_SPEC.md](docs/MODULE_SPEC.md).

```
┌───────────────────────────── opencode ─────────────────────────────┐
│  generated agent files (~/.config/opencode/agent/<name>.md)        │
│                    │ native Tab switcher picks the agent            │
│                    ▼                                               │
│  openark plugin (TypeScript, thin)                                 │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │ core: config · service client · module loader · lifecycle │     │
│  │ modules: memory · personality · reflection · skills       │     │
│  └──────────────┬────────────────────────────────────────────┘     │
└─────────────────│──────────────────────────────────────────────────┘
                  │  versioned REST API (/v1) — the only contract
                  ▼
┌────────────── openark service (Python, FastAPI) ──────────────────┐
│  api/v1: health · agents · memory · persona · lessons · skills     │
│  core: agent registry · config · model routing (per task)          │
│  modules: storage + LLM calls (Mem0, Chroma embedded, prompts)     │
└──────────────┬────────────────────────────────────────────────────┘
               ▼
~/.openark/                    all runtime state, plain files
├── openark.json               port + per-task model routing
├── venv/                      service virtualenv (auto-bootstrapped)
├── agents/<name>/             one home per agent
│   ├── agent.json             manifest: module toggles, channel subs
│   ├── persona.core.md        user-authored, never auto-rewritten
│   ├── persona.evolving.md    agent-managed preferences (audited)
│   ├── lessons.md             learned rules w/ provenance + counters
│   ├── skills/                distilled procedures (SKILL.md)
│   ├── data/                  memory store (Mem0/Chroma)
│   └── logs/audit.log         every persona/lesson/skill change
└── channels/<name>/           shared memories with source provenance
```

## Data flow

1. **Session start** — plugin resolves the active agent from the opencode
   session, fetches its manifest, and loads only the enabled modules.
   If all modules are off (or the service is down) the plugin is a no-op.
2. **User message** — enabled modules contribute injection blocks
   (persona, recalled memories, active lessons) via
   `experimental.chat.system.transform`, token-budgeted.
3. **Tool results** — `tool.execute.after` feeds failures (non-zero exits,
   reverted edits) to the reflection module's trigger queue.
4. **Background work** — extraction, reflection, and distillation run in the
   service using per-task model routing from `openark.json`.
5. **Session end** — queued work flushes: memories consolidate, lessons
   dedupe/update, verified skills materialize as opencode skills.

## Principles

- **Modules are the unit.** Each module is independently toggleable per agent
  in `agent.json`, degrades gracefully, and must be useful alone.
- **Thin plugin, smart service.** The plugin only orchestrates hooks and
  injections; storage and LLM calls live behind the `/v1` API.
- **Plain files first.** State is human-readable markdown/JSON wherever
  possible; delete an agent by deleting its directory.
- **Audit everything.** Any agent-authored change to its own state (persona,
  lessons, skills, shared channels) is appended to `logs/audit.log` with a
  diff.
- **Local by default.** Everything runs on localhost; no telemetry; the
  default embedder runs locally.

## Multi-agent model

- Any number of agents, each with its own home, persona, memory, lessons, and
  skills (`openark create <name>`).
- One opencode agent file per openark agent, generated and managed by the
  CLI (`openark install`).
- **Channels** are the sharing mechanism: an agent tags a memory or lesson
  into a channel; other agents subscribe to channels they trust. Every item
  carries source-agent provenance, and private memory always takes precedence
  over channel memory.

## Versioning

- The REST API is versioned (`/v1`); breaking changes require a new version
  and an ADR.
- Plugin and service versions are released together while pre-1.0.
