from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..core.registry import AgentRegistry

MAX_CHANNEL_ITEMS = 1000
CHANNEL_NAME_RE = re.compile(r"^[a-z][a-z0-9-]*$")


def normalize_channel_name(name: str) -> str:
    cleaned = name.strip().lstrip("#").lower()
    if not CHANNEL_NAME_RE.match(cleaned):
        raise ValueError(f"invalid channel name: {name!r}")
    return cleaned


class ChannelsStore:
    """Shared memory channels: plain JSONL files under ~/.openark/channels/."""

    def __init__(self, root: Path):
        self.root = root
        self.channels_dir = root / "channels"

    def push(
        self,
        registry: AgentRegistry,
        agent: str,
        channel: str,
        text: str,
        kind: str = "memory",
    ) -> dict[str, Any]:
        channel = normalize_channel_name(channel)
        text = text.strip()
        if not text:
            raise ValueError("channel item text must not be empty")
        item = {
            "id": uuid.uuid4().hex[:12],
            "text": text,
            "kind": kind if kind in ("memory", "lesson") else "memory",
            "source_agent": agent,
            "ts": datetime.now(UTC).isoformat(),
        }
        path = self._items_path(channel)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as fh:
            fh.write(json.dumps(item) + "\n")
        self._trim(path)
        registry.audit(agent, "channel.push", f"#{channel} {item['id']}")
        return item

    def list_channel(self, channel: str) -> list[dict[str, Any]]:
        channel = normalize_channel_name(channel)
        return self._read(self._items_path(channel))

    def subscriptions(self, registry: AgentRegistry, agent: str) -> list[str]:
        manifest = registry.get(agent)
        return list(manifest.channels.subscriptions)

    def subscribe(self, registry: AgentRegistry, agent: str, channel: str) -> list[str]:
        channel = normalize_channel_name(channel)
        manifest = registry.get(agent)
        if channel not in manifest.channels.subscriptions:
            manifest.channels.subscriptions.append(channel)
            registry.save_manifest(manifest)
            registry.audit(agent, "channel.subscribe", f"#{channel}")
        return manifest.channels.subscriptions

    def unsubscribe(self, registry: AgentRegistry, agent: str, channel: str) -> list[str]:
        channel = normalize_channel_name(channel)
        manifest = registry.get(agent)
        if channel in manifest.channels.subscriptions:
            manifest.channels.subscriptions.remove(channel)
            registry.save_manifest(manifest)
            registry.audit(agent, "channel.unsubscribe", f"#{channel}")
        return manifest.channels.subscriptions

    def subscribed_items(
        self,
        registry: AgentRegistry,
        agent: str,
        q: str = "",
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for channel in self.subscriptions(registry, agent):
            for item in self.list_channel(channel):
                if item.get("kind") != "memory":
                    continue
                if q.strip() and not _matches(q, item["text"]):
                    continue
                items.append({**item, "channel": channel})
                if len(items) >= limit:
                    return items
        return items

    def _items_path(self, channel: str) -> Path:
        return self.channels_dir / channel / "items.jsonl"

    def _read(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        items = []
        for line in path.read_text().splitlines():
            if line.strip():
                try:
                    items.append(json.loads(line))
                except ValueError:
                    continue
        return items

    def _trim(self, path: Path) -> None:
        items = self._read(path)
        if len(items) > MAX_CHANNEL_ITEMS:
            kept = items[-MAX_CHANNEL_ITEMS:]
            path.write_text("".join(json.dumps(i) + "\n" for i in kept))


def _matches(q: str, text: str) -> bool:
    query_tokens = {t for t in re.findall(r"[a-z0-9]+", q.lower()) if len(t) > 2}
    if not query_tokens:
        return True
    text_tokens = set(re.findall(r"[a-z0-9]+", text.lower()))
    return bool(query_tokens & text_tokens)
