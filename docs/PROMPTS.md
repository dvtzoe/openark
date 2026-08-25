# Prompts

All LLM prompts live as versioned files in `service/openark/prompts/`.
Prompt changes are first-class PRs — iterate on behavior without touching
code.

## Format

Markdown with YAML-ish frontmatter:

```
---
name: reflection
version: 1
task: reflection
---
<body with {placeholders}>
```

- `name` matches the filename.
- `version` bumps on any behavioral change.
- `task` selects the model route from `openark.json`
  (`extraction`, `reflection`, `distillation`, `persona_update`, `embeddings`).
- Placeholders use `{name}` and are filled by the service at call time.

## Shipped prompts

| File | Purpose |
| --- | --- |
| `extraction.md` | Conversation → durable facts (memory write path) |
| `reflection.md` | Failures → concrete, generalizable lesson rules |
| `distillation.md` | Successful trace → reusable skill |
| `persona_update.md` | Signals → threshold-gated preference updates |

## Review guidelines

A good prompt change PR:

- states which behavior it changes and why,
- includes a before/after example for a realistic input,
- bumps `version`,
- touches nothing else (code changes belong in separate PRs).
