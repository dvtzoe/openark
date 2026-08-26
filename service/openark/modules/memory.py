import logging
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from ..core.llm import LlmUnavailable, TaskRunner, resolve_route
from ..core.models import MemoryItem
from ..core.prompts import PromptSpec, load_prompt, render
from ..core.registry import AgentRegistry

logger = logging.getLogger(__name__)

os.environ.setdefault("MEM0_TELEMETRY", "False")

DEFAULT_EMBEDDER_MODEL = "BAAI/bge-small-en-v1.5"
MAX_FACTS_PER_INGEST = 50


def _importable(*modules: str) -> bool:
    import importlib.util

    return all(importlib.util.find_spec(m) is not None for m in modules)


def memory_dependencies_installed() -> bool:
    return _importable("mem0", "chromadb", "fastembed")


class MemoryStore(Protocol):
    def add(
        self, agent: str, text: str, metadata: dict[str, Any], infer: bool
    ) -> dict[str, Any] | None: ...

    def search(self, agent: str, query: str, limit: int) -> list[dict[str, Any]]: ...

    def list(self, agent: str, limit: int) -> list[dict[str, Any]]: ...


class Mem0Store:
    """Embedded Mem0 (chroma file store, local fastembed embedder) per agent."""

    def __init__(
        self, data_dir: Path, llm_config: dict[str, Any] | None, embedder_config: dict[str, Any]
    ):
        from mem0 import Memory

        config: dict[str, Any] = {
            "vector_store": {
                "provider": "chroma",
                "config": {
                    "path": str(data_dir / "chroma"),
                    "collection_name": f"openark-{data_dir.parent.name}",
                },
            },
            "embedder": embedder_config,
            "llm": llm_config or _placeholder_llm_config(),
        }
        self._memory = Memory.from_config(config)

    def add(self, agent, text, metadata, infer):
        result = self._memory.add(text, user_id=agent, infer=infer, metadata=metadata)
        results = result.get("results") if isinstance(result, dict) else None
        if not results:
            return None
        return results[0]

    def search(self, agent, query, limit):
        result = self._memory.search(query, filters={"user_id": agent}, top_k=limit)
        return result.get("results", []) if isinstance(result, dict) else []

    def list(self, agent, limit):
        result = self._memory.get_all(filters={"user_id": agent}, top_k=limit)
        return result.get("results", []) if isinstance(result, dict) else []


def _placeholder_llm_config() -> dict[str, Any]:
    return {"provider": "openai", "config": {"model": "unused", "api_key": "unused"}}


class Mem0StoreFactory:
    """Builds and caches one Mem0Store per agent home."""

    def __init__(self):
        self._stores: dict[Path, Mem0Store] = {}

    def __call__(self, agent_home: Path) -> Mem0Store:
        store = self._stores.get(agent_home)
        if store is None:
            store = Mem0Store(agent_home / "data", self._llm_config(), self._embedder_config())
            self._stores[agent_home] = store
        return store

    def _llm_config(self) -> dict[str, Any] | None:
        try:
            route = resolve_route("extraction")
        except Exception:
            return None
        return route.mem0_llm_config() if route else None

    def _embedder_config(self) -> dict[str, Any]:
        try:
            route = resolve_route("embeddings")
        except Exception:
            route = None
        if route is not None and route.kind == "openai":
            return {
                "provider": "openai",
                "config": {
                    "model": route.model,
                    "api_key": route.api_key,
                    "openai_base_url": route.base_url,
                },
            }
        return {"provider": "fastembed", "config": {"model": DEFAULT_EMBEDDER_MODEL}}


class MemoryModule:
    name = "memory"

    def __init__(
        self,
        store_factory: Callable[[Path], MemoryStore] | None = None,
        runner: TaskRunner | None = None,
        prompts_dir: Path | None = None,
    ):
        self._runner = runner
        self._store_factory = store_factory or Mem0StoreFactory()
        self._prompts_dir = prompts_dir
        self._extraction_prompt: PromptSpec | None = None

    def ready(self, registry: AgentRegistry) -> bool:
        return memory_dependencies_installed()

    def _store(self, agent_home: Path) -> MemoryStore:
        return self._store_factory(agent_home)

    def _llm_available(self) -> bool:
        return self._runner is not None and self._runner.available("extraction")

    def _extraction(self) -> PromptSpec:
        if self._extraction_prompt is None:
            self._extraction_prompt = load_prompt("extraction", self._prompts_dir)
        return self._extraction_prompt

    def recall(
        self, agent_home: Path, agent: str, q: str = "", limit: int = 10
    ) -> list[MemoryItem]:
        store = self._store(agent_home)
        try:
            if q.strip():
                pool = store.search(agent, q.strip(), limit=limit * 3)
                results = _keyword_rerank(q, pool, limit)
            else:
                results = store.list(agent, limit=limit)
        except Exception as err:
            logger.warning("recall failed for %s: %s", agent, err)
            return []
        return [
            MemoryItem(
                id=str(r.get("id", "")),
                text=str(r.get("memory", "")),
                score=float(r.get("score") or 0.0),
            )
            for r in results
        ]

    def add(
        self, agent_home: Path, agent: str, text: str, project: str | None = None
    ) -> dict[str, Any] | None:
        store = self._store(agent_home)
        metadata = {"source": "manual"}
        if project:
            metadata["project"] = project
        infer = self._llm_available()
        return store.add(agent, text, metadata, infer=infer)

    def ingest(
        self, agent_home: Path, agent: str, conversation: str, project: str | None = None
    ) -> dict[str, Any]:
        if not self._llm_available():
            return {"added": 0, "facts": [], "reason": "no-model"}
        prompt = render(
            self._extraction(), conversation=conversation.strip() or "(empty conversation)"
        )
        try:
            output = self._runner.complete("extraction", prompt) if self._runner else ""
        except LlmUnavailable as err:
            return {"added": 0, "facts": [], "reason": f"no-model: {err}"}
        except Exception as err:
            logger.warning("extraction failed: %s", err)
            return {"added": 0, "facts": [], "reason": "llm-error"}
        facts = _parse_facts(output)
        if not facts:
            return {"added": 0, "facts": [], "reason": "no-facts"}
        store = self._store(agent_home)
        metadata = {"source": "extraction"}
        if project:
            metadata["project"] = project
        try:
            result = store.add(agent, facts, metadata, infer=True)
        except Exception as err:
            logger.warning("memory ingest write failed for %s: %s", agent, err)
            return {"added": 0, "facts": facts, "reason": "store-error"}
        added = len(result.get("results", [])) if isinstance(result, dict) else 1
        return {"added": added, "facts": facts}


def _parse_facts(output: str) -> list[str]:
    facts = []
    for line in output.splitlines():
        fact = line.strip().lstrip("-").strip()
        if fact:
            facts.append(fact)
    return facts[:MAX_FACTS_PER_INGEST]


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) > 2}


def _keyword_rerank(query: str, results: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    query_tokens = _tokens(query)
    if not query_tokens:
        return results[:limit]

    def boost(item: dict[str, Any]) -> float:
        overlap = len(query_tokens & _tokens(str(item.get("memory", ""))))
        return overlap + float(item.get("score") or 0.0)

    return sorted(results, key=boost, reverse=True)[:limit]
