# Module design

Per-module design for the four shipped modules. The contract they implement
is in [MODULE_SPEC.md](MODULE_SPEC.md); method background is in
[plans/0001-research-and-design.md](plans/0001-research-and-design.md).

## memory

**Basis:** Mem0 OSS (extraction-first memory) + agentic tools (Letta-style).

- Storage: Mem0 with embedded Chroma under `agents/<name>/data/`, local
  sentence-transformer embedder by default (no API key required).
- Write path: session end (and idle) triggers extraction
  (`prompts/extraction.md`); facts resolve add/update/replace via Mem0's
  judge; memories are tagged with the current project (cwd basename).
- Read path: hybrid recall (semantic + keyword), token-budgeted, injected as
  an "Remembered about you" block; private memory outranks channel memory.
- Agentic tools: `memory_search`, `memory_add` — the agent can deliberately
  consult and curate its memory mid-conversation.

## personality

**Basis:** layered persona; two-timescale evolution (StableMind pattern).

- `persona.core.md` — user-authored, immutable by the agent, injected at
  priority 100.
- `persona.evolving.md` — agent-managed learned preferences, injected at 80.
- Updates use `prompts/persona_update.md` with a confidence threshold
  (distinct-signal count); traits never change, only preferences.
- Every change appends a diff to `logs/audit.log`.

## reflection

**Basis:** Reflexion (verbal reinforcement) + ExpeL (insight rules) +
Madaan-style prompt self-editing.

- Triggers: tool failures (non-zero exits, reverted edits, failed tests) and
  a user-correction classifier, plus manual `/learn`.
- Pipeline: `prompts/reflection.md` enforces specific-failure → root-cause →
  concrete-rule structure; results land in `lessons.md` with provenance.
- Lifecycle: dedupe on add (LLM judge), hit counter incremented when a rule
  is injected into a session, auto-retire rules with zero hits after N
  sessions, `/learn review` to edit retroactively.

## skills

**Basis:** Voyager skill library (verified-before-stored).

- Successful multi-step workflows are distilled via
  `prompts/distillation.md` into a draft skill.
- A draft becomes verified after one successful reuse or explicit user
  approval (`/skills`); only verified skills are advertised.
- Verified skills materialize as `agents/<name>/skills/<n>/SKILL.md`,
  registered with opencode via `skills.paths` — retrieval is native.
- Skills are compositional: new skills may reference earlier ones.

## channels (cross-module)

- An agent pushes a memory/lesson into `channels/<name>/` with its own name
  as provenance; subscribers merge channel items after private memory.
- Subscriptions live in `agent.json`; users audit what flows between agents.
