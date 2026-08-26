# Module design

Per-module design for the four shipped modules. The contract they implement
is in [MODULE_SPEC.md](MODULE_SPEC.md); method background is in
[plans/0001-research-and-design.md](plans/0001-research-and-design.md).

## memory

**Basis:** Mem0 OSS (extraction-first memory) + agentic tools (Letta-style).

- Storage: Mem0 with embedded Chroma under `agents/<name>/data/`, local
  fastembed embedder (ONNX, `BAAI/bge-small-en-v1.5`) by default — no API
  key required.
- Write path: session idle/end triggers extraction
  (`prompts/extraction.md`); facts resolve add/update/replace via Mem0's
  judge; memories are tagged with the current project (cwd basename).
- Read path: semantic search with a keyword-overlap rerank (hybrid),
  token-budgeted, injected as a "Remembered about you" block; private memory
  outranks channel memory. Provenance is shown for shared items.
- Agentic tools: `memory_search`, `memory_add` — the agent can deliberately
  consult and curate its memory mid-conversation.
- No model route configured? Adds are stored verbatim (`infer=False`) and
  extraction is skipped — memory still works, just unrefined.

## personality

**Basis:** layered persona; two-timescale evolution (StableMind pattern).

- `persona.core.md` — user-authored, immutable by the agent, injected at
  priority 100.
- `persona.evolving.md` — agent-managed learned preferences (bullet list),
  injected at 80.
- Updates use `prompts/persona_update.md` with a confidence threshold
  (default: 3 distinct signals); the service gates on distinct-signal count
  before calling the model. Traits never change, only preferences.
- Every change appends a diff to `logs/audit.log`.
- `persona_evolve` tool lets the agent propose updates from feedback
  (powers `/persona`).

## reflection

**Basis:** Reflexion (verbal reinforcement) + ExpeL (insight rules) +
Madaan-style prompt self-editing.

- Triggers: tool failures (errored tool parts: non-zero exits, failed
  tests/edits) captured via opencode events, plus user messages that follow
  a failure (correction classification happens in the reflection prompt),
  plus manual `/learn`.
- Pipeline: `prompts/reflection.md` enforces specific-failure → root-cause →
  concrete-rule structure and lists already-learned rules (dedupe is handled
  in the same call plus an exact-match guard); results land in `lessons.md`
  as `- [status] rule (source: X, hits: N, stale: M)` lines with provenance.
- Lifecycle: hit counter increments when a rule is injected into a session
  (once per session); rules with zero injections for 5 consecutive sessions
  auto-retire; a retired rule that reappears in reflection is reinstated;
  `/learn review` edits retroactively via `lessons_list`/`lessons_retire`.

## skills

**Basis:** Voyager skill library (verified-before-stored).

- Successful multi-step workflows are distilled via
  `prompts/distillation.md` into a draft skill
  (`skills/drafts/<slug>/SKILL.md`).
- A draft becomes verified after one successful reuse or explicit user
  approval (`/skills`) via the `skill_verify` tool; only verified skills are
  advertised and injected.
- Verified skills materialize as `agents/<name>/skills/<slug>/SKILL.md`
  (frontmatter `name` must match the directory, per opencode's validation),
  symlinked into `~/.config/opencode/skills/` by `openark install` —
  retrieval is native. Drafts are not linked.
- Skills are compositional: the distillation prompt lists existing skills so
  new ones can reference them by name.

## channels (cross-module)

- An agent pushes a memory/lesson into `channels/<name>/items.jsonl` with its
  own name as provenance; subscribers merge channel memory items after
  private memory in recall (lessons are not merged into recall).
- Subscriptions live in `agent.json` and are audited on every change; users
  audit what flows between agents.
- Tools: `channel_share`, `channel_items`, `channel_subscribe` (powers
  `/channel`); channel memory carries `(shared by <agent>)` provenance in
  injections.

## model routing (service-wide)

- `openark.json` maps tasks (`extraction`, `reflection`, `distillation`,
  `persona_update`, `embeddings`) to either `{inherit: main|small}` —
  resolved from the opencode config + auth — or an explicit
  provider/model/base_url/api_key_env.
- Missing route = the feature degrades to a documented no-op, never a
  broken session.
