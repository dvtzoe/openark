# ADR 0004 — Sharing via tagged channels

Date: 2026-08-25 · Status: accepted

## Context

Multiple agents per user; some memories/lessons should be shareable.
Options: a global commons pool, tagged channels, or full mesh (everything
shared).

## Decision

Tagged channels: an agent pushes an item into `channels/<name>/`; agents
subscribe to channels in their `agent.json`. Items carry source-agent
provenance. Private memory always takes precedence over channel memory in
recall and injection.

## Consequences

- Sharing is opt-in per item and per subscription — one polluted agent
  cannot poison everyone.
- Provenance enables distrust: a consumer can ignore items from a source.
- Slightly more UX than a commons pool; commands (`/channel`) keep it simple.
