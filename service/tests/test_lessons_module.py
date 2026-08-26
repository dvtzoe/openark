import pytest

from openark.core.registry import AgentRegistry
from openark.modules.lessons import (
    RETIRE_AFTER_STALE_SESSIONS,
    LessonEntry,
    lesson_id,
    normalize_rule,
)


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


RULES_OUTPUT = (
    "1. FAILURE: tests failed\n2. ROOT CAUSE: forgot to run linter\n"
    "3. RULE: Run `make lint` before every commit\n"
    "RULE: Never force-push to main\n"
)


@pytest.fixture()
def registry(tmp_path):
    reg = AgentRegistry(tmp_path)
    reg.ensure_layout()
    reg.create("defoko")
    return reg


def make_module(runner):
    from openark.modules.lessons import LessonsModule

    return LessonsModule(runner=runner)


def test_list_empty(registry):
    module = make_module(FakeRunner())
    assert module.list(registry.agent_home("defoko")) == []


def test_reflect_adds_rules_with_provenance(registry):
    runner = FakeRunner(output=RULES_OUTPUT)
    module = make_module(runner)
    result = module.reflect(
        registry,
        "defoko",
        failures=[{"tool": "bash", "summary": "exit 1: lint errors"}],
        messages=["no, use ruff not black"],
    )
    assert result.get("reason") is None
    rules = [e["rule"] for e in result["added"]]
    assert rules == ["Run `make lint` before every commit", "Never force-push to main"]
    assert all(e["source"] == "reflection:bash" for e in result["added"])

    entries = module.list(registry.agent_home("defoko"))
    assert len(entries) == 2
    assert entries[0].source == "reflection:bash"

    audit = (registry.agent_home("defoko") / "logs" / "audit.log").read_text()
    assert "lesson.add" in audit
    assert "Run `make lint` before every commit" in audit

    prompt = runner.calls[0][1]
    assert "exit 1: lint errors" in prompt
    assert "no, use ruff not black" in prompt


def test_reflect_correction_only_uses_correction_source(registry):
    module = make_module(FakeRunner(output="RULE: Ask before deleting files\n"))
    result = module.reflect(
        registry, "defoko", failures=[], messages=["don't delete without asking"]
    )
    assert result["added"][0]["source"] == "reflection:correction"


def test_reflect_nothing_to_reflect(registry):
    module = make_module(FakeRunner())
    result = module.reflect(registry, "defoko", failures=[], messages=[])
    assert result["reason"] == "nothing-to-reflect"


def test_reflect_without_model(registry):
    module = make_module(None)
    result = module.reflect(registry, "defoko", failures=[{"tool": "bash", "summary": "x"}])
    assert result["reason"] == "no-model"


def test_reflect_no_rules_extracted(registry):
    module = make_module(FakeRunner(output="nothing generalizes here"))
    result = module.reflect(registry, "defoko", failures=[{"tool": "bash", "summary": "x"}])
    assert result["reason"] == "no-rules"


def test_reflect_dedupes_existing_rules(registry):
    module = make_module(FakeRunner(output="RULE: Run `make lint` before every commit\n"))
    module.add(registry, "defoko", "Run `make lint` before every commit")
    result = module.reflect(registry, "defoko", failures=[{"tool": "bash", "summary": "x"}])
    assert result["added"] == []
    assert result["skipped"] == 1
    assert result["reason"] == "duplicate"
    assert len(module.list(registry.agent_home("defoko"))) == 1


def test_reflect_reinstates_retired_rules(registry):
    module = make_module(FakeRunner(output="RULE: Run `make lint` before every commit\n"))
    module.add(registry, "defoko", "Run `make lint` before every commit")
    entry_id = lesson_id("Run `make lint` before every commit")
    module.retire(registry, "defoko", entry_id)

    result = module.reflect(registry, "defoko", failures=[{"tool": "bash", "summary": "x"}])
    assert len(result["added"]) == 1
    entries = module.list(registry.agent_home("defoko"), active_only=False)
    assert entries[0].status == "active"


def test_add_manual_lesson(registry):
    module = make_module(FakeRunner())
    result = module.add(registry, "defoko", "Always write tests first")
    assert result["added"]["source"] == "manual"
    duplicate = module.add(registry, "defoko", "Always write tests first")
    assert duplicate["reason"] == "duplicate"


def test_retire_unknown_lesson(registry):
    module = make_module(FakeRunner())
    assert module.retire(registry, "defoko", "deadbeef")["reason"] == "not-found"


def test_hits_lifecycle_and_retirement(registry):
    module = make_module(FakeRunner())
    module.add(registry, "defoko", "Keep it simple")
    popular_id = lesson_id("Keep it simple")
    module.add(registry, "defoko", "Never used")
    unused_id = lesson_id("Never used")

    result = module.register_hits(registry, "defoko", [popular_id], "s1")
    assert result["counted"] is True
    assert result["retired"] == []

    again = module.register_hits(registry, "defoko", [popular_id], "s1")
    assert again["counted"] is False

    for i in range(RETIRE_AFTER_STALE_SESSIONS):
        module.register_hits(registry, "defoko", [popular_id], f"s{i + 2}")

    entries = {e.id: e for e in module.list(registry.agent_home("defoko"), active_only=False)}
    assert entries[popular_id].status == "active"
    assert entries[popular_id].hits == RETIRE_AFTER_STALE_SESSIONS + 1
    assert entries[unused_id].status == "retired"

    audit = (registry.agent_home("defoko") / "logs" / "audit.log").read_text()
    assert "lesson.retire" in audit


def test_lessons_file_roundtrip(registry, tmp_path):
    from openark.modules.lessons import _parse, _write

    path = registry.agent_home("defoko") / "lessons.md"
    parsed = _parse(path)
    parsed.lessons.append(LessonEntry(id="abc", rule="Rule one", source="manual", hits=2, stale=1))
    parsed.lessons.append(
        LessonEntry(id="def", rule="Rule two", status="retired", source="reflection:bash")
    )
    _write(path, parsed)

    reparsed = _parse(path)
    assert [e.id for e in reparsed.lessons] == [lesson_id("Rule one"), lesson_id("Rule two")]
    assert reparsed.lessons[0].hits == 2
    assert reparsed.lessons[0].stale == 1
    assert reparsed.lessons[1].status == "retired"
    assert "# Lessons" in "\n".join(reparsed.header)


def test_normalize_rule_ignores_punctuation():
    assert normalize_rule("Run `make lint`!") == normalize_rule("run make lint")


def test_reflect_llm_error_degrades(registry):
    module = make_module(FakeRunner(fail=RuntimeError("boom")))
    result = module.reflect(registry, "defoko", failures=[{"tool": "bash", "summary": "x"}])
    assert result["reason"] == "llm-error"
