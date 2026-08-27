# Findings — plugin core (`plugin/src/core/`, `index.ts`, `cli.ts`)

Part of [0003-readability-refactor.md](0003-readability-refactor.md). Audit
only — no code changed yet. Each finding was checked against the actual
code/grep, not assumed. Ordered by priority (robustness first, then
readability/consistency, then style).

## 1. `getJSON`/`postJSON` have no timeout — a hung service can hang a session

**File:** `plugin/src/core/service.ts`

`ServiceClient.health()` uses `AbortSignal.timeout(2000)`, but `getJSON` and
`postJSON` — used for everything else, including
`experimental.chat.system.transform` (injections, on the hot path of every
turn) and `onSessionEnd` flush — issue a plain `fetch` with no timeout at
all. `MODULE_SPEC.md` and `ARCHITECTURE.md` both state a module failure
"must never break the session," but an indefinitely stalled connection
(service wedged, slow LLM call blocking the endpoint, network weirdness)
means the awaited `fetch` promise never settles, so the calling hook never
returns. `hooks.ts` wraps calls in `try/catch`, which only helps once the
promise *rejects* — it does nothing for a hang.

**Draft fix:** give `getJSON`/`postJSON` the same `AbortSignal.timeout(...)`
treatment as `health()`, with a constant (e.g. `REQUEST_TIMEOUT_MS`,
something like 10–15s — long enough for a real LLM-backed extraction/reflect
call, short enough that a hang surfaces as a catchable `ServiceError`
instead of an infinite wait). Confirm the chosen value against what the
service's slowest LLM-backed endpoint realistically takes (check
`core/llm.py` for any existing timeout config it already respects, so the
plugin's ceiling isn't shorter than a legitimate slow call).

## 2. Manifest is cached for the process lifetime, contradicting documented behavior

**File:** `plugin/src/core/runtime.ts` (`loadAgent`, `switchAgent`)

`loadAgent` checks `if (loaded.has(name)) return loaded.get(name)` before
ever fetching `/v1/agents/<name>` again. Once an agent has been loaded once
in a given opencode process, its manifest (and the module set derived from
it) is frozen until the process restarts — including if the user edits
`agent.json` (e.g. toggles a module) and starts a brand new session.
`switchAgent` also no-ops entirely when `name === current?.agent`, so even
returning to the *same* agent across sessions never re-reads anything.

This contradicts `MODULE_SPEC.md`: *"Toggle at any time; the plugin reads
the manifest at session start."* An opencode plugin process is long-lived
across many sessions, so in practice a user toggling a module and starting a
new session would see no effect — only a full opencode restart fixes it.
This is the kind of drift that would actively mislead a maintainer reading
the docs to understand the system.

**Draft fix:** the literal fix is to drop the `loaded` cache and always
re-fetch the manifest + re-run `loadModules` at the point a session starts
for an agent (which, given the current hook wiring, is `tracker.note` /
`chat.message`, not `switchAgent`'s identity check). This is *not* a
one-line change: `loadModules` calls each module's `init()`, and re-running
`init()` every session-start assumes module `init()` is cheap and
idempotent. **Before implementing, verify this assumption while auditing
the four modules** (memory/personality/reflection/skills) — if any `init()`
does non-idempotent work (e.g. opens a resource it doesn't close), the fix
needs a lighter-weight "re-check the manifest, only reload if it changed"
path instead of unconditional re-init. Tracked to revisit in
`0003-findings-plugin-modules.md`.

## 3. Duplicate `venvPython` name for two different concepts

**Files:** `plugin/src/core/bootstrap.ts`, `plugin/src/core/lifecycle.ts`,
`plugin/src/cli.ts`

Two unrelated functions share the name `venvPython`:

- `bootstrap.ts`: `venvPython(home)` → `<home>/venv/bin/python` — the
  **installed** venv under `~/.openark/venv` (what `openark install`
  creates).
- `lifecycle.ts`: `venvPython(dir)` → `<dir>/.venv/bin/python` — a **dev
  checkout's** local venv (what `make dev` / `uv venv` creates inside
  `service/`).

`cli.ts`'s `servicePython()` needs *both* concepts (prefer the installed
venv, fall back to a dev checkout) but only imports `bootstrap.ts`'s
version, and re-implements the dev-venv path inline
(`join(serviceDir, ".venv", "bin", "python")`, line 116) instead of calling
`lifecycle.ts`'s `venvPython`. So the dev-venv path convention now exists in
two places that would need to change together — the exact "change
amplification" smell `READABILITY.md` §1 calls out — and it already
silently drifted once (`cli.ts`'s inline copy would not notice if
`lifecycle.ts`'s convention changed).

**Draft fix:** rename to make the two concepts distinct and
self-documenting: `bootstrap.ts`'s → `installedVenvPython(home)`,
`lifecycle.ts`'s → `devVenvPython(serviceDir)`. Update `cli.ts`'s
`servicePython()` to call both named functions (deleting its inline
duplicate) and update the `doctor.ts`/`cli.ts` import sites.

## 4. `manifestAllows` is dead code duplicating inline logic

**File:** `plugin/src/core/loader.ts`

`manifestAllows(manifest, moduleName)` is exported but has zero call sites
in the repo (confirmed by grep across `plugin/src`). Meanwhile
`loadModules` re-expresses the identical predicate inline:
`if (!ctx.manifest.modules[mod.name]) continue`. A reader who finds
`manifestAllows` reasonably assumes it's used somewhere and spends time
looking; it isn't.

**Draft fix:** don't delete it — it's the better, testable, named form of
the predicate. Instead make `loadModules` call it
(`if (!manifestAllows(ctx.manifest, mod.name)) continue`), removing the
duplicate inline boolean logic and giving the one true implementation a
caller.

## 5. Service port default duplicated across two TS files

**Files:** `plugin/src/core/config.ts`, `plugin/src/core/lifecycle.ts`

`8765` is hardcoded independently in `config.ts` (`readGlobalConfig`'s
`defaults.servicePort`) and `lifecycle.ts` (`spawnService`'s
`options.port ?? 8765` fallback). These two are in the same runtime and
*can* share a constant — unlike the Python service's own independent
`service_port: int = 8765` default in `core/config.py`, which is a
legitimate, unavoidable cross-language duplication (no shared constant
possible across TS/Python) and is out of scope for this finding, but should
get a one-line comment noting the two must be kept in sync by hand (a
correct use of a "why" comment per `READABILITY.md` §4 — it's a constraint
the type checker can't enforce).

**Draft fix:** export `DEFAULT_SERVICE_PORT = 8765` from `config.ts`; import
and use it in `lifecycle.ts` instead of the bare literal. Add the
cross-language sync comment next to the Python default.

## 6. Same "parse agent.json, degrade safely" logic reimplemented three times, inconsistently commented

**Files:** `plugin/src/core/installer.ts` (`readAgentDescription`),
`plugin/src/cli.ts` (`listAgentsCmd`), partially
`plugin/src/core/doctor.ts` (`checkAgentManifest`)

`installer.ts`'s `readAgentDescription` reads `agent.json`, extracts
`description`, and falls back on parse failure with a `catch { // keep
default description }` — a correct, commented silent-catch per
`READABILITY.md` §6. `cli.ts`'s `listAgentsCmd` does the same
read-parse-extract-fallback for the same field, but with a bare `catch {}`
and no comment. Two call sites doing an identical thing should read
identically; right now one explains itself and the other doesn't, which is
also a missed reuse opportunity (`READABILITY.md` §2/§8 — this is exactly
the kind of small "deep" helper every caller currently reimplements by
hand).

**Draft fix:** have `cli.ts`'s `listAgentsCmd` call
`installer.ts`'s `readAgentDescription` instead of re-parsing `agent.json`
itself, deleting the duplicate (and now-inconsistent) logic entirely.

## 7. Two apparently-unnecessary `as` type casts (type-safety audit)

**File:** `plugin/src/index.ts` (`collectTools`)

- `mod.tools?.(ctx as ModuleContext)`: `ctx` comes from `runtime.ctx()`
  (`ModuleContext | null`), narrowed by an earlier `if (!ctx) return {}`.
  The cast looks redundant — TS should keep `ctx` narrowed to
  `ModuleContext` for the rest of the function since it's a `const`.
- Inside `tool({ execute: ... })`, `(input.args ?? {}) as Record<string,
  unknown>` — more defensible (zod's `.optional()` on values technically
  makes the inferred type `Record<string, unknown | undefined>`), but worth
  double-checking whether a zod `.transform()` at the schema level could
  produce the right type without a cast.

**Draft fix:** don't assume — delete the first cast and run `tsc`/biome
during the fix pass; if the build stays green, it was dead weight and stays
deleted (every unnecessary `as` is a spot the type checker was blinded for
no reason). If either cast turns out to be load-bearing, leave it with a
one-line comment explaining what TS can't infer and why.

## 8. Minor style: redundant `| undefined`

**File:** `plugin/src/core/types.ts`

`session?: { id: string } | undefined` — the `?` already makes the property
optional (equivalent to `| undefined`); the explicit union is noise. Fold
into the general core-area cleanup pass rather than its own commit.
