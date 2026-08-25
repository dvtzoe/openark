---
name: persona_update
version: 1
task: persona_update
---

Propose an update to the agent's learned-preferences layer.

Current preferences:

{current}

New signals from the conversation:

{signals}

Rules:
- Output only lines that should be ADDED or REPLACED (prefix replaced lines
  with "- replaces: <existing line>").
- Only include preferences supported by at least {threshold} distinct signals.
- Never output personality traits — preferences about the user and workflow only.

Proposed updates:
