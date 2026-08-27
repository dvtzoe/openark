# What makes code readable

Research notes backing the [readability refactor](plans/0003-readability-refactor.md).
This is the checklist used to review and rewrite `openark`'s code — not a
general essay. Every principle below is something a reviewer can actually
check against a diff.

## Sources

- John Ousterhout, *A Philosophy of Software Design* — complexity, deep vs.
  shallow modules.
- "Parse, don't validate" (Alexis King and the broader TS/functional
  community) — pushing validation to the boundary so the type system carries
  the guarantee afterward.
- Program-comprehension research on cognitive load (e.g. Fakhoury et al.,
  *The Effect of Poor Source Code Lexicon and Readability on Developers'
  Cognitive Load*, ICPC 2018) — naming and structure measurably change how
  hard code is to hold in your head.
- Stack Overflow / general industry consensus on comments ("why, not what").
- This repo's own `CONTRIBUTING.md` ("No comments unless they explain a *why*
  that code cannot") and ADR 0005 (999-line file cap) — existing house rules
  that the principles below should reinforce, not contradict.

## 1. Complexity is the enemy, and it's cumulative

Ousterhout's core claim: complexity isn't one big thing, it's many small
increments — a slightly-too-clever conditional here, a parameter that means
two different things there. Each increment is individually defensible; the
sum is what makes a codebase hard to work in. Two symptoms to look for:

- **Change amplification** — a conceptually small change requires edits in
  many places (e.g. adding a field means touching five call sites because
  nothing centralizes the shape).
- **Cognitive load** — how much a reader has to hold in their head to make a
  change safely (implicit ordering requirements, global state, unclear
  ownership of a value).

When reviewing, ask: *does this increment complexity, and does it pay for
itself?* Not "is this line bad in isolation."

## 2. Deep modules over shallow ones

A module (function, class, file) is **deep** when its interface is much
simpler than its implementation — it hides real complexity behind a small
surface. It's **shallow** when the interface is nearly as complicated as
just inlining the logic — common failure modes are pass-through functions
that add a layer without hiding anything, and "config object" parameters
that leak internal structure to every caller.

Applied here: `openark`'s architecture (thin plugin, smart service, modules
behind a small `OpenArkModule`/`ServiceModule` contract) is already going
for depth at the architecture level. The refactor should check that
individual functions and classes follow the same instinct — e.g. a function
that just unpacks an object and calls another function with the same shape
is a smell; a function whose 5-line body hides real branching/error-handling
that every caller would otherwise duplicate is doing its job.

## 3. Names carry the mental model

A name is documentation that never goes stale as long as it stays accurate.
Concretely:

- Prefer a name that states what a value *is* or a function *does* over one
  that requires reading the body to disambiguate (`items` vs. `pendingRetryQueue`).
  Precision beats brevity once it's ambiguous.
- Booleans read as predicates (`isEnabled`, `hasRoute`), not bare nouns.
- Avoid encoding type or scope in the name when the type checker already
  guarantees it (no `strName`, no redundant `dataObj`).
- Consistency beats local cleverness: one word per concept across the
  codebase (don't say `fetch` in one module and `load`/`get` for the same
  kind of operation in another) — this is a cognitive-load issue, not
  bikeshedding: a reader who has learned the vocabulary in one module
  shouldn't have to relearn it in the next.

## 4. Comments explain *why*, never *what*

Directly from this repo's own `CONTRIBUTING.md`, and confirmed by outside
consensus: a comment restating the code in English is noise (worse than
nothing — it goes stale silently and then actively misleads). A comment
earns its place when it records something the code cannot express:

- A non-obvious constraint or invariant the next editor could accidentally
  break (e.g. "hit counter increments once per session — see `ctx.session`
  gating below, not per-injection").
- The reason for an unusual choice (why a retry is capped at 3, why a
  workaround exists for a specific upstream bug, why validation happens here
  and not at the caller).
- A link/reference for behavior derived from an external contract (a prompt
  file's expected shape, an API quirk).

If deleting a comment loses no information a careful reader could regenerate
from the code + type signatures, delete it.

## 5. Parse at the boundary; trust the type afterward

Data entering the system (HTTP request bodies, file reads, subprocess
output, LLM responses) should be validated/parsed exactly once, as close to
the boundary as possible, into a type that the rest of the code can then
trust completely. The alternative — re-checking "is this field present"
scattered through business logic — is both a readability tax (every
function looks defensive) and a safety gap (it's easy to forget one spot).

Applied here:
- Python: Pydantic models at the API boundary (already used in
  `core/models.py`) should be the *only* place `dict`/`Any` from the outside
  world gets shaped into something typed. Once inside a `ServiceModule`,
  functions should take/return the typed model, not raw dicts.
- TypeScript: the generated `api-types.ts` from the OpenAPI schema is the
  parse boundary between plugin and service — module code should not
  re-derive shapes by hand or reach past it with untyped `fetch` calls.
- LLM responses (the least trustworthy input in this system) need one
  explicit parse/validate step with a typed failure path — not an assumed
  well-formed JSON blob passed straight into business logic.

## 6. Errors are part of the interface, not an afterthought

Per `MODULE_SPEC.md`, this project's own principle is "failures degrade to
no-op, never a broken session." That's a correctness rule, but it's also a
readability rule: a function whose failure modes are visible in its
signature (a typed `Result`/discriminated union in TS, a specific exception
type or `None`/optional in Python — whichever the surrounding code already
uses consistently) tells the reader what can go wrong without them reading
the implementation. A function that can silently fail (swallowed exception,
untyped `catch {}`, an `Any`-typed error) hides that complexity from every
caller, who then either over-handles defensively or under-handles and
breaks in production.

When reviewing: every `catch`/`except` should either (a) handle the error
meaningfully at that level, (b) re-raise/re-throw a more specific typed
error, or (c) have a comment explaining why swallowing it here is correct
(rare, and per §4 that comment must justify the *why*).

## 7. Structure mirrors the mental model, not the implementation history

Function/file length limits (this repo already enforces 999 lines/file via
ADR 0005) are a proxy for a better question: does the structure match how a
reader would explain the system to someone else? A 40-line function that is
one linear sequence of "step 1, step 2, step 3" a reader can name is fine at
40 lines; a 15-line function doing three unrelated things behind an `if` is
worse. When splitting code, split along conceptual boundaries (the module's
own vocabulary — extraction vs. recall vs. injection, not "part 1 of the
function" vs "part 2").

## 8. Consistency lowers the cost of every future read

A codebase where similar problems are solved the same way everywhere is
readable even where any one file might not be optimal in isolation, because
the reader can transfer what they learned in file A to file B. The review
pass should flag one-off patterns (bespoke error shapes, a module that
fetches data differently from its four siblings) as readability issues even
when the code "works," because they add a permanent tax: every future
reader has to learn the exception.

## How this gets used

The audit pass (`docs/plans/0003-readability-refactor.md`) checks the
existing code against §1–8 above, plus checks conformance against
`ARCHITECTURE.md`/`DESIGN.md`/`MODULE_SPEC.md` (the documented design is the
source of truth for *intent*; code that drifts from it is itself a
readability bug, since a maintainer reading the docs would form a wrong
mental model). Findings are written up in natural language and reviewed
before any code changes are made.
