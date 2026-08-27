import { z } from "zod";

// Shared building blocks for parsing a module tool's `args:
// Record<string, unknown>` once, at the top of `execute`, instead of each
// tool hand-rolling its own typeof/Array.isArray checks (READABILITY.md
// §5, "parse at the boundary"; see docs/plans/0003-findings-plugin-
// modules.md #2). Each builder replicates the exact leniency the ad hoc
// checks it replaces already had — a non-string becomes "", a malformed
// array element is dropped rather than rejecting the whole call — so this
// is a consolidation, not a behavior change.

/** A string arg that must be non-empty after trimming; a non-string input
 * is treated as empty rather than a distinct error, matching every
 * hand-rolled check this replaces. */
export function requiredString(message: string) {
  return z
    .unknown()
    .transform((v) => (typeof v === "string" ? v : ""))
    .pipe(z.string().trim().min(1, message));
}

/** An array arg where non-string or blank elements are silently dropped
 * (not an error) — callers that need "at least one item survives" add
 * their own `.refine()` on top, since the required-non-empty rule differs
 * per tool (e.g. reflect's failures/messages only require the pair
 * together, not each field alone). */
export function filteredStringArray() {
  return z
    .array(z.unknown())
    .catch([])
    .transform((arr) =>
      arr.filter((s): s is string => typeof s === "string" && s.trim().length > 0),
    );
}
