# ADR 0003 — Single-root runtime state at ~/.openark

Date: 2026-08-25 · Status: accepted

## Context

XDG would split an agent across `~/.config` (persona/manifests),
`~/.local/share` (memory stores), and `~/.local/state` (audit logs). An
alternative was one portable directory per agent.

## Decision

Everything lives under one root: `~/.openark/` (override with
`OPENARK_HOME`). Agents in `agents/<name>/`, shared channels in
`channels/<name>/`, global config in `openark.json`.

## Consequences

- Deleting or copying an agent is a single `rm -rf` / `cp -r`.
- Backup = copy one directory; inspection = read plain files.
- Not XDG-pure (config mixed with data) — accepted by owner for portability.
- `OPENARK_HOME` keeps tests hermetic and supports non-default installs.
