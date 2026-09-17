---
name: persona_update
version: 2
task: persona_update
---

Propose an update to the agent's learned-preferences layer.

Current preferences:

{current}

New signals from the conversation:

{signals}

Rules:
- Output one change per line.
- To add a preference, output the preference as a plain line.
- To replace one, output "- replaces: <existing line>" and put the new
  preference on the next line.
- Only include preferences supported by at least {threshold} distinct signals.
- Never rewrite the core persona; only these learned preferences.
- Output nothing, or exactly NONE, if no change clears the threshold. Do not
  add explanations, headings, or summaries.
