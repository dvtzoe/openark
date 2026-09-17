# ADR 0007 — Port the plugin to the OpenCode V2 plugin API

Date: 2026-09-17 · Status: accepted

## Context

OpenCode 2.x replaced its plugin API. A V1 plugin was an async function that
returned one object with every hook and tool. A V2 plugin default-exports a
definition with an `id` and a `setup(ctx)` that registers hooks, tools, and
subscriptions through the context. The V2 loader rejects V1 implementations
outright (`PluginModule.LoadError: Plugin must export a default definition
with an id and an effect or setup function`).

The owner runs OpenCode 2.0.3. After the upgrade, every session logged
`failed to load plugin` for the openark shim in
`~/.local/share/opencode/log/opencode.log`, and the plugin became a silent
no-op: no persona/memory injection, no memory tools, no reflection hooks, no
service auto-start. `openark doctor` reported no problem because it does not
compare the plugin API version against the installed opencode.

The package has never been published, so there is no installed base that
needs V1 support, and V1 implementations do not run in V2 in any case.

## Decision

- `plugin/src/index.ts` default-exports `{ id: "openark", setup }`, typed
  against `@opencode/plugin` (`Plugin.Plugin`). `@opencode-ai/plugin` is
  dropped. `@opencode/plugin` stays a dev dependency: the runtime never
  imports it (only types; `Plugin.define` is identity, the plain object is
  accepted directly).
- Hooks move to their V2 domains in `plugin/src/core/hooks.ts`:
  - `chat.message` → `ctx.session.hook("prompt", ...)`, plus one
    `ctx.session.get` for the session's agent/model (the V2 prompt event
    carries neither).
  - `experimental.chat.system.transform` → `ctx.session.hook("context", ...)`
    pushing a `{ type: "text", text }` system part.
  - `event` for tool failures → `ctx.tool.hook("execute.before"/"execute.after")`.
    V2 has no `message.part.updated` event; the before hook also supplies the
    duration openark reports to reflection.
  - `event` for session lifecycle → `ctx.event.subscribe()`. V2 events carry
    their payload under `data`, not `properties`.
  - `dispose` → the cleanup function returned from `setup`.
- Module tools register through `ctx.tool.transform(...)` with their zod
  argument shape (zod implements Standard Schema, which opencode accepts) and
  return `{ content }`.
- The installer shim becomes `export { default } from <dist>`; the V1 named
  `plugin` export is gone.
- OpenCode 1.x is no longer supported.

## Consequences

- The plugin loads on OpenCode 2.x; verified live on 2.0.3 (plugin id in
  `opencode plugin list`, tools in the model catalog, injection logged,
  service auto-spawn, session flush on idle).
- Every openark extension point must exist in the V2 API. The V2 API covers
  all of V1's used surface, so nothing was dropped, but there is no fallback
  for future V1-only hooks.
- The published package's compatibility statement is now "OpenCode 2.x".
- `openark doctor` still cannot see a plugin/API mismatch; the only signal is
  a WARN in opencode's log. A doctor check (plugin id present, compat
  warning) is possible follow-up work.
