# Findings — plugin modules (`plugin/src/modules/`)

Part of [0003-readability-refactor.md](0003-readability-refactor.md). Audit
only — no code changed yet.

## 1. Module-scope buffers are shared across *all* agents/sessions in the process (correctness bug, not just style)

**Files:** `plugin/src/modules/memory.ts` (`transcript`),
`plugin/src/modules/reflection.ts` (`buffers`)

Both declare their working buffer at **module scope** (`const transcript:
string[] = []`; `const buffers: Buffers = { failures: [], messages: [],
countedSessions: new Set() }`). A JS/TS module is a singleton — there is
exactly one `transcript` array and one `buffers` object for the life of the
opencode plugin process, no matter how many agents or sessions it serves.

This directly contradicts the documented architecture:
`ARCHITECTURE.md`/`docs/DESIGN.md` describe **per-agent private memory**
("private memory always takes precedence over channel memory") and the
runtime (`core/runtime.ts`) explicitly supports multiple concurrent
agents/sessions — `switchAgent` exists precisely because a session's active
agent can change, and `current` (the runtime's notion of "whichever agent
was touched most recently") is a single mutable slot shared by every hook
call.

Concretely, `mod.onUserMessage(current.ctx, ...)` and
`mod.onToolResult(current.ctx, ...)` are called with whatever `current.ctx`
is *at the moment the hook fires* — both modules' handlers accept that
context as their first parameter and then **ignore it** (the parameter is
literally named `_ctx` in all three call sites — `memory.ts:42`,
`reflection.ts:51`, `reflection.ts:58` — confirmed by grep, this isn't
incidental). The buffered content is written to and read from the shared
singleton regardless of which agent/session it belongs to.

**Concrete failure scenario:** two sessions are open concurrently — session
A on agent "work", session B on agent "personal" — both with `memory` and/or
`reflection` enabled. As messages arrive interleaved (any real multi-session
opencode usage), `transcript`/`buffers` accumulate a mix of both
conversations. Whichever session goes idle *first* triggers
`onSessionEnd(ctx)`, which flushes the **entire shared buffer** — including
the other, still-open session's messages — to `ctx.agent`'s ingest/reflect
endpoint. Agent "work" can end up with agent "personal"'s memories (and vice
versa when the second session later flushes an empty or partial buffer).
For a project whose ADR 0004 exists specifically to make cross-agent sharing
**opt-in and provenance-tracked**, an unintentional cross-contamination path
through a shared buffer is a meaningful bug, not a nitpick.

Even single-agent-but-multi-session usage (two sessions on the *same* agent)
is affected less severely (no cross-agent leak) but still wrong relative to
`docs/DESIGN.md`'s stated write path — *"session idle/end triggers
extraction"* implies extraction should reflect **that session's**
conversation, not whatever happened to be in a shared buffer when it went
idle.

**Draft fix:** key both buffers by session, not just by agent — a `Map<string
/* sessionID */, string[]>` for `memory.ts`'s transcript, and equivalent for
`reflection.ts`'s `Buffers`. `ctx.session?.id` is already threaded through
`ModuleContext` (set by `runtime.ts` right before `injections()`, per
`MODULE_SPEC.md`: *"`ctx.session` carries the current opencode session id...
use it for once-per-session work"* — this is exactly that use case, the docs
already anticipated it). `onUserMessage`/`onToolResult` don't currently
receive a session id directly (only via `ctx.session`, and `ctx.session` is
only populated before `injections()` today per `runtime.ts`'s `injections()`
method) — this needs `runtime.ts` to also set `current.ctx.session` before
`onUserMessage`/`onToolResult`/`onSessionEnd` dispatch, not just before
`injections()`. Cross-check against finding #2 in
`0003-findings-plugin-core.md` (manifest caching) since both touch
`runtime.ts`'s per-agent `Loaded` bookkeeping — worth fixing together in one
pass over `runtime.ts` rather than two separate edits that could conflict.
Evict stale session buffers on `session.deleted` (the hook already exists —
`hooks.ts`'s `tracker.forget`, currently only used for the agent-name
tracker — extend the same event to clear memory/reflection buffers for that
session).

### 1b. Deeper root cause found while implementing #1: `runtime.ts`'s single mutable "current agent" pointer, and `index.ts` binding tools to a stale startup-time context

Found during the fix pass for #1, verified against the actual `@opencode-ai/plugin`/`sdk` type declarations (`node_modules/@opencode-ai/{plugin,sdk}/dist/**/*.d.ts`) before writing this up — not guessed:

- `runtime.ts` keeps exactly **one** mutable slot, `current: Loaded | null`,
  for "whichever agent was touched most recently," shared by every
  concurrent session in the process. `hooks.ts`'s `createSessionTracker`
  calls `runtime.switchAgent(agent)` — which reassigns `current` — on
  **every** `chat.message`, `experimental.chat.system.transform`, and
  `tool.execute.after` hook call, for any session. Two sessions on
  different agents interleaving (any real multi-agent usage) can have
  session A's `await mod.onUserMessage(current.ctx, ...)` read `current`
  *after* session B's hook has already reassigned it out from under A —
  `current` is read fresh from the closure on every loop iteration in
  `onUserMessage`/`onToolResult`, not captured once, so this isn't
  theoretical. This is the actual mechanism that made #1's buffer-sharing
  bug possible in the first place (module singletons are one symptom; a
  singleton "current agent" pointer is the underlying cause).
- Separately, `index.ts`'s `collectTools(runtime)` runs **once**, at plugin
  startup, and calls `mod.tools(ctx)` with whatever `runtime.ctx()` (i.e.
  `current.ctx`) is *at that moment* — the default agent's context, since
  no session has connected yet. Every tool's `execute` closure returned by
  `mod.tools(ctx)` closes over that one `ctx` object permanently. Confirmed
  by reading `@opencode-ai/plugin/dist/tool.d.ts`: the real `ToolContext`
  opencode hands to `execute(args, context)` already carries `sessionID`
  and `agent` — but `index.ts`'s own `ToolExecuteContext` only forwards
  `directory`, discarding exactly the fields needed to route the call
  correctly. Net effect: **every tool call in the whole plugin process
  talks to the default agent**, never whichever agent the calling session
  actually has active — `memory_search`/`memory_add`/`reflect`/etc. for a
  non-default agent silently read/write the default agent's data. This is
  a second, independent path to the same cross-agent leak #1 describes, and
  arguably worse (100% of the time for any non-default agent, not just a
  race window).

**Revised draft fix (supersedes the runtime.ts part of #1's draft above):**
Make `runtime.ts` resolve state per call instead of mutating a shared
pointer:
- Keep `loaded: Map<agentName, Loaded>` (module instances are legitimately
  cacheable per agent — no change there).
- Add `sessionAgent: Map<sessionID, agentName>`, replacing `switchAgent`
  with `noteSession(sessionID, agentName)` (records the mapping, warms the
  agent's module cache — no flush-on-switch needed anymore, see below) and
  `forgetSession(sessionID)` (drops the mapping, called on
  `session.deleted`).
- Every dispatch method (`onUserMessage`, `onToolResult`, `onSessionEnd`,
  `injections`, `agent`, `manifest`, `active`, `ctx`, `enabledModules`)
  takes an optional `sessionID` and resolves the right `Loaded` entry fresh
  on each call (falling back to the default agent if the session is
  unknown — same degrade-gracefully behavior as today), building a
  **fresh** `ModuleContext` with `session: {id: sessionID}` per call rather
  than mutating a shared object. This removes the race by construction:
  there is no longer a shared mutable "current," so there is nothing for a
  second session to corrupt mid-await.
- Dropping flush-on-switch is intentional, not an oversight: once buffers
  are keyed by session (per #1's fix) rather than by "whichever agent is
  current," there is nothing to flush when a session's agent changes — the
  session's buffered content simply stays under its own key and flushes
  whenever *that session* ends, attributed to whichever agent is current
  for it at that point. Simpler than the old flush-on-switch special case,
  and arguably more correct (a session's conversation isn't split across
  two ingest calls just because the active agent changed mid-session).
- `hooks.ts`'s `createSessionTracker`/`tracker.touch` becomes entirely
  redundant once every runtime call resolves fresh per `sessionID` — delete
  it, and delete the now-empty `tool.execute.after` hook (its only job was
  `tracker.touch`; confirmed by reading `@opencode-ai/plugin`'s `Hooks`
  type that this hook carries no other payload — `tool`, `sessionID`,
  `callID`, `args` — nothing this codebase needs). This is itself a
  readability win (`READABILITY.md` §1/§8): one less piece of duplicated,
  now-provably-unnecessary state to reason about.
- `index.ts`'s `collectTools` still enumerates tool **names/descriptions**
  once at startup (those don't vary by agent), but each tool's `execute`
  wrapper re-resolves the live `ModuleContext` via
  `runtime.ctx(context.sessionID)` (using the `sessionID` opencode's own
  `ToolContext` already provides) and re-derives that session's actual
  tool list from it before invoking the matching tool by name. Rebuilding
  a small array of closures per tool call is a micro-optimization tradeoff
  explicitly acceptable per the owner's stated goal (readability/
  correctness over micro-optimization) — no I/O is added, only object
  allocation.
- `toolFailure()` in `hooks.ts` should also surface `part.sessionID` (a
  real field on `ToolPart`, confirmed in the SDK types) so the `event`
  handler can pass the correct `sessionID` to `runtime.onToolResult`
  instead of relying on the deleted touch-based bookkeeping.

## 2. Every tool hand-validates its own args with ad hoc `typeof`/`Array.isArray` checks instead of parsing once

**Files:** all four — `memory.ts`, `personality.ts`, `reflection.ts`,
`skills.ts`

Every single `ModuleTool.execute` starts by manually narrowing
`args: Record<string, unknown>` by hand, e.g.:

```ts
const text = typeof args.text === "string" ? args.text : "";
if (!text.trim()) throw new Error("text is required");
```

or, for arrays:

```ts
const signals = Array.isArray(args.signals)
  ? args.signals.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
  : [];
```

This exact shape repeats roughly 15 times across the 4 files (memory_add,
channel_share ×2 fields, channel_items, channel_subscribe,
persona_evolve/signals, reflect/failures, reflect/messages,
lessons_retire/id, skill_distill/trace, skills_list/all,
skill_verify/name...), each written slightly differently (some default to
`""` and then check `.trim()`, some throw immediately, some filter silently
dropping bad array elements with no feedback). This is the textbook
"shallow, repeated validation scattered through business logic" case
`docs/READABILITY.md` §5 (parse-don't-validate) calls out — and notably,
`plugin/src/index.ts` already uses zod (`z.record(z.string(),
z.unknown().optional())`) for the *outer* tool-args envelope, so zod is
already a project dependency and pattern, just not applied at the point
where it would actually buy type safety: each tool's own argument shape.

**Draft fix:** give each tool a small zod schema for its own args and parse
once at the top of `execute` (`const { text } =
memoryAddArgs.parse(args)`), replacing the hand-rolled checks. A parse
failure becomes one consistent, informative thrown error (zod's message)
instead of ~15 differently-worded hand-written ones. This is a mechanical,
low-risk-per-site change but touches every tool in every module — plan it
as one commit per module file so `make test` can verify each independently
by tool name have distinct enough test failures (`plugin/tests/*.test.ts`
already exist per module — check they call tools by name so a schema typo
is caught, not just a happy-path smoke test).

## 3. Minor: duplicated bounded-FIFO-buffer logic

**Files:** `memory.ts` (`transcript`, capped at `MAX_BUFFERED_MESSAGES =
200`), `reflection.ts` (`buffers.failures`/`buffers.messages`, capped at
`MAX_BUFFERED = 100`)

Both hand-roll the same "push, and if over the cap `.shift()` the oldest
out" pattern independently. Small enough to not be a priority on its own,
but since fixing finding #1 already requires restructuring both buffers
into session-keyed maps, extract one small shared bounded-buffer helper at
the same time rather than duplicating the new (session-keyed) version too.

## 4. Verified fine — not a finding

`memoryModule.tools()` includes `channel_share`/`channel_items`/
`channel_subscribe`, which looks at first glance like it belongs on a
"channels" module — but `MODULE_SPEC.md`'s own module table lists
`(channels) | tools on the memory module`, i.e. this placement is
intentional and documented, not drift. Noted here so a future pass doesn't
"fix" it.

## 5. Minor style

Both `memory.ts` and `reflection.ts` import a second type
(`ToolExecuteContext`, `ToolResultEvent`) via a separate `import type { ...
} from "../core/types.js"` statement instead of merging into the existing
import from the same module on line 1. Batch into the general cleanup pass.
