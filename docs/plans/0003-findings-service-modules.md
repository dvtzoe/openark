# Findings — service modules (`service/openark/modules/`)

Part of [0003-readability-refactor.md](0003-readability-refactor.md). Audit
only — no code changed yet. Covers `base.py`, `memory.py`, `persona.py`,
`lessons.py`, `skills.py`, `channels.py`. Overall these are well-decomposed
(small pure helper functions, dataclasses for parsed state) — findings below
are real gaps, not a rewrite-everything verdict.

## 1. Modules return raw `dict[str, Any]`; the typed response models they should build already exist and go unused until the outermost API layer

**Files:** `memory.py`, `persona.py`, `lessons.py`, `skills.py`,
`channels.py`, cross-checked against `api/v1/persona.py`, `api/v1/lessons.py`

Every module method that returns a result (`PersonaModule.evolve`,
`LessonsModule.reflect`/`add`/`retire`/`register_hits`,
`SkillsModule.distill`/`verify`, `MemoryModule.ingest`, `ChannelsStore.push`)
returns a bare `dict[str, Any]` (or `dict`) built by hand at each return
site. `core/models.py` already defines the exact Pydantic shape each of
these should be (`PersonaEvolveResponse`, `ReflectResponse`,
`LessonAddResponse`, `LessonRetireResponse`, `LessonHitsResponse`,
`DistillResponse`, `SkillVerifyResponse`, `MemoryIngestResponse`,
`ChannelItem`) — confirmed by reading `api/v1/persona.py` and
`api/v1/lessons.py`: **every single endpoint** re-wraps the module's dict
into the real response model right before returning it
(`ReflectResponse(**result)`, `LessonRetireResponse(**module.retire(...))`,
etc.).

So the typed contract is enforced, but only at the very last line of the API
layer — a full call/response cycle away from where the dict is actually
constructed. Concretely this means:

- A module method can return a dict with a wrong/missing/misspelled key and
  nothing catches it until (if ever) an API endpoint happens to unpack it
  into the Pydantic model — module-level unit tests (which
  `CONTRIBUTING.md` requires per module) exercise the module directly and
  get back an untyped dict, so they can't catch a shape mismatch the way
  they could catch it against a real typed return value.
- `api/v1/persona.py`'s `evolve_persona` has to know an *internal*
  representation detail of `PersonaModule.evolve` — that `"replaced"` comes
  back as a list of `(old, new)` tuples — and do the tuple→dict conversion
  itself before it can construct `PersonaEvolveResponse`. That conversion
  is exactly the module's job, not the API layer's; it's a small abstraction
  leak (`READABILITY.md` §2, shallow interface).
- Every endpoint carries near-identical `ResponseModel(**result)`
  boilerplate (8+ occurrences) purely to re-assert a type the module already
  knew and threw away.

**Draft fix:** have each module method build and return the actual
`core.models` response object instead of a dict — e.g.
`PersonaModule.evolve(...) -> PersonaEvolveResponse`, constructing
`PersonaReplace(old=..., new=...)` internally instead of leaving tuple→dict
conversion to the caller. API endpoints then become `return
module.evolve(...)` (or close to it), dropping the reconstruction
boilerplate. This is mechanical per-method but touches every module file —
plan as one commit per module (memory, persona, lessons, skills, channels),
each independently verifiable via `make service-test`. Do this *after*
finding #1 in `0003-findings-service-core.md` (adding a type checker) lands,
so the type checker itself can confirm each return site actually matches
before/after, rather than relying on tests alone to catch a mismatch.

## 2. `MemoryModule.add` doesn't handle store failures the way `MemoryModule.ingest` does

**File:** `memory.py`

`ingest()` wraps its `store.add(...)` call in `try/except Exception`,
logs, and returns a structured `{"reason": "store-error"}` — a clean
degrade. `add()` (the manual `memory_add` tool path — same underlying
`store.add()` call, same class of possible failure, e.g. a Chroma write
error) has **no such handling**; an exception there propagates uncaught
through the API layer. Two sibling methods doing the same kind of
storage write should fail the same way; right now only one of them
actually honors the project's "degrade to no-op, never a broken session"
principle.

**Draft fix:** wrap `add()`'s `store.add(...)` call the same way `ingest()`
does, returning a comparable structured failure (check what
`MemoryMutation`/the API caller expects for an error case — may need a
`reason` field added to `MemoryMutation` in `core/models.py`, or the
endpoint may need to translate a `None`/error result into an HTTP error;
decide during implementation by reading `api/v1/memory.py`, which hasn't
been audited yet).

## 3. Inconsistent resilience to one corrupted file when listing many

**Files:** `skills.py` (`SkillsModule.list`/`_read`), compare
`channels.py` (`ChannelsStore._read`) and `core/registry.py`
(`AgentRegistry.list`, flagged separately in
`0003-findings-service-core.md` #2)

`SkillsModule._read` calls `path.read_text()` on each `SKILL.md` with no
error handling; `list()` calls `_read` for every matching file via a glob
with no per-file try/except. One unreadable or malformed skill file (races
with a concurrent write, permissions issue, disk error) breaks listing
*every* skill for that agent — the same "one bad file takes down the whole
list" shape as the `AgentRegistry.list()` finding.

Notably, `channels.py`'s `_read()` already gets this right: it parses each
JSONL line independently inside a `try/except ValueError: continue`, so one
malformed line is skipped and every other item still loads. This is the
pattern to copy, not a new one to invent.

**Draft fix:** wrap `SkillsModule._read`'s file read (and frontmatter parse)
in a try/except that logs and returns `None` (already the shape `list()`
filters for) instead of raising — matching `channels.py`'s existing
per-item resilience. Handle this alongside `0003-findings-service-core.md`
#2 (`AgentRegistry.list`) since it's the same fix pattern applied to a
second call site — worth one shared commit or at least one shared review
pass so both land with the same shape of fix.

## 4. Minor: inconsistent exception types caught around JSON state loading

**File:** `lessons.py` (`_load_state`), compare `core/config.py`
(`_load_settings`)

`config.py`'s `_load_settings` catches `(ValueError, OSError)` around
reading+parsing `openark.json` — covers both a malformed-JSON error and a
file-read error. `lessons.py`'s `_load_state` (reading
`data/lessons_state.json`) only catches `ValueError`, not `OSError` — a
transient read failure there propagates uncaught through `register_hits`.
Small, but the same "read a JSON file, degrade safely" operation should
degrade the same way everywhere it appears (`READABILITY.md` §8).

**Draft fix:** catch `(ValueError, OSError)` in `_load_state`, matching
`config.py`'s existing precedent — no need to invent new behavior, just
make the exception set consistent.

## 5. Minor/comment opportunity: per-agent Mem0 store is cached forever

**File:** `memory.py` (`Mem0StoreFactory.__call__`)

`Mem0StoreFactory` caches one `Mem0Store` per `agent_home`, built once with
whatever LLM/embedder route resolves *at first use*. This is a reasonable
performance tradeoff (rebuilding a Mem0/Chroma connection per call would be
wasteful) — not a bug — but it means changing `openark.json`'s model routing
for `extraction`/`embeddings` after an agent's memory has already been used
once has no effect until the service process restarts, and nothing says so
anywhere. Same shape as the manifest-caching issue on the plugin side
(`0003-findings-plugin-core.md` #2), independently discovered on the service
side.

**Draft fix:** not a structural fix (rebuilding the store per-request would
be over-engineering for a rare operator action) — add a one-line comment at
the cache site explaining the tradeoff explicitly (why cached, what the
operator needs to do — restart the service — for a routing change to take
effect), which is exactly a correct "why" comment per `READABILITY.md` §4.
