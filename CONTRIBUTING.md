# Contributing to openark

Thanks for helping build openark! This document covers everything you need to
contribute code, docs, or modules.

## Ground rules

1. **Every module ships tests.** A PR touching `plugin/src/modules/` or
   `service/openark/modules/` without tests will not be merged.
2. **Files stay small.** A few hundred lines is the target; **999 lines is the
   hard cap** for *any* authored file (code, docs, config). `make lint-sizes`
   enforces this in CI. Split files instead of growing them.
3. **Conventional commits.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
   `chore:`, `feat(persona):`, etc.
4. **Architecture changes need an ADR.** Changing a decision recorded in
   `docs/adr/` requires a new ADR, not a silent edit.
5. **By contributing, you agree your work is licensed under AGPL-3.0-or-later.**

## Development setup

Requirements: [Bun](https://bun.sh) >= 1.4, Python >= 3.11,
[uv](https://docs.astral.sh/uv/) (or plain `python -m venv`).

```sh
git clone <repo-url> && cd openark
make dev        # bun install in plugin/, uv venv + install in service/
```

Day-to-day:

```sh
make test       # vitest + pytest (run this before every PR)
make lint       # biome + ruff + file-size check
make fmt        # biome format + ruff format (auto-fix)
```

### Running pieces locally

```sh
make service-run            # FastAPI on 127.0.0.1:8765
make plugin-build           # compile plugin to dist/
bun plugin/dist/cli.js      # the `openark` CLI
```

## Repo tour

| Path | What lives there |
| --- | --- |
| `plugin/src/core/` | Plugin runtime: config, service client, module loader |
| `plugin/src/modules/` | TS halves of the four modules (injection, hooks) |
| `service/openark/api/v1/` | Versioned REST API — the only plugin/service contract |
| `service/openark/core/` | Agent registry, config, model routing |
| `service/openark/modules/` | Python halves of the modules (storage, LLM calls) |
| `service/openark/prompts/` | All LLM prompts, as editable files |
| `personas/` (in `plugin/`) | Bundled agent templates (defoko is the default), shipped in the npm package |

## Writing a module

Modules are the unit of contribution. Read
[docs/MODULE_SPEC.md](docs/MODULE_SPEC.md) for the full contract; the short
version:

- Implement the `OpenArkModule` interface (`plugin/src/core/types.ts`)
- Register it in `plugin/src/modules/index.ts`
- Add per-agent toggles via the manifest (`agent.json`)
- Heavy lifting (storage, LLM calls) goes in the service, behind a `/v1`
  endpoint — the plugin stays thin
- Prompts belong in `service/openark/prompts/`, never inline in code

Scaffold a new module:

```sh
make create-module name=my-module
```

## Adding prompts

All prompts are versioned files in `service/openark/prompts/`. See
[docs/PROMPTS.md](docs/PROMPTS.md). Prompt-only changes are first-class PRs.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Fill in the PR template (linked issue, summary, tests, checklist).
- New endpoints must update the OpenAPI contract and generated TS types.
- Docs changes for user-facing behavior are part of the code PR.

## Reporting bugs

Use the issue templates. For agent behavior bugs, include the relevant
`~/.openark/agents/<name>/logs/audit.log` excerpt (redact anything private).

## Code style

- TS: [biome](https://biomejs.dev) — no Prettier/ESLint, don't add them.
- Python: [ruff](https://docs.astral.sh/ruff/) — lint + format.
- Type everything you can in TS; Python uses type hints throughout.
- No comments unless they explain a *why* that code cannot.
