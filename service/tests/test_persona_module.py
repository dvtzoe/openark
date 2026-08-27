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

    def available(self, task):
        return self._available

    def complete(self, task, prompt):
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
