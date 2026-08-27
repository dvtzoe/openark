import json

import pytest

from openark.core.registry import AgentNotFound, AgentRegistry


@pytest.fixture()
def registry(tmp_path):
    reg = AgentRegistry(tmp_path)
    reg.ensure_layout()
    return reg


def test_list_skips_agent_with_invalid_json(registry):
    registry.create("good")
    bad_home = registry.agent_home("bad")
    bad_home.mkdir(parents=True)
    (bad_home / "agent.json").write_text("{not valid json")

    names = [m.name for m in registry.list()]
    assert names == ["good"]


def test_list_skips_agent_failing_validation(registry):
    registry.create("good")
    bad_home = registry.agent_home("bad")
    bad_home.mkdir(parents=True)
    # Valid JSON, but AgentManifest.name is required.
    (bad_home / "agent.json").write_text(json.dumps({"description": "no name field"}))

    names = [m.name for m in registry.list()]
    assert names == ["good"]


def test_list_returns_everything_when_all_manifests_are_valid(registry):
    registry.create("one")
    registry.create("two")
    assert sorted(m.name for m in registry.list()) == ["one", "two"]


def test_save_manifest_survives_repeated_writes(registry):
    manifest = registry.create("defoko")
    manifest.description = "updated"
    registry.save_manifest(manifest)
    assert registry.get("defoko").description == "updated"
    # No leftover temp file from the atomic write.
    leftovers = list(registry.agent_home("defoko").glob(".*.tmp"))
    assert leftovers == []


def test_save_manifest_unknown_agent(registry):
    ghost = registry.create("ghost")
    registry.delete("ghost")
    with pytest.raises(AgentNotFound):
        registry.save_manifest(ghost)
