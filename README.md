# openark

[![CI](https://img.shields.io/badge/CI-github--actions-2088ff?logo=githubactions)](./.github/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](./LICENSE)

> [!WARNING]
> VIBE-CODED PROJECT
> I wanted it to be a small thing for personal use but it ate 15$
> so I might share it as well.

Modular agents for [opencode](https://opencode.ai) with persistent memory,
personality, and self-learning from mistakes.

**defoko** — the mascot and default agent — remembers you across sessions, keeps
a stable personality, learns lessons from failures, and distills reusable
skills. You can run many agents side by side, each with its own persona,
memory, and home directory, and share selected memories between them.

> **Status: pre-alpha.** All nine build phases are in: memory, personality,
> reflection, skills, channels, and the installer work end-to-end against a
> live opencode. Expect rough edges and prompt iteration. See
> [docs/plans/phases.md](docs/plans/phases.md) and [ROADMAP.md](ROADMAP.md).

## Why openark?

Plain LLM sessions are stateless scripts: they forget every conversation,
repeat mistakes, and start from zero every time. openark adds four independent
modules on top of opencode:

| Module          | What it gives the agent                                              |
| --------------- | -------------------------------------------------------------------- |
| **memory**      | Persistent recall of facts and past sessions (Mem0-backed)           |
| **personality** | A stable core persona plus a slowly evolving preferences layer       |
| **reflection**  | Lessons learned from failures and user corrections (Reflexion-style) |
| **skills**      | Distilled, reusable procedures that materialize as opencode skills   |

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

Or install end-to-end (plugin + agent files + service venv):

```sh
node plugin/dist/cli.js create defoko --persona defoko
node plugin/dist/cli.js install
node plugin/dist/cli.js start
```

## Usage

All commands go through the `openark` CLI (`node plugin/dist/cli.js` from a
dev checkout). Run it with no arguments to see the built-in help.

### Setup

```sh
openark create defoko --persona defoko   # agent home seeded from the bundled persona
openark install                        # wire everything into opencode
openark start                          # run the service on 127.0.0.1:8765
```

`openark install` writes the plugin shim to
`~/.config/opencode/plugins/openark.js`, generates one opencode agent file per
openark agent, symlinks verified skills into `~/.config/opencode/skills/`,
copies the slash commands, and bootstraps the service venv under `~/.openark/`.
Restart opencode afterwards to load the plugin.

### Day to day

Switch agents with opencode's native agent switcher — each one injects its own
persona, memories, and lessons at session start. The slash commands:

| Command    | What it does                                                        |
| ---------- | ------------------------------------------------------------------- |
| `/memory`  | search or add to the agent's long-term memory                       |
| `/persona` | show the core persona, or turn feedback into learned preferences    |
| `/learn`   | reflect on the session and store lessons from failures              |
| `/skills`  | list learned skills, or distill a new one from a successful workflow |
| `/channel` | share a memory or lesson with other agents                          |

### Managing agents

```sh
openark list              # list agents and their descriptions
openark create <name>     # blank agent home (edit persona.core.md yourself)
openark rm <name> --yes   # delete an agent home (irreversible)
openark status            # service: up / down (with pid)
openark start             # run the service detached (pid in ~/.openark/service.pid)
openark stop              # stop the service
openark restart           # stop + start (see restart policy below)
openark doctor            # check the setup for problems
openark doctor --fix      # ... and repair what it can (shim, agent files,
                          #     skills, commands, service venv)
```

### Restart policy

No restart — the next session picks it up: `agent.json` module toggles,
`persona.core.md` (and `.d/` drop-ins), `persona.evolving.md` (and `.d/`),
`lessons.md`, `skills/`.

Restart the service (`openark restart`): `~/.openark/openark.json`
(port / per-task model routing), service `prompts/`, service code.

Restart opencode itself (plus `openark install`): plugin code changes.
Plugin logs live in `~/.openark/logs/plugin.log` (never stdio, so the
opencode TUI stays clean); set `OPENARK_DEBUG=1` to also mirror to stderr.

Agent state lives in `~/.openark/agents/<name>/` as plain files:
`agent.json` (manifest), `persona.core.md` (you own this, the agent never
rewrites it), `persona.evolving.md`, `lessons.md`, `skills/`, and
`logs/audit.log` (every agent-authored change, with diffs). Delete the
directory and the agent is gone.

Both persona files support drop-in directories: any `.md` descendants of
`persona.core.md.d/` and `persona.evolving.md.d/` are appended after the
main file (lexicographic order, each marked with a `<!-- from: ... -->`
comment). Core drop-ins are yours — the agent never writes there; evolving
drop-ins are agent-writable, so preferences the agent evolves survive in
whichever fragment they live in.

### Configuration

Toggle modules per agent in `agent.json` — missing entries mean disabled, and
toggles apply at the next session start:

```json
{ "modules": { "memory": true, "personality": true, "reflection": false, "skills": true } }
```

The service port and per-task model routing live in `~/.openark/openark.json`.
By default background tasks (`extraction`, `reflection`, `distillation`,
`persona_update`, `embeddings`) inherit the `small_model` configured in
opencode; override any of them per task:

```json
{
  "servicePort": 8765,
  "models": {
    "extraction": { "provider": "openai", "model": "gpt-4o-mini" }
  }
}
```

Useful environment variables: `OPENARK_HOME` (state root, default
`~/.openark`), `OPENCODE_CONFIG_DIR` (default `~/.config/opencode`),
`OPENARK_SERVICE_DIR` (service checkout for dev installs), and
`OPENARK_SERVICE_URL` (override the service endpoint).

## Layout

```
plugin/    TypeScript opencode plugin (orchestrator + modules) — npm: openark
           personas/ and commands/ ship inside the npm package
service/   Python FastAPI service (memory, persona, lessons, skills) — PyPI: openark-service
docs/      Design docs, module spec, ADRs, and plans
```

Runtime state lives under `~/.openark/` — one directory per agent, plain
inspectable files, delete an agent by deleting its directory. `openark
install` wires everything into opencode (plugin, agent files, skills,
commands).

## Documentation

- [Architecture overview](ARCHITECTURE.md) — how the pieces fit together
- [Module spec](docs/MODULE_SPEC.md) — how to write and register a module
- [Design docs](docs/DESIGN.md) — per-module design (memory, personality, ...)
- [Contributing](CONTRIBUTING.md) — dev setup, code style, PR checklist
- [ADRs](docs/adr/) — why things are the way they are

## Contributing

Issues and PRs are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first —
the two hard rules are _every module ships tests_ and _no source file may
exceed 999 lines_ (`make lint-sizes` enforces it).

## License

Copyright (C) 2026 openark contributors.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [LICENSE](LICENSE) for details.
