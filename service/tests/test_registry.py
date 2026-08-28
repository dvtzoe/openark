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


# --- persona drop-in directories (persona.<base>.md.d/) ---------------------


def _write(home, relpath, content):
    path = home / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_read_persona_merges_main_then_dropins(registry):
    registry.create("defoko")
    home = registry.agent_home("defoko")
    registry.write_persona("defoko", "# main core\n", "- main bullet\n")
    _write(home, "persona.core.md.d/10-extra.md", "Always use tabs\n")
    _write(home, "persona.core.md.d/20-more.md", "Never shout\n")

    core, _ = registry.read_persona("defoko")
    assert core.index("# main core") < core.index("Always use tabs") < core.index("Never shout")
    assert "<!-- from: persona.core.md.d/10-extra.md -->" in core
    assert "<!-- from: persona.core.md.d/20-more.md -->" in core


def test_read_persona_dropin_descendants_sorted_lexicographically(registry):
    registry.create("defoko")
    home = registry.agent_home("defoko")
    _write(home, "persona.core.md.d/topics/z-last.md", "Z\n")
    _write(home, "persona.core.md.d/10-first.md", "A\n")
    _write(home, "persona.core.md.d/topics/a-mid.md", "M\n")

    core, _ = registry.read_persona("defoko")
    assert core.index("A") < core.index("M") < core.index("Z")


def test_read_persona_ignores_non_md_and_hidden_files(registry):
    registry.create("defoko")
    home = registry.agent_home("defoko")
    _write(home, "persona.core.md.d/keep.md", "Kept\n")
    _write(home, "persona.core.md.d/notes.txt", "Ignored\n")
    _write(home, "persona.core.md.d/.hidden.md", "Ignored\n")
    _write(home, "persona.core.md.d/.hidden/keep.md", "Ignored\n")

    core, _ = registry.read_persona("defoko")
    assert "Kept" in core
    assert "Ignored" not in core


def test_read_persona_dropins_without_main_file(registry):
    registry.create("defoko")
    home = registry.agent_home("defoko")
    (home / "persona.evolving.md").unlink()
    _write(home, "persona.evolving.md.d/prefs.md", "- drop-in preference\n")

    _, evolving = registry.read_persona("defoko")
    assert "drop-in preference" in evolving


def test_read_persona_without_any_source_raises(registry):
    registry.create("defoko")
    home = registry.agent_home("defoko")
    (home / "persona.core.md").unlink()
    with pytest.raises(FileNotFoundError):
        registry.read_persona("defoko")


def test_persona_fragments_unknown_base_and_agent(registry):
    registry.create("defoko")
    with pytest.raises(ValueError):
        registry.persona_fragments("defoko", "lessons.md")
    with pytest.raises(AgentNotFound):
        registry.persona_fragments("ghost", "persona.core.md")


def test_write_persona_fragment_allows_evolving_only(registry):
    registry.create("defoko")
    home = registry.agent_home("defoko")

    # Main evolving file and drop-in descendants are writable.
    registry.write_persona_fragment("defoko", home / "persona.evolving.md", "- a\n")
    deep = home / "persona.evolving.md.d" / "sub" / "topic.md"
    registry.write_persona_fragment("defoko", deep, "- b\n")
    assert deep.read_text() == "- b\n"

    # Core persona, core drop-ins, and everything outside are refused.
    with pytest.raises(ValueError):
        registry.write_persona_fragment("defoko", home / "persona.core.md", "nope")
    with pytest.raises(ValueError):
        registry.write_persona_fragment("defoko", home / "persona.core.md.d" / "x.md", "nope")
    with pytest.raises(ValueError):
        registry.write_persona_fragment("defoko", home / "lessons.md", "nope")
    with pytest.raises(ValueError):
        registry.write_persona_fragment("defoko", home / "persona.evolving.md.d" / "x.txt", "nope")
    with pytest.raises(AgentNotFound):
        registry.write_persona_fragment("ghost", home / "persona.evolving.md", "nope")


def test_create_copies_bundled_persona_dropins(registry, monkeypatch, tmp_path):
    from openark.core import registry as registry_mod

    source = tmp_path / "personas" / "boxed"
    (source / "persona.core.md.d").mkdir(parents=True)
    (source / "persona.core.md").write_text("# boxed core\n")
    (source / "persona.evolving.md").write_text("# boxed evolving\n")
    (source / "persona.core.md.d" / "10-rules.md").write_text("Stay boxed\n")
    (source / "persona.evolving.md.d").mkdir()
    (source / "persona.evolving.md.d" / "10-prefs.md").write_text("- Likes boxes\n")
    monkeypatch.setattr(registry_mod, "BUNDLED_PERSONAS", tmp_path / "personas")

    registry.create("boxed-agent", persona="boxed")
    home = registry.agent_home("boxed-agent")
    core, evolving = registry.read_persona("boxed-agent")
    assert "Stay boxed" in core
    assert "Likes boxes" in evolving
    assert (home / "persona.evolving.md.d" / "10-prefs.md").read_text() == "- Likes boxes\n"
