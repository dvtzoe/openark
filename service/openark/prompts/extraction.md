---
name: extraction
version: 1
task: extraction
---

Extract durable facts from the conversation below.

Rules:
- Only facts worth remembering for weeks, not chatter or one-off details.
- One fact per line, plain declarative sentences.
- Skip anything the agent or user asked to forget.

Conversation:

{conversation}

Facts:
