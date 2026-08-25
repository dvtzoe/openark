# ADR 0005 — 999-line hard cap on authored files

Date: 2026-08-25 · Status: accepted

## Context

The owner requires files of "a few hundred lines, never over 1000" —
including docs, excluding generated files (LICENSE is canonical text and
exempt too).

## Decision

- Hard cap: **999 lines** for every authored file.
- Target: a few hundred lines.
- Enforced by `scripts/check_file_sizes.sh` (`make lint:sizes`) in CI;
  `package-lock.json` and build output are exempt.

## Consequences

- Files stay reviewable; big features must decompose into modules or files —
  which suits the modular architecture.
- Docs stay readable; long docs split into per-topic files (see docs/plans/).
- Refactoring a growing file is a normal PR, not exceptional.
