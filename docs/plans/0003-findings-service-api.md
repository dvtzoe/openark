# Findings — service API layer (`service/openark/api/v1/`)

Part of [0003-readability-refactor.md](0003-readability-refactor.md). Audit
only — no code changed yet. This is the last area of the audit phase — see
the plan doc's log for the wrap-up/next-steps note after this file.

## 1. The same "look up agent, 404 if missing" check is implemented five different ways across five files

**Files:** `memory.py`, `persona.py`, `lessons.py`, `skills.py`,
`channels.py`

- `lessons.py`, `skills.py`, `channels.py` each define a private
  `_require_agent(registry, name)` that does the identical
  `try: registry.get(name) except AgentNotFound: raise HTTPException(404,
  "no such agent")` — three separate copies of the same function.
- `memory.py` defines its own `_require_agent` that does the same check
  *plus* returns `registry.agent_home(name)` — a superset, not reused from
  the others.
- `persona.py` doesn't define a helper at all; `evolve_persona` inlines the
  same three-line try/except directly in the endpoint body.

Five files, one concept, five implementations. This is a textbook
change-amplification case (`READABILITY.md` §1): the 404 message or status
code can't be changed in one place — it has to be changed (or, more
realistically, *forgotten in some of* ) five. It's also the kind of
inconsistency that makes each file slightly harder to trust: a reader who's
learned `_require_agent`'s behavior in `lessons.py` has to re-verify it's
the same in `channels.py` rather than being able to assume it.

**Draft fix:** extract one shared helper — a good home is `agents.py` itself
(which already owns `get_registry`, the other cross-file DI dependency), or
a new small `api/v1/deps.py` if that reads better once written. Two
variants are needed (validate-only, and validate-and-return-agent-home per
`memory.py`'s usage) — or just always return `agent_home` and let callers
that don't need it ignore it, whichever reads cleaner in practice. Update
all five files to import and call the shared version, deleting the four
duplicates/inline copies. Low-risk, mechanical, good candidate for an early
fix since it touches every API file but changes no behavior.

## 2. The "one corrupted item breaks the whole list" pattern has a third occurrence here

**File:** `channels.py` (`read_channel`)

`return [ChannelItem(**item) for item in items]` — unguarded. Already
found twice in the modules layer
(`0003-findings-service-core.md` #2 — `AgentRegistry.list`;
`0003-findings-service-modules.md` #3 — `SkillsModule.list`/`_read`).
`ChannelsStore._read()` already skips malformed *JSON lines* gracefully
(`try/except ValueError: continue`), but a line that parses as valid JSON
while missing a field `ChannelItem` requires isn't caught until this list
comprehension tries to construct it — same failure shape as the other two,
one level further out.

**Not a new finding to fix in isolation** — noting it here to confirm the
pattern is systemic (three independent occurrences across three files, two
different layers) rather than a one-off, which changes the recommended fix
from "patch three call sites separately" to "fix the shape once, apply it
consistently." When implementing, do all three
(`AgentRegistry.list`, `SkillsModule.list`, `channels.py`'s `read_channel`)
in the same review pass so they end up with the same resilience shape
(skip-and-log the bad item, return everything that's valid) rather than
three subtly different ad hoc fixes.

## 3. `app.state.modules` is an untyped dict — every module lookup is stringly-typed

**Files:** `app.py` (`build_modules`), all of `api/v1/*.py`'s `get_X_module`
functions

`build_modules() -> dict` returns an untyped dict; `app.state.modules =
build_modules()`. Every API file's DI function
(`get_memory_module`, `get_persona_module`, `get_lessons_module`,
`get_skills_module`, `get_channels_store`) does
`request.app.state.modules["memory"]` (etc.) — a string-keyed lookup with no
static guarantee the key exists or names the right module. A typo in any of
these five strings (e.g. a copy-paste `"memroy"`) is invisible to any
checker and only surfaces as a `KeyError` at first request. None of the
five `get_X_module` functions has a return type annotation either, so
`module=Depends(get_memory_module)` gives every endpoint an effectively
`Any`-typed `module` parameter — the exact opposite of the owner's "maximum
type safety" goal, and it's the root cause feeding into
`0003-findings-service-modules.md` #1 (nothing types-check the module→dict
boundary either).

**Draft fix:** replace the bare `dict` with a small typed container — a
`@dataclass` (or similar) with one named field per module
(`memory: MemoryModule`, `persona: PersonaModule`, `lessons: LessonsModule`,
`skills: SkillsModule`, `channels: ChannelsStore`) — and have
`build_modules()` return that type. Each `get_X_module` function then reads
`request.app.state.modules.memory` (attribute access, checked) instead of a
string key, and can carry a real return type annotation
(`-> MemoryModule`), so `Depends(get_memory_module)` gives endpoints a
properly typed `module` parameter. Do this together with adding a type
checker (`0003-findings-service-core.md` #1) so the improvement is actually
verified, not just hoped for.

## 4. The build/release version string is hardcoded independently in six places

**Files:** `plugin/package.json`, `service/pyproject.toml`,
`service/openark/__init__.py`, `service/openark/app.py`,
`service/openark/api/v1/health.py`, `plugin/src/cli.ts`

All six currently say `"0.1.0"` as an independent literal (confirmed by
grep). Of these, two are the legitimate sources of truth (`package.json`
for the npm package, `pyproject.toml` for the PyPI package) — the other
four are hand-duplicated copies that will silently drift on the next
version bump if even one is missed: `health.py`'s `GET /v1/health` would
report a stale version, `openark version` (`cli.ts`) would print a stale
version, `app.py`'s FastAPI `version=` (shows in the auto-generated
OpenAPI docs) would be stale, and `__init__.py`'s `__version__` (the
conventional place other Python code/tools would check) would be stale.

**Draft fix:**
- Python: derive `__init__.py`'s `__version__` from installed package
  metadata (`importlib.metadata.version("openark-service")`) instead of a
  literal, so it always matches whatever `pyproject.toml` actually shipped;
  have `app.py` and `health.py` both import `openark.__version__` instead
  of hardcoding their own copies.
- TypeScript: have `cli.ts`'s `version` command read `plugin/package.json`
  (already bundled with the published package) instead of a literal —
  check how `packageRoot()` (already defined in `installer.ts`) resolves
  the package dir and reuse it to locate `package.json`.
- Net effect: two sources of truth (the two `package.json`/`pyproject.toml`
  files, which is unavoidable — that's genuinely where npm/PyPI read the
  version from), zero hand-duplicated copies.

## Verified fine — not findings

- **Module isolation** (`MODULE_SPEC.md`: "Modules never import each
  other") — confirmed by grep across `service/openark/modules/*.py`: zero
  cross-module imports. Composition (e.g. `memory.py`'s `recall` endpoint
  merging `MemoryModule.recall` results with
  `ChannelsStore.subscribed_items`) correctly happens only in the API
  layer, exactly as documented.
