import pytest

from openark.core.models import PersonaReplace
from openark.core.registry import AgentRegistry
from openark.modules.persona import PersonaModule


class FakeRunner:
    def __init__(self, output="", fail=None, available=True):
        self.output = output
        self.fail = fail
        self._available = available
        self.calls = []

    def available(self, task, preferred=None):
        return self._available

    def complete(self, task, prompt, preferred=None):
        self.calls.append((task, prompt))
        if self.fail:
            raise self.fail
        return self.output


EVOLVING = """# defoko — learned preferences

Managed by defoko. Every change is appended to logs/audit.log.

- Prefers concise answers
- Works mainly in TypeScript
"""


@pytest.fixture()
def registry(tmp_path):
    reg = AgentRegistry(tmp_path)
    reg.ensure_layout()
    reg.create("defoko")
    reg.write_persona("defoko", "# core", EVOLVING)
    return reg


def make_module(runner):
    return PersonaModule(runner=runner)


def test_evolve_below_threshold_is_rejected(registry):
    module = make_module(FakeRunner())
    result = module.evolve(registry, "defoko", ["one signal", "one signal", "  "])
    assert result.updated is False
    assert result.reason == "below-threshold"


def test_evolve_without_model_is_noop(registry):
    module = make_module(None)
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.updated is False
    assert result.reason == "no-model"


def test_evolve_with_unavailable_route_is_noop(registry):
    module = make_module(FakeRunner(available=False))
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.reason == "no-model"


def test_evolve_applies_adds_and_replaces(registry):
    runner = FakeRunner(
        output=(
            "- replaces: Prefers concise answers\n"
            "Prefers concise answers with code examples first\n"
            "Dislikes emoji in output\n"
        )
    )
    module = make_module(runner)
    result = module.evolve(registry, "defoko", ["a", "b", "c"])

    assert result.updated is True
    assert result.added == ["Dislikes emoji in output"]
    assert result.replaced == [
        PersonaReplace(
            old="Prefers concise answers",
            new="Prefers concise answers with code examples first",
        )
    ]

    _, evolving = registry.read_persona("defoko")
    assert "Prefers concise answers with code examples first" in evolving
    assert "Dislikes emoji in output" in evolving
    assert "- Prefers concise answers\n" not in evolving
    assert "Managed by defoko" in evolving

    prompt = runner.calls[0][1]
    assert "a" in prompt and "b" in prompt and "c" in prompt
    assert "- Works mainly in TypeScript" in prompt

    audit = (registry.agent_home("defoko") / "logs" / "audit.log").read_text()
    assert "persona.evolve" in audit
    assert "+ Dislikes emoji in output" in audit
    assert "~ Prefers concise answers =>" in audit


def test_evolve_no_changes(registry):
    module = make_module(FakeRunner(output=""))
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.updated is False
    assert result.reason == "no-changes"


def test_evolve_replace_without_match_is_noop(registry):
    module = make_module(FakeRunner(output="- replaces: Nonexistent preference\nSomething new\n"))
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.updated is False
    assert result.reason == "no-match"


def test_evolve_skips_duplicate_adds(registry):
    module = make_module(
        FakeRunner(output="Works mainly in TypeScript\nWorks mainly in TypeScript\n")
    )
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.updated is False
    assert result.reason == "no-match"


def test_evolve_llm_error_degrades(registry):
    module = make_module(FakeRunner(fail=RuntimeError("boom")))
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.reason == "llm-error"


def test_fuzzy_replace_matches_substring(registry):
    module = make_module(FakeRunner(output="- replaces: concise answers\nPrefers terse answers\n"))
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.updated is True
    _, evolving = registry.read_persona("defoko")
    assert "Prefers terse answers" in evolving


def test_threshold_counts_distinct_signals_only(registry):
    module = make_module(FakeRunner())
    result = module.evolve(registry, "defoko", ["same", "same", "same"])
    assert result.reason == "below-threshold"


def test_persona_files_preserved_when_no_preferences(tmp_path):
    reg = AgentRegistry(tmp_path)
    reg.ensure_layout()
    reg.create("observer")
    module = make_module(FakeRunner(output="Likes dark mode\n"))
    result = module.evolve(reg, "observer", ["a", "b", "c"])
    assert result.updated is True
    _, evolving = reg.read_persona("observer")
    assert "- Likes dark mode" in evolving


def test_bundled_defoko_persona_seeds_agent(tmp_path):
    reg = AgentRegistry(tmp_path)
    reg.ensure_layout()
    assert "defoko" in reg.bundled_personas()
    reg.create("mascot", persona="defoko")
    core, evolving = reg.read_persona("mascot")
    assert "defoko" in core
    assert "learned preferences" in evolving.lower()


def test_unknown_persona_rejected(tmp_path):
    from openark.core.registry import UnknownPersona

    reg = AgentRegistry(tmp_path)
    reg.ensure_layout()
    with pytest.raises(UnknownPersona):
        reg.create("x", persona="nope")


# --- evolving persona drop-ins (persona.evolving.md.d/) ---------------------


DROPIN = "persona.evolving.md.d/10-style.md"


def test_evolve_replaces_bullet_inside_dropin_fragment(registry):
    home = registry.agent_home("defoko")
    (home / "persona.evolving.md.d").mkdir()
    (home / DROPIN).write_text("## Style notes\n\n- Likes short code blocks\n")

    module = make_module(
        FakeRunner(output="- replaces: Likes short code blocks\nPrefers verbose code samples\n")
    )
    result = module.evolve(registry, "defoko", ["a", "b", "c"])

    assert result.updated is True
    assert result.replaced == [
        PersonaReplace(old="Likes short code blocks", new="Prefers verbose code samples")
    ]
    # The drop-in fragment is rewritten in place; the main file is untouched.
    assert (home / DROPIN).read_text() == "## Style notes\n\n- Prefers verbose code samples\n"
    assert (home / "persona.evolving.md").read_text() == EVOLVING

    audit = (home / "logs" / "audit.log").read_text()
    assert "files=persona.evolving.md.d/10-style.md" in audit


def test_evolve_adds_land_in_main_not_dropin(registry):
    home = registry.agent_home("defoko")
    (home / "persona.evolving.md.d").mkdir()
    (home / DROPIN).write_text("- Drop-in rule\n")

    module = make_module(FakeRunner(output="Dislikes loud notifications\n"))
    result = module.evolve(registry, "defoko", ["a", "b", "c"])

    assert result.updated is True
    assert result.added == ["Dislikes loud notifications"]
    assert "- Dislikes loud notifications" in (home / "persona.evolving.md").read_text()
    assert (home / DROPIN).read_text() == "- Drop-in rule\n"

    audit = (home / "logs" / "audit.log").read_text()
    assert "files=persona.evolving.md" in audit


def test_evolve_creates_main_when_only_dropins_exist(registry):
    home = registry.agent_home("defoko")
    (home / "persona.evolving.md").unlink()
    (home / "persona.evolving.md.d").mkdir()
    (home / DROPIN).write_text("- Drop-in rule\n")

    module = make_module(
        FakeRunner(output="- replaces: Drop-in rule\nUpdated drop-in rule\nKeeps sessions short\n")
    )
    result = module.evolve(registry, "defoko", ["a", "b", "c"])

    assert result.updated is True
    assert (home / DROPIN).read_text() == "- Updated drop-in rule\n"
    main = (home / "persona.evolving.md").read_text()
    assert "- Keeps sessions short" in main

    _, evolving = registry.read_persona("defoko")
    assert "Updated drop-in rule" in evolving
    assert "Keeps sessions short" in evolving


def test_evolve_never_touches_core_or_core_dropins(registry):
    home = registry.agent_home("defoko")
    registry.write_persona("defoko", "# untouchable core\n", EVOLVING)
    (home / "persona.core.md.d").mkdir()
    (home / "persona.core.md.d" / "10-config.md").write_text("User config rule\n")

    module = make_module(FakeRunner(output="Some new preference\n"))
    module.evolve(registry, "defoko", ["a", "b", "c"])

    assert (home / "persona.core.md").read_text() == "# untouchable core\n"
    assert (home / "persona.core.md.d" / "10-config.md").read_text() == "User config rule\n"


def test_evolve_ignores_prose_no_change_reply(registry):
    module = make_module(FakeRunner(output="No preference clears the threshold yet.\n"))
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.updated is False
    assert result.reason == "no-changes"
    assert registry.read_persona("defoko")[1] == EVOLVING


def test_evolve_ignores_headings_and_preambles(registry):
    module = make_module(FakeRunner(output="# Proposal\nHere's what I found:\nDislikes emoji\n"))
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.updated is True
    assert result.added == ["Dislikes emoji"]
    assert "Here's what I found" not in registry.read_persona("defoko")[1]


def test_evolve_preserves_dropin_section_order(registry):
    home = registry.agent_home("defoko")
    (home / "persona.evolving.md.d").mkdir()
    (home / DROPIN).write_text(
        "## Style\n\n- Likes short code blocks\n\n## Tools\n\n- Prefers ripgrep\n"
    )

    module = make_module(
        FakeRunner(output="- replaces: Likes short code blocks\nPrefers verbose samples\n")
    )
    result = module.evolve(registry, "defoko", ["a", "b", "c"])
    assert result.updated is True
    assert (home / DROPIN).read_text() == (
        "## Style\n\n- Prefers verbose samples\n\n## Tools\n\n- Prefers ripgrep\n"
    )
