# Module specification

The `OpenArkModule` contract (defined in `plugin/src/core/types.ts`).

## TypeScript interface

```ts
type OpenArkModule = {
  name: string
  description: string
  init?(ctx: ModuleContext): Promise<void>
  onUserMessage?(ctx, message): Promise<void>
  onToolResult?(ctx, result): Promise<void>
  onSessionEnd?(ctx): Promise<void>
  injections?(ctx): Promise<InjectionBlock[]>
  tools?(ctx): ModuleTool[]
}
```

- `init` may throw to disable the module (e.g. service unreachable). A
  disabled module logs a warning and is skipped — it must never break the
  session.
- `injections` returns blocks with a `priority` (higher = earlier in the
  system prompt). The collected text is capped by a global character budget;
  low-priority blocks are truncated or dropped first.
- `tools` returns callable tools exposed to the agent as native opencode
  tools; `execute(args, context)` receives the tool's project `directory`.
- `ctx.session` carries the current opencode session id (set by the runtime
  before injections) — use it for once-per-session work.

## Registration & toggles

1. Export the module from `plugin/src/modules/index.ts`.
2. Modules are enabled **per agent** in that agent's `agent.json`:

```json
{ "modules": { "memory": true, "reflection": false } }
```

Missing entries mean disabled. Toggle at any time; the plugin reads the
manifest at session start.

## Service-side halves

Storage and LLM work live in the service:

- Implement the `ServiceModule` protocol (`service/openark/modules/base.py`).
- Expose functionality through `/v1` endpoints only — the plugin never touches
  the filesystem or an LLM directly.
- Prompts are files in `service/openark/prompts/` (see [PROMPTS.md](PROMPTS.md)).
- LLM calls route through per-task model routing (`openark.json`) via the
  shared `TaskRunner` (`core/llm.py`): check `runner.available(task)` before
  promising LLM-backed behavior and degrade with a `reason` when absent.
- Modules never import each other; cross-module composition (e.g. merging
  channel memory into recall) happens in the API layer.

## Rules for module authors

- A module must be useful alone; no module may import another module.
- Failures degrade to "no-op", never to "broken session".
- Everything the module writes to agent state goes through the audit log.
- Ship tests for both halves (vitest + pytest). `make create-module name=foo`
  scaffolds the TS half with a test.

## Current modules

| Module | TS | Service |
| --- | --- | --- |
| memory | `plugin/src/modules/memory.ts` | `service/openark/modules/memory.py` + `api/v1/memory.py` |
| personality | `plugin/src/modules/personality.ts` | `.../persona.py` |
| reflection | `plugin/src/modules/reflection.ts` | `.../lessons.py` |
| skills | `plugin/src/modules/skills.ts` | `.../skills.py` |
| (channels) | tools on the memory module | `.../channels.py` (a plain store, not a cognitive module) |
