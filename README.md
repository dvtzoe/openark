# openark

[![CI](https://img.shields.io/badge/CI-github--actions-2088ff?logo=githubactions)](./.github/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](./LICENSE)

Modular agents for [opencode](https://opencode.ai) with persistent memory,
personality, and self-learning from mistakes.

**chiai** — the mascot and default agent — remembers you across sessions, keeps
a stable personality, learns lessons from failures, and distills reusable
skills. You can run many agents side by side, each with its own persona,
memory, and home directory, and share selected memories between them.

> **Status: pre-alpha (Phase 1 scaffold).** The architecture is in place and the
> service builds/runs, but the memory/personality/learning modules are still
> being filled in. See [docs/plans/phases.md](docs/plans/phases.md).

## Why openark?

Plain LLM sessions are stateless scripts: they forget every conversation,
repeat mistakes, and start from zero every time. openark adds four independent
modules on top of opencode:

| Module | What it gives the agent |
| --- | --- |
| **memory** | Persistent recall of facts and past sessions (Mem0-backed) |
| **personality** | A stable core persona plus a slowly evolving preferences layer |
| **reflection** | Lessons learned from failures and user corrections (Reflexion-style) |
| **skills** | Distilled, reusable procedures that materialize as opencode skills |

Every module can be toggled per agent at any time. Disable all of them and
openark becomes a no-op — zero hooks, zero background calls.

## Quick start (development)

```sh
git clone <repo-url> && cd openark
make dev          # installs plugin deps + service venv
make test         # runs vitest + pytest
make lint         # biome + ruff + file-size check
```

Run the service locally:

```sh
make service-run  # starts the openark API on 127.0.0.1:8765
```

## Layout

```
plugin/    TypeScript opencode plugin (orchestrator + modules) — npm: openark
service/   Python FastAPI service (memory, persona, lessons, skills) — PyPI: openark-service
personas/  Bundled agent templates; chiai is the default
commands/  opencode command templates (/learn /memory /persona /channel /skills)
docs/      Design docs, module spec, ADRs, and plans
```

Runtime state lives under `~/.openark/` — one directory per agent, plain
inspectable files, delete an agent by deleting its directory.

## Documentation

- [Architecture overview](ARCHITECTURE.md) — how the pieces fit together
- [Module spec](docs/MODULE_SPEC.md) — how to write and register a module
- [Design docs](docs/DESIGN.md) — per-module design (memory, personality, ...)
- [Contributing](CONTRIBUTING.md) — dev setup, code style, PR checklist
- [ADRs](docs/adr/) — why things are the way they are

## Contributing

Issues and PRs are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first —
the two hard rules are *every module ships tests* and *no source file may
exceed 999 lines* (`make lint:sizes` enforces it).

## License

Copyright (C) 2026 openark contributors.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [LICENSE](LICENSE) for details.
