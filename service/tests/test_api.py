import pytest
from fastapi.testclient import TestClient

from openark.app import create_app
from openark.core.config import reset_settings_cache


class FakeMemoryModule:
    def __init__(self):
        self.added: list[tuple[str, dict]] = []
        self.ingested: list[tuple[str, dict]] = []
        self.recall_results: list[dict] = []

    def ready(self, registry):
        return True

    def recall(self, agent_home, agent, q="", limit=10):
        return list(self.recall_results)

    def add(self, agent_home, agent, text, project=None):
        self.added.append((text, {"project": project}))
        return {"id": "m1", "event": "ADD"}

    def ingest(self, agent_home, agent, conversation, project=None):
        self.ingested.append((conversation, {"project": project}))
        return {"added": 1, "facts": ["User prefers vitest"]}


@pytest.fixture()
def fake_memory():
    return FakeMemoryModule()


@pytest.fixture()
def client(tmp_path, monkeypatch, fake_memory):
    monkeypatch.setenv("OPENARK_HOME", str(tmp_path / "openark"))
    reset_settings_cache()
    app = create_app()
    app.state.modules["memory"] = fake_memory
    with TestClient(app) as test_client:
        yield test_client
    reset_settings_cache()


def test_health(client):
    res = client.get("/v1/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_create_list_get_delete_agent(client, tmp_path):
    res = client.post("/v1/agents", json={"name": "chiai", "description": "mascot"})
    assert res.status_code == 201
    manifest = res.json()
    assert manifest["modules"]["memory"] is True

    names = [a["name"] for a in client.get("/v1/agents").json()]
    assert names == ["chiai"]

    got = client.get("/v1/agents/chiai")
    assert got.status_code == 200
    assert got.json()["description"] == "mascot"

    home = tmp_path / "openark" / "agents" / "chiai"
    audit = (home / "logs" / "audit.log").read_text()
    assert "agent.create" in audit

    assert client.delete("/v1/agents/chiai").status_code == 204
    assert client.get("/v1/agents/chiai").status_code == 404


def test_create_duplicate_agent_conflicts(client):
    client.post("/v1/agents", json={"name": "chiai"})
    res = client.post("/v1/agents", json={"name": "chiai"})
    assert res.status_code == 409


def test_invalid_agent_name_rejected(client):
    res = client.post("/v1/agents", json={"name": "../escape"})
    assert res.status_code == 400


def test_get_persona_seeded(client):
    client.post("/v1/agents", json={"name": "chiai"})
    res = client.get("/v1/agents/chiai/persona")
    assert res.status_code == 200
    assert "Core persona" in res.json()["core"]


def test_memory_endpoints(client, fake_memory):
    client.post("/v1/agents", json={"name": "chiai"})
    assert client.get("/v1/agents/chiai/memory/recall").json()["memories"] == []

    fake_memory.recall_results = [{"id": "m1", "text": "likes neovim", "score": 0.9}]
    res = client.get("/v1/agents/chiai/memory/recall?q=editor")
    assert res.json()["memories"][0]["text"] == "likes neovim"

    res = client.post(
        "/v1/agents/chiai/memory", json={"text": "likes neovim", "project": "openark"}
    )
    assert res.status_code == 201
    assert res.json() == {"id": "m1", "event": "ADD"}
    assert fake_memory.added == [("likes neovim", {"project": "openark"})]

    res = client.post(
        "/v1/agents/chiai/memory/ingest", json={"text": "user: I use neovim", "project": "openark"}
    )
    assert res.status_code == 200
    assert res.json()["added"] == 1
    assert res.json()["facts"] == ["User prefers vitest"]


def test_memory_unknown_agent_404(client):
    assert client.get("/v1/agents/ghost/memory/recall").status_code == 404
    assert client.post("/v1/agents/ghost/memory", json={"text": "x"}).status_code == 404
    assert client.post("/v1/agents/ghost/memory/ingest", json={"text": "x"}).status_code == 404


def test_memory_module_unready_503(client, monkeypatch):
    client.post("/v1/agents", json={"name": "chiai"})

    class Unready:
        def ready(self, registry):
            return False

    client.app.state.modules["memory"] = Unready()
    assert client.get("/v1/agents/chiai/memory/recall").status_code == 503
    assert client.post("/v1/agents/chiai/memory", json={"text": "x"}).status_code == 503
    assert client.post("/v1/agents/chiai/memory/ingest", json={"text": "x"}).status_code == 503


def test_persona_endpoints(client, monkeypatch):
    client.post("/v1/agents", json={"name": "chiai"})
    assert client.get("/v1/agents/chiai/persona").status_code == 200

    class FakePersonaModule:
        def evolve(self, registry, agent, signals, threshold=3):
            return {
                "updated": True,
                "added": ["Likes dark mode"],
                "replaced": [("old pref", "new pref")],
            }

    client.app.state.modules["persona"] = FakePersonaModule()
    res = client.post("/v1/agents/chiai/persona/evolve", json={"signals": ["a", "b", "c"]})
    assert res.status_code == 200
    body = res.json()
    assert body["updated"] is True
    assert body["added"] == ["Likes dark mode"]
    assert body["replaced"] == [{"old": "old pref", "new": "new pref"}]

    assert (
        client.post("/v1/agents/ghost/persona/evolve", json={"signals": ["a"]}).status_code == 404
    )


def test_create_agent_with_bundled_persona(client):
    res = client.post("/v1/agents", json={"name": "mascot", "persona": "chiai"})
    assert res.status_code == 201
    persona = client.get("/v1/agents/mascot/persona").json()
    assert "chiai" in persona["core"]
    assert client.post("/v1/agents", json={"name": "bad", "persona": "ghost"}).status_code == 400
    assert "chiai" in client.get("/v1/personas").json()


def test_lessons_endpoints(client, monkeypatch):
    client.post("/v1/agents", json={"name": "chiai"})

    class FakeLessonsModule:
        def __init__(self):
            self.reflected = None
            self.hits = None
            self.retired = None

        def list(self, agent_home, active_only=True):
            from openark.modules.lessons import LessonEntry

            return [LessonEntry(id="abc", rule="Run make lint", source="reflection:bash", hits=2)]

        def reflect(self, registry, agent, failures, messages=None):
            self.reflected = (failures, messages)
            return {
                "added": [
                    {
                        "id": "abc",
                        "rule": "Run make lint",
                        "status": "active",
                        "source": "reflection:bash",
                        "hits": 0,
                    }
                ],
                "skipped": 0,
            }

        def add(self, registry, agent, rule, source="manual"):
            return {
                "added": {
                    "id": "abc",
                    "rule": rule,
                    "status": "active",
                    "source": source,
                    "hits": 0,
                }
            }

        def retire(self, registry, agent, lesson_id_value):
            self.retired = lesson_id_value
            return {"retired": True}

        def register_hits(self, registry, agent, ids, session_id):
            self.hits = (ids, session_id)
            return {"counted": True, "retired": []}

    fake = FakeLessonsModule()
    client.app.state.modules["lessons"] = fake

    res = client.get("/v1/agents/chiai/lessons")
    assert res.status_code == 200
    assert res.json()["lessons"][0]["rule"] == "Run make lint"

    res = client.post(
        "/v1/agents/chiai/lessons/reflect",
        json={"failures": [{"tool": "bash", "summary": "exit 1"}], "messages": ["fix it"]},
    )
    assert res.status_code == 200
    assert res.json()["added"][0]["rule"] == "Run make lint"
    assert fake.reflected[0][0]["tool"] == "bash"

    res = client.post("/v1/agents/chiai/lessons", json={"rule": "Write tests first"})
    assert res.status_code == 201
    assert res.json()["added"]["source"] == "manual"

    res = client.post("/v1/agents/chiai/lessons/abc/retire")
    assert res.json()["retired"] is True

    res = client.post("/v1/agents/chiai/lessons/hits", json={"ids": ["abc"], "session_id": "s1"})
    assert res.json()["counted"] is True

    assert client.get("/v1/agents/ghost/lessons").status_code == 404


def test_skills_endpoints(client):
    client.post("/v1/agents", json={"name": "chiai"})

    class FakeSkillsModule:
        def __init__(self):
            self.distilled = None
            self.verified = None

        def list(self, agent_home, include_drafts=False):
            from openark.modules.skills import SkillFile

            if include_drafts:
                return [SkillFile(slug="d", name="draft-skill", description="d", status="draft")]
            return [SkillFile(slug="v", name="live-skill", description="v", status="verified")]

        def distill(self, registry, agent, trace):
            self.distilled = trace
            return {
                "created": {"name": "release-checklist", "description": "x", "status": "draft"},
                "reason": None,
            }

        def verify(self, registry, agent, slug):
            self.verified = slug
            return {"verified": True, "reason": None}

    fake = FakeSkillsModule()
    client.app.state.modules["skills"] = fake

    res = client.get("/v1/agents/chiai/skills")
    assert [s["name"] for s in res.json()["skills"]] == ["live-skill"]

    res = client.get("/v1/agents/chiai/skills?drafts=true")
    assert [s["status"] for s in res.json()["skills"]] == ["draft"]

    res = client.post("/v1/agents/chiai/skills/distill", json={"trace": "did a thing"})
    assert res.json()["created"]["status"] == "draft"
    assert fake.distilled == "did a thing"

    res = client.post("/v1/agents/chiai/skills/release-checklist/verify")
    assert res.json()["verified"] is True
    assert client.post("/v1/agents/ghost/skills/distill", json={"trace": "x"}).status_code == 404


def test_channels_and_recall_merge(client, fake_memory):
    from openark.modules.channels import ChannelsStore

    client.post("/v1/agents", json={"name": "chiai"})
    client.post("/v1/agents", json={"name": "observer"})
    store = ChannelsStore(client.app.state.registry.root)
    client.app.state.modules["channels"] = store

    res = client.post(
        "/v1/agents/chiai/channels/team",
        json={"text": "User prefers vitest over jest", "kind": "memory"},
    )
    assert res.status_code == 201
    assert res.json()["source_agent"] == "chiai"

    items = client.get("/v1/channels/team").json()
    assert items[0]["text"] == "User prefers vitest over jest"
    assert client.get("/v1/channels/bad%20name").status_code == 400

    assert client.get("/v1/agents/observer/channels").json() == []
    subs = client.post("/v1/agents/observer/channels/team/subscribe").json()
    assert subs == ["team"]

    fake_memory.recall_results = [{"id": "m1", "text": "private fact", "score": 0.9}]
    res = client.get("/v1/agents/observer/memory/recall?limit=5").json()
    texts = [m["text"] for m in res["memories"]]
    assert texts == ["private fact", "User prefers vitest over jest"]
    assert res["memories"][1]["source_agent"] == "chiai"

    res = client.get("/v1/agents/observer/memory/recall?q=deploy&limit=5").json()
    assert "User prefers vitest over jest" not in [m["text"] for m in res["memories"]]

    client.post("/v1/agents/observer/channels/team/unsubscribe")
    res = client.get("/v1/agents/observer/memory/recall?limit=5").json()
    assert [m["text"] for m in res["memories"]] == ["private fact"]

    assert client.post("/v1/agents/ghost/channels/team", json={"text": "x"}).status_code == 404


def test_openapi_contract_stable(client):
    res = client.get("/openapi.json")
    assert res.status_code == 200
    spec = res.json()
    for path in (
        "/v1/health",
        "/v1/agents",
        "/v1/agents/{name}",
        "/v1/agents/{name}/persona",
        "/v1/agents/{name}/persona/evolve",
        "/v1/personas",
        "/v1/agents/{name}/memory/recall",
        "/v1/agents/{name}/memory",
        "/v1/agents/{name}/memory/ingest",
        "/v1/agents/{name}/lessons",
        "/v1/agents/{name}/lessons/reflect",
        "/v1/agents/{name}/lessons/hits",
        "/v1/agents/{name}/skills",
        "/v1/agents/{name}/skills/distill",
    ):
        assert path in spec["paths"], f"missing {path} in API contract"
