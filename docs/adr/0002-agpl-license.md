# ADR 0002 — AGPL-3.0-or-later

Date: 2026-08-25 · Status: accepted

## Context

openark is an OSS project (owner's decision). Candidate licenses: MIT,
Apache-2.0, AGPL-3.0.

## Decision

AGPL-3.0-or-later, chosen by the project owner.

## Consequences

- Anyone offering openark as a network service must share their modifications
  — aligned with the project's "agents you fully own" ethos.
- Some companies' policies exclude AGPL dependencies; individual users
  running openark locally are unaffected.
- Dependencies (FastAPI, Mem0, Chroma) are Apache/BSD-licensed and compatible.
- Contributors agree their work is licensed AGPL-3.0-or-later
  (stated in CONTRIBUTING.md and the PR template).
