import pytest
from fastapi.testclient import TestClient

from openark.app import create_app
from openark.core.config import reset_settings_cache


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENARK_HOME", str(tmp_path / "openark"))
    reset_settings_cache()
    app = create_app()
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


def test_stub_endpoints(client):
    client.post("/v1/agents", json={"name": "chiai"})
    assert client.get("/v1/agents/chiai/memory/recall").json()["memories"] == []
    assert client.get("/v1/agents/chiai/lessons").json()["lessons"] == []
    assert client.get("/v1/agents/chiai/skills").json()["skills"] == []
    assert client.post("/v1/agents/chiai/memory", json={"text": "x"}).status_code == 501


def test_openapi_contract_stable(client):
    res = client.get("/openapi.json")
    assert res.status_code == 200
    spec = res.json()
    for path in (
        "/v1/health",
        "/v1/agents",
        "/v1/agents/{name}",
        "/v1/agents/{name}/persona",
        "/v1/agents/{name}/memory/recall",
        "/v1/agents/{name}/lessons",
        "/v1/agents/{name}/skills",
    ):
        assert path in spec["paths"], f"missing {path} in API contract"
