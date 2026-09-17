import logging
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from ..core.llm import LlmUnavailable, TaskRunner, resolve_route
from ..core.models import MemoryIngestResponse, MemoryItem, MemoryMutation
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
        self, agent: str, text: str | list[dict[str, str]], metadata: dict[str, Any], infer: bool
    ) -> list[dict[str, Any]]: ...

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
        return results if isinstance(results, list) else []

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

    def __call__(self, agent_home: Path, preferred: str | None = None) -> Mem0Store:
        store = self._stores.get(agent_home)
        if store is None:
            # Built once per agent with whatever LLM/embedder route
            # resolves at first use, then cached for the life of the
            # process — rebuilding a Mem0/Chroma connection per call would
            # be wasteful. Tradeoff: changing openark.json's model routing
            # for extraction/embeddings after an agent's memory has
            # already been used has no effect until the service restarts.
            store = Mem0Store(
                agent_home / "data", self._llm_config(preferred), self._embedder_config()
            )
            self._stores[agent_home] = store
        return store

    def _llm_config(self, preferred: str | None = None) -> dict[str, Any] | None:
        try:
            route = resolve_route("extraction", preferred=preferred)
        except Exception:
            return None
        return route.mem0_llm_config() if route else None

    def _embedder_config(self) -> dict[str, Any]:
        # Deliberately ignores the selected chat model: embeddings need an
        # embedding model, and sending them to a chat-only gateway would
        # 400 every memory write. Dedicated routes come from openark.json's
        # `models.embeddings`; otherwise the local fastembed default is used.
        try:
            route = resolve_route("embeddings")
        except Exception:
            route = None
        if route is not None and route.kind == "openai":
            return {
                "provider": "openai",
                "config": {
                    "model": route.model,
                    "api_key": route.api_key or "unused",
                    "openai_base_url": route.base_url,
                },
            }
        return {"provider": "fastembed", "config": {"model": DEFAULT_EMBEDDER_MODEL}}


class MemoryModule:
    name = "memory"

    def __init__(
        self,
        store_factory: Callable[..., MemoryStore] | None = None,
        runner: TaskRunner | None = None,
        prompts_dir: Path | None = None,
    ):
        self._runner = runner
        self._store_factory = store_factory or Mem0StoreFactory()
        self._prompts_dir = prompts_dir
        self._extraction_prompt: PromptSpec | None = None

    def ready(self, registry: AgentRegistry) -> bool:
        return memory_dependencies_installed()

    def _store(self, agent_home: Path, preferred: str | None = None) -> MemoryStore:
        if preferred is None:
            return self._store_factory(agent_home)
        return self._store_factory(agent_home, preferred)

    def _llm_available(self, preferred: str | None = None) -> bool:
        return self._runner is not None and self._runner.available("extraction", preferred)

    def _infer_available(self, preferred: str | None = None) -> bool:
        """Whether mem0 may run its own extraction/consolidation call.

        mem0 builds its own OpenAI client from the route, and that client
        cannot send the x-opencode-session header opencode's gateways
        require — so mem0-side inference is only safe for direct providers.
        """
        if self._runner is None:
            return False
        try:
            route = self._runner.route("extraction", preferred)
        except Exception:
            return False
        return route is not None and route.session_id is None

    def _extraction(self) -> PromptSpec:
        if self._extraction_prompt is None:
            self._extraction_prompt = load_prompt("extraction", self._prompts_dir)
        return self._extraction_prompt

    def recall(
        self,
        agent_home: Path,
        agent: str,
        q: str = "",
        limit: int = 10,
        preferred: str | None = None,
    ) -> list[MemoryItem]:
        store = self._store(agent_home, preferred)
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
        self,
        agent_home: Path,
        agent: str,
        text: str,
        project: str | None = None,
        preferred: str | None = None,
    ) -> MemoryMutation | None:
        store = self._store(agent_home, preferred)
        metadata = {"source": "manual"}
        if project:
            metadata["project"] = project
        infer = self._infer_available(preferred)
        try:
            results = store.add(agent, text, metadata, infer=infer)
        except Exception as err:
            # Same degrade-to-no-op contract as ingest()'s store.add() call
            # below: api/v1/memory.py's add_memory already treats a None
            # result as a 502, so this fits the existing return contract
            # without needing a new error shape.
            logger.warning("memory add write failed for %s: %s", agent, err)
            return None
        if not results:
            return None
        first = results[0]
        return MemoryMutation(id=str(first.get("id", "")), event=str(first.get("event", "ADD")))

    def ingest(
        self,
        agent_home: Path,
        agent: str,
        conversation: str,
        project: str | None = None,
        preferred: str | None = None,
    ) -> MemoryIngestResponse:
        if not self._llm_available(preferred):
            return MemoryIngestResponse(reason="no-model")
        prompt = render(
            self._extraction(), conversation=conversation.strip() or "(empty conversation)"
        )
        try:
            output = (
                self._runner.complete("extraction", prompt, preferred) if self._runner else ""
            )
        except LlmUnavailable as err:
            return MemoryIngestResponse(reason=f"no-model: {err}")
        except Exception as err:
            logger.warning("extraction failed: %s", err)
            return MemoryIngestResponse(reason="llm-error")
        facts = _parse_facts(output)
        if not facts:
            return MemoryIngestResponse(reason="no-facts")
        store = self._store(agent_home, preferred)
        metadata = {"source": "extraction"}
        if project:
            metadata["project"] = project
        # Mem0 only accepts str, dict, or list[dict] input — a bare list of
        # strings crashes inside parse_messages with AttributeError. Wrap
        # each extracted fact as a user message so mem0 can store it.
        # infer=False: our extraction prompt already did the extraction, and
        # mem0's own LLM call can't carry gateway session headers.
        messages = [{"role": "user", "content": fact} for fact in facts]
        try:
            results = store.add(agent, messages, metadata, infer=False)
        except Exception as err:
            logger.warning("memory ingest write failed for %s: %s", agent, err)
            return MemoryIngestResponse(facts=facts, reason="store-error")
        return MemoryIngestResponse(added=len(results), facts=facts)


def _parse_facts(output: str) -> list[str]:
    facts = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("```"):
            continue
        fact = line.lstrip("-").strip()
        # Models often prepend a preamble ("Facts:") even when told to
        # output facts only. Skip those instead of storing them as memories.
        if fact.lower() in {"facts", "facts:", "here are the facts", "here are the facts:"}:
            continue
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
