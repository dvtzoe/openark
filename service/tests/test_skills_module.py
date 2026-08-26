import pytest

from openark.core.registry import AgentRegistry

DISTILL_OUTPUT = (
    "name: release-checklist\n"
    "description: Run the full release verification for this repo\n"
    "\n"
    "1. Run `make lint`\n"
    "2. Run `make test`\n"
    "3. Tag the release\n"
)


class FakeRunner:
    def __init__(self, output=DISTILL_OUTPUT, fail=None, available=True):
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


@pytest.fixture()
def registry(tmp_path):
    reg = AgentRegistry(tmp_path)
    reg.ensure_layout()
    reg.create("defoko")
    return reg


def make_module(runner):
    from openark.modules.skills import SkillsModule

    return SkillsModule(runner=runner)


def test_distill_creates_draft(registry):
    runner = FakeRunner()
    module = make_module(runner)
    result = module.distill(registry, "defoko", "ran make lint, make test, tagged v1.0")
    assert result["reason"] is None
    assert result["created"]["name"] == "release-checklist"
    assert result["created"]["status"] == "draft"

    home = registry.agent_home("defoko")
    draft = home / "skills" / "drafts" / "release-checklist" / "SKILL.md"
    assert draft.exists()
    content = draft.read_text()
    assert "name: release-checklist" in content
    assert "Run `make lint`" in content

    assert module.list(home) == []
    drafts = module.list(home, include_drafts=True)
    assert [s.name for s in drafts] == ["release-checklist"]
    assert drafts[0].status == "draft"

    audit = (home / "logs" / "audit.log").read_text()
    assert "skill.draft release-checklist" in audit
    assert "Existing skills" in runner.calls[0][1]


def test_verify_moves_draft_to_skills(registry):
    module = make_module(FakeRunner())
    module.distill(registry, "defoko", "some successful trace")
    result = module.verify(registry, "defoko", "release-checklist")
    assert result == {"verified": True, "reason": None}

    home = registry.agent_home("defoko")
    assert (home / "skills" / "release-checklist" / "SKILL.md").exists()
    assert not (home / "skills" / "drafts" / "release-checklist").exists()

    verified = module.list(home)
    assert [s.name for s in verified] == ["release-checklist"]
    assert verified[0].status == "verified"

    audit = (home / "logs" / "audit.log").read_text()
    assert "skill.verify release-checklist" in audit


def test_verify_unknown_slug(registry):
    module = make_module(FakeRunner())
    assert module.verify(registry, "defoko", "ghost")["reason"] == "not-found"
    assert module.verify(registry, "defoko", "../escape")["reason"] == "invalid-slug"


def test_distill_empty_trace(registry):
    module = make_module(FakeRunner())
    assert module.distill(registry, "defoko", "   ")["reason"] == "empty-trace"


def test_distill_without_model(registry):
    module = make_module(None)
    assert module.distill(registry, "defoko", "trace")["reason"] == "no-model"


def test_distill_unparseable_output(registry):
    module = make_module(FakeRunner(output="This is not a skill format"))
    assert module.distill(registry, "defoko", "trace")["reason"] == "unparseable"


def test_distill_llm_error(registry):
    module = make_module(FakeRunner(fail=RuntimeError("boom")))
    assert module.distill(registry, "defoko", "trace")["reason"] == "llm-error"


def test_distill_slug_collisions_get_suffixes(registry):
    module = make_module(FakeRunner())
    module.distill(registry, "defoko", "trace one")
    result = module.distill(registry, "defoko", "trace two")
    assert result["created"]["name"] == "release-checklist-2"
    home = registry.agent_home("defoko")
    drafts = sorted(p.parent.name for p in (home / "skills" / "drafts").glob("*/SKILL.md"))
    assert drafts == ["release-checklist", "release-checklist-2"]


def test_distill_sanitizes_bad_names(registry):
    module = make_module(
        FakeRunner(output=DISTILL_OUTPUT.replace("release-checklist", "Bad Name!!"))
    )
    result = module.distill(registry, "defoko", "trace")
    assert result["created"]["name"] == "bad-name"
    home = registry.agent_home("defoko")
    skill = home / "skills" / "drafts" / "bad-name" / "SKILL.md"
    assert skill.exists()
    assert skill.read_text().startswith("---\nname: bad-name\n")


def test_verify_twice_conflicts(registry):
    module = make_module(FakeRunner())
    module.distill(registry, "defoko", "trace one")
    module.verify(registry, "defoko", "release-checklist")
    module.distill(registry, "defoko", "trace two")
    module.verify(registry, "defoko", "release-checklist-2")
    result = module.verify(registry, "defoko", "release-checklist-2")
    assert result["reason"] == "not-found"


def test_compositional_prompt_lists_existing_skills(registry):
    module = make_module(FakeRunner())
    module.distill(registry, "defoko", "trace one")
    runner = FakeRunner()
    module2 = make_module(runner)
    module2.distill(registry, "defoko", "trace two")
    assert "release-checklist" in runner.calls[0][1]
