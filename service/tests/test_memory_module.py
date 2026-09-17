from pathlib import Path

from openark.core.llm import LlmUnavailable, ResolvedModel
from openark.core.models import MemoryIngestResponse
from openark.modules.memory import MemoryModule, _keyword_rerank, _parse_facts


class FakeStore:
    def __init__(self):
        self.adds: list[dict] = []
        self.searches: list[str] = []
        self.search_results: list[dict] = []
        self.listed = False
        self.list_results: list[dict] = []

    def add(self, agent, text, metadata, infer):
        self.adds.append({"agent": agent, "text": text, "metadata": metadata, "infer": infer})
        if isinstance(text, list):
            return [{"id": f"f{i}", "event": "ADD"} for i in range(len(text))]
        return [{"id": "m1", "event": "ADD"}]

    def search(self, agent, query, limit):
        self.searches.append(query)
        return self.search_results

    def list(self, agent, limit):
        self.listed = True
        return self.list_results


class FakeRunner:
    def __init__(
        self,
        output="User works in TypeScript\nUser has a dog",
        fail=None,
        available=True,
        session_id=None,
    ):
        self.output = output
        self.fail = fail
        self._available = available
        self._session_id = session_id
        self.calls: list[tuple[str, str]] = []

    def available(self, task, preferred=None):
        return self._available

    def route(self, task, preferred=None):
        if not self._available:
            return None
        return ResolvedModel(
            model="m",
            base_url="http://x/v1",
            api_key="k",
            kind="openai",
            session_id=self._session_id,
        )

    def complete(self, task, prompt, preferred=None):
        self.calls.append((task, prompt))
        if self.fail:
            raise self.fail
        return self.output


def make_module(store, runner=None):
    return MemoryModule(store_factory=lambda home, preferred=None: store, runner=runner)


HOME = Path("/tmp/openark-fake-home")


def test_recall_without_query_lists():
    store = FakeStore()
    store.list_results = [{"id": "m1", "memory": "likes neovim", "score": 0.7}]
    module = make_module(store)
    items = module.recall(HOME, "defoko", q="", limit=5)
    assert store.listed
    assert [(i.id, i.text, i.score) for i in items] == [("m1", "likes neovim", 0.7)]


def test_recall_with_query_searches_and_reranks():
    store = FakeStore()
    store.search_results = [
        {"id": "a", "memory": "User has a dog", "score": 0.9},
        {"id": "b", "memory": "User deploys with vercel", "score": 0.5},
    ]
    module = make_module(store)
    items = module.recall(HOME, "defoko", q="deploy with vercel", limit=1)
    assert store.searches == ["deploy with vercel"]
    assert [i.id for i in items] == ["b"]


def test_add_stores_with_source_manual():
    store = FakeStore()
    module = make_module(store, runner=FakeRunner())
    result = module.add(HOME, "defoko", "likes neovim", project="openark")
    assert result is not None
    assert result.id == "m1"
    assert store.adds[0]["metadata"] == {"source": "manual", "project": "openark"}
    assert store.adds[0]["infer"] is True


def test_add_without_llm_uses_infer_false():
    store = FakeStore()
    module = make_module(store, runner=None)
    module.add(HOME, "defoko", "likes neovim")
    assert store.adds[0]["infer"] is False


def test_add_with_unavailable_route_uses_infer_false():
    store = FakeStore()
    runner = FakeRunner(available=False)
    module = make_module(store, runner=runner)
    module.add(HOME, "defoko", "likes neovim")
    assert store.adds[0]["infer"] is False


def test_add_store_write_error_degrades_to_none():
    store = FakeStore()
    store.add = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))  # type: ignore[assignment]
    module = make_module(store, runner=FakeRunner())
    assert module.add(HOME, "defoko", "likes neovim") is None


def test_ingest_with_unavailable_route_is_noop():
    store = FakeStore()
    runner = FakeRunner(available=False)
    module = make_module(store, runner=runner)
    result = module.ingest(HOME, "defoko", "user: hello")
    assert result == MemoryIngestResponse(added=0, facts=[], reason="no-model")
    assert runner.calls == []


def test_recall_store_error_degrades_to_empty():
    class ExplodingStore(FakeStore):
        def search(self, agent, query, limit):
            raise RuntimeError("boom")

        def list(self, agent, limit):
            raise RuntimeError("boom")

    module = make_module(ExplodingStore())
    assert module.recall(HOME, "defoko", q="x") == []
    assert module.recall(HOME, "defoko") == []


def test_ingest_store_write_error_degrades():
    store = FakeStore()
    original_add = store.add
    store.add = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))  # type: ignore[assignment]
    module = make_module(store, runner=FakeRunner())
    result = module.ingest(HOME, "defoko", "user: hi")
    assert result.reason == "store-error"
    assert result.facts
    store.add = original_add


def test_ingest_extracts_and_batches_facts():
    store = FakeStore()
    runner = FakeRunner()
    module = make_module(store, runner=runner)
    result = module.ingest(HOME, "defoko", "user: I love vitest", project="openark")
    assert result.added == 2
    assert result.facts == ["User works in TypeScript", "User has a dog"]
    assert runner.calls[0][0] == "extraction"
    assert "I love vitest" in runner.calls[0][1]
    batch = store.adds[0]
    assert batch["text"] == [
        {"role": "user", "content": "User works in TypeScript"},
        {"role": "user", "content": "User has a dog"},
    ]
    assert batch["metadata"] == {"source": "extraction", "project": "openark"}
    assert batch["infer"] is False


def test_ingest_reports_persisted_count_from_store():
    class NoopStore(FakeStore):
        def add(self, agent, text, metadata, infer):
            self.adds.append({"agent": agent, "text": text, "metadata": metadata, "infer": infer})
            return []

    store = NoopStore()
    module = make_module(store, runner=FakeRunner())
    result = module.ingest(HOME, "defoko", "user: I love vitest")
    assert result.added == 0
    assert result.facts == ["User works in TypeScript", "User has a dog"]


def test_ingest_without_llm_is_noop():
    store = FakeStore()
    module = make_module(store, runner=None)
    result = module.ingest(HOME, "defoko", "user: I love vitest")
    assert result.added == 0
    assert store.adds == []


def test_ingest_llm_unavailable_degrades():
    store = FakeStore()
    module = make_module(store, runner=FakeRunner(fail=LlmUnavailable("no route")))
    result = module.ingest(HOME, "defoko", "user: hi")
    assert result.added == 0
    assert result.reason and result.reason.startswith("no-model")


def test_ingest_llm_error_degrades():
    store = FakeStore()
    module = make_module(store, runner=FakeRunner(fail=RuntimeError("boom")))
    result = module.ingest(HOME, "defoko", "user: hi")
    assert result == MemoryIngestResponse(added=0, facts=[], reason="llm-error")


def test_ingest_no_facts():
    store = FakeStore()
    module = make_module(store, runner=FakeRunner(output=""))
    result = module.ingest(HOME, "defoko", "user: hi")
    assert result.reason == "no-facts"


def test_parse_facts_strips_bullets_and_caps():
    assert _parse_facts("- User likes tea\n  \nUser has a cat\n") == [
        "User likes tea",
        "User has a cat",
    ]


def test_parse_facts_skips_model_preambles():
    output = "Facts:\n- User likes tea\n# Notes\n```\n1. User has a cat\n"
    assert _parse_facts(output) == ["User likes tea", "1. User has a cat"]


def test_parse_facts_caps_at_50():
    assert len(_parse_facts("\n".join(f"fact {i}" for i in range(100)))) == 50


def test_keyword_rerank_boosts_overlap():
    results = [
        {"id": "a", "memory": "unrelated text entirely", "score": 0.9},
        {"id": "b", "memory": "deploy with vercel pipeline", "score": 0.4},
    ]
    assert [r["id"] for r in _keyword_rerank("deploy vercel", results, 1)] == ["b"]


def test_embedder_config_ignores_selected_chat_model(monkeypatch):
    from openark.modules.memory import Mem0StoreFactory

    calls: list[tuple[str, str | None]] = []

    def fake_resolve(task, preferred=None):
        calls.append((task, preferred))
        return None

    monkeypatch.setattr("openark.modules.memory.resolve_route", fake_resolve)
    config = Mem0StoreFactory()._embedder_config()
    assert config["provider"] == "fastembed"
    assert calls == [("embeddings", None)]


def test_infer_enabled_for_direct_routes():
    module = make_module(FakeStore(), runner=FakeRunner())
    assert module._infer_available() is True


def test_infer_disabled_for_gateway_routes():
    module = make_module(FakeStore(), runner=FakeRunner(session_id="openark-background"))
    assert module._infer_available("opencode-go/deepseek-v4.1-flash") is False
