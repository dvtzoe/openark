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
