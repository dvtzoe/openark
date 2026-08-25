# ADR 0001 — Dual stack: TypeScript plugin + Python service

Date: 2026-08-25 · Status: accepted

## Context

opencode plugins are TypeScript. The memory stack we chose (Mem0 OSS,
sentence-transformers embedders, future graph options) is Python-first.

## Decision

Two components with a hard contract between them:

- **Plugin (TS):** opencode hooks, module loading, injections, agent tools.
  Deliberately thin — no storage, no LLM calls.
- **Service (Python):** FastAPI on localhost owning all state and LLM work.

The only coupling is the **versioned `/v1` REST API** (OpenAPI schema →
generated TS types). CI asserts the contract surface (see
`service/tests/test_api.py::test_openapi_contract_stable`).

## Consequences

- Contributors can work on either side against the contract.
- A future pure-TS memory implementation only needs to serve `/v1`.
- Cost: two runtimes; the plugin must handle the service being down
  (degrade to no-op) and bootstrap the venv (`openark start`, phase 8).
