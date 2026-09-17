---
name: reflection
version: 2
task: reflection
---

You are reflecting on failures to extract durable lessons.

For each failure, state:
1. SPECIFIC failure point (not "it didn't work")
2. ROOT CAUSE (why it failed)
3. A CONCRETE rule that would have prevented it

Then emit each rule as a single line prefixed "RULE: ".
Also scan the user messages for corrections of the agent's behavior; each
correction becomes a rule the same way.

Rules already learned (do not restate; re-emit a retired rule only if it
clearly recurs):
{lessons}

Only emit rules that generalize beyond this exact instance. Skip failures
that were environmental flakes or user error. If nothing generalizes, emit
no RULE lines.

Failures:

{failures}

User messages in this session (may contain corrections):

{messages}

Rules:
