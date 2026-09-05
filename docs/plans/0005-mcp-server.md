# Plan 0005 — MCP server surface for the openark service

Owner: jg.tabudda. Executor: chiai. Status: **DRAFT — open questions at the
bottom must be answered before execution.** ADR (0007) will record the
decisions; this doc tracks the *how* and the execution log.

## Goal

Expose openark agents to the broader MCP ecosystem: the service mounts an
MCP server alongside the `/v1` REST API (Streamable HTTP, MCP spec
`2026-07-28`), so any MCP client — Claude Desktop, other editors/agents —
can use an openark agent's memory, persona, lessons, and skills. openark
stops being opencode-only.

Non-goals (deliberate):

- **No MCP client in the plugin.** opencode already has native MCP client
  support (`mcp` in opencode.json, local + remote, per-agent tool gating).
  Building a client would duplicate the host.
- **No new cognitive module.** MCP is a *surface* onto existing modules
  (like channels is a plain store), not a `ServiceModule`. All tool handlers
  delegate to the same module functions the `/v1` routes use, so the audit
  log, dedupe, and degradation behavior are shared by construction.
- **No remote/multi-user mode.** Localhost-only, no auth (deferred to the
  "Multi-user / remote service mode" roadmap item; the `2026-07-28` spec's
  auth framework applies to HTTP, but a single-user local service defers it).

Why now: the `2026-07-28` spec (GA 2026-07-28) removed the session layer —
stateless, per-request `_meta`, Streamable HTTP only (HTTP+SSE deprecated).
A stateless local service is the ideal shape for this; no session management
needed. The spec's "Skills over MCP" extension also maps directly onto
openark's skills module.

## Design notes

- **Library:** FastMCP (Python `fastmcp`) — first-class FastAPI mounting:
  `mcp.http_app(path="/")` → ASGI sub-app; mount at `/mcp`; pass
  `mcp_app.lifespan` to FastAPI (combined with the service's own lifespan).
  Official `mcp` SDK's streamable_http_app has known mounting friction
  (python-sdk#1367); FastMCP documents the FastAPI mount as a supported path.
- **Agent selection:** TBD (open question Q3). Options: per-agent URL
  (`/mcp/{agent}`, one URL per client config) vs single endpoint with an
  explicit `agent` tool argument.
- **Graceful degradation:** `fastmcp` as an optional dependency group
  (`[project.optional-dependencies] mcp = ["fastmcp>=2"]`), mirroring the
  `memory` extra. When absent, `create_app()` builds exactly today's app and
  logs one line. The service must never fail to boot because of MCP.
- **File layout:** new `service/openark/mcp/` package (`server.py` +
  tool/resource registration; split further if any file nears the 999-line
  cap). No source file >999 lines, per ADR 0005.
- **Config:** nothing new in `openark.json` unless Q3's answer forces it.
  Per-agent exposure toggle in `agent.json` is a candidate (convention:
  per-agent toggles live in the manifest) — decided by Q2/Q3 answers.

## Checklist

Draft — re-ordered and finalized after the open questions are answered.

- [ ] Write ADR 0007 (direction: server-not-client; surface-not-module;
      localhost-no-auth; the Q2/Q3 answers)
- [ ] Add `mcp` optional dependency group to `service/pyproject.toml`;
      confirm and pin the exact `fastmcp` version
- [ ] `service/openark/mcp/`: MCP server + tool/resource handlers delegating
      to existing module functions (memory recall/add, channels, lessons,
      skills, persona as resources)
- [ ] `service/openark/app.py`: conditional mount at `/mcp` with combined
      lifespan; clean log line when `fastmcp` is absent
- [ ] Agent-scoping behavior per Q3 answer (path params, tool args, or both)
- [ ] Mutating tools behind the same audit paths as `/v1` (per Q2 answer)
- [ ] Tests (pytest, httpx ASGI transport): tools/list, memory tool call,
      agent scoping, degradation when `fastmcp` not installed
- [ ] Docs: ARCHITECTURE.md diagram line, MODULE_SPEC.md "current surfaces"
      note, README quick-start snippet (pointing an MCP client at the URL)
- [ ] Plugin DX (per Q7): `openark doctor` MCP endpoint check; `openark
      install` prints per-agent MCP URLs
- [ ] ROADMAP.md tick if any roadmap item is affected
- [ ] Verify: `make lint/test` green (service + plugin), `uvicorn` smoke run
      with a real MCP client list-tools call, `check_file_sizes.sh`
- [ ] Commit in logical chunks, tests green before each commit

## Open questions (owner)

- **Q1 — Direction.** MCP *server* on the service only; no MCP client work
  in the plugin (opencode covers the client side natively). Correct?
- **Q2 — Read-only vs read-write.** May external MCP clients *mutate* agent
  state (memory add, channel push, lesson retire — all audited), or start
  read-only with writes reserved for opencode?
- **Q3 — Agent selection.** Per-agent URLs (`/mcp/{agent}`; needs a lazy
  per-agent dispatcher or restart-on-create) vs one endpoint whose tools
  take an explicit `agent` argument?
- **Q4 — Dependency.** `fastmcp` as an optional `[mcp]` extra with graceful
  no-op (recommended), or a hard core dependency?
- **Q5 — Skills over MCP.** Adopt the `2026-07-28` "Skills over MCP"
  extension now, or expose skills as plain MCP resources first and adopt the
  extension later?
- **Q6 — Auth.** Localhost, no auth, token auth deferred to the remote-mode
  roadmap item — OK?
- **Q7 — Plugin DX scope.** Include the `doctor` check + `install` URL
  printing in this plan, or keep the plan service-only?

## Log

Newest entry last.

### 2026-08-29 — Drafted

- Researched MCP spec `2026-07-28` (stateless core, Streamable HTTP, MRTR,
  extensions incl. Skills over MCP; HTTP+SSE deprecated), FastMCP↔FastAPI
  mounting patterns, and opencode's native MCP client config.
- Read the codebase: `service/openark/app.py` (no lifespan today — MCP mount
  introduces one), `api/v1/*` route surface, module wiring, plan/ADR
  conventions.
- Wrote this draft with open questions; awaiting owner answers before ADR
  0007 and execution.
