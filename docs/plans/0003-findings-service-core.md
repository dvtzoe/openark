# Findings — service core (`service/openark/core/`, `app.py`)

Part of [0003-readability-refactor.md](0003-readability-refactor.md). Audit
only — no code changed yet.

## 1. No Python static type checker is configured anywhere — type hints are unenforced

**Files:** `service/pyproject.toml`, `Makefile`, `.github/workflows/ci.yml`

Checked all three: `service-lint` / CI's `service` job run only `ruff check
.` — ruff is a linter/formatter (`select = ["E", "F", "I", "UP", "B",
"SIM"]`), it does not type-check. There is no mypy or pyright dependency,
config section, Makefile target, or CI step anywhere in the repo (grepped
for both across every `.toml`/`.yml`/`.yaml`/`.cfg`). Meanwhile
`core/llm.py:164` has a live `# type: ignore[union-attr]` comment — evidence
someone *did* run a type checker locally at some point and got a real
error, but nothing in the committed toolchain would ever surface that error
(or any other) again. `CONTRIBUTING.md` states "Python uses type hints
throughout," but nothing currently verifies that claim; it's convention
only.

For a project whose owner explicitly wants "maximum type safety," this is
the highest-leverage single fix on the service side — every other Python
type-safety finding in this audit (see #4 below) exists *because* nothing
catches it.

**Draft fix:** add `pyright` (or `mypy` — pyright tends to need less
configuration and pairs well with Pydantic v2) as a `dev` optional
dependency in `pyproject.toml`; add a `service-typecheck` Makefile target;
wire it into `make lint` and the CI `service` job. Run it once added and use
its actual output to drive the type-safety cleanup pass (starting with
finding #4), rather than guessing at what's untyped.

## 2. One corrupted `agent.json` can break listing every agent

**Files:** `core/registry.py` (`AgentRegistry.list`, `.get`),
`api/v1/agents.py` (`list_agents`)

`AgentRegistry.list()` iterates every directory under `agents/` that has an
`agent.json` and calls `self.get(entry.name)` for each, with no
per-entry error handling. `get()` does `json.loads(path.read_text())` then
`AgentManifest.model_validate(raw)` — either can raise
(`json.JSONDecodeError`, `pydantic.ValidationError`) on a malformed file.
`api/v1/agents.py`'s `list_agents` (`GET /v1/agents`, part of the documented
`/v1` contract per `ARCHITECTURE.md`) calls `registry.list()` with no
try/except either, so the exception propagates uncaught to FastAPI — one
agent with a bad `agent.json` turns the *entire* list endpoint into an
unhandled 500, taking every other, perfectly fine agent down with it.

This directly contradicts the project's own stated value — ADR 0004 says
"one polluted agent cannot poison everyone" (about channels specifically,
but the same principle obviously generalizes to "the registry as a whole").
Notably, the *plugin* side already gets this right for the single-agent
case: `runtime.ts`'s `loadAgent` wraps the manifest fetch in try/catch and
degrades that one agent to "unavailable, logged" without affecting anything
else — there's just no equivalent protection for the bulk-list path.

Compounding it: `save_manifest`/`create()` write `agent.json` via a direct
`path.write_text(...)` — not atomically (no write-to-temp-then-rename) — so
a crash or kill mid-write is a real way to end up with a half-written,
invalid `agent.json` in the first place, which then would trip the bug
above.

**Draft fix:** two related changes, best done together since they're the
same root problem (a corrupt manifest, and what happens when one exists):

- `AgentRegistry.list()` should not let one bad manifest fail the whole
  call — skip agents that fail to parse/validate, and surface *something*
  about the skip (at minimum a server-side log; ideally, since this is
  exactly the kind of thing a maintainer needs visibility into, consider
  whether it belongs in a response field or a dedicated warning list —
  decide during implementation by checking whether any consumer needs it
  structured, or a log line is enough given there's no service-side
  "doctor" equivalent yet).
- `save_manifest` and the manifest-write step of `create()` should write
  atomically (temp file in the same directory + `os.replace`) so a crash
  mid-write can't produce a torn file for `list()`/`get()` to trip over
  later.

## 3. Undocumented implicit fallback when a task has no configured route

**File:** `core/llm.py` (`resolve_route`)

When `task` isn't present in `openark.json`'s `models` map at all,
`resolve_route` doesn't treat that as "no route" immediately — it defaults
to `route = InheritRoute(inherit="small")` and tries to resolve *that*
before giving up. The eventual behavior if opencode's own `small_model`
also isn't configured does still degrade to `None`/no-op, matching the
documented spirit ("missing route = documented no-op"), but the *path*
there — silently trying to inherit the small model first — isn't mentioned
anywhere in `docs/DESIGN.md`'s model-routing section, which reads as if a
route is either explicitly `{inherit: ...}`, explicitly a provider entry, or
absent-and-therefore-inert. This is a real, deliberate design decision (it
means a bare-bones `openark.json` with no `models` section still works if
opencode itself has a small model configured) — it's just neither
documented nor commented, so a reader of either the docs or the code alone
would form the wrong mental model.

**Draft fix:**
- Add a one-line comment at the `if route is None: route =
  InheritRoute(inherit="small")` line explaining the intent (why default to
  the cheap inherited model instead of returning `None` immediately) — a
  correct use of a "why" comment per `READABILITY.md` §4.
- Update `docs/DESIGN.md`'s model-routing bullet to mention this default
  explicitly, so the documented contract matches what the code actually
  does.

## 4. Concrete type-safety gap: untyped `settings` parameter

**File:** `core/llm.py` (`resolve_route`)

`def resolve_route(task: str, settings=None, ...)` — `settings` has no type
annotation. The line that uses it,
`(settings or get_settings()).models.get(task)`, needs
`# type: ignore[union-attr]` to pass whatever check flagged it (see finding
#1 — nothing currently re-runs that check). The correct type is plainly
inferable from usage: `settings: Settings | None = None`.

**Draft fix:** annotate it properly; once finding #1 lands (a type checker
in the toolchain), confirm the `type: ignore` comment is no longer needed
and delete it — an `ignore` comment that outlives the error it was
suppressing is worse than no comment (per `READABILITY.md` §4, an
inaccurate comment actively misleads).

## 5. Minor consistency: two idioms for the same "empty list default" in one file

**File:** `core/models.py`

Some models use `Field(default_factory=list)` (`ChannelConfig.subscriptions`,
`AgentManifest.modules`/`channels`); others use a bare `= []`
(`PersonaEvolveRequest.signals`, `PersonaEvolveResponse.added`/`replaced`,
`MemoryRecallResponse.memories`, `LessonsResponse.lessons`,
`ReflectRequest.failures`/`messages`, `ReflectResponse.added`,
`LessonHitsRequest.ids`, `SkillsResponse.skills`). Both are actually safe in
Pydantic v2 — unlike plain Python, Pydantic gives each model instance its
own copy of a mutable default, so this is **not** the classic
mutable-default bug — but a reader who doesn't know that Pydantic special
case would reasonably suspect it is, or wonder why the file spells the same
thing two ways. Purely a consistency nit (`READABILITY.md` §8); functionally
inert either way.

**Draft fix:** standardize on `Field(default_factory=list)` throughout the
file (more explicit, doesn't rely on the reader knowing Pydantic's
per-instance-default guarantee) — mechanical, one commit, safe to batch with
other Python style-only cleanups.
