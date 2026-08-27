from __future__ import annotations

import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from ..core.llm import LlmUnavailable, TaskRunner
from ..core.models import DistillResponse, SkillPayload, SkillVerifyResponse
from ..core.prompts import PromptSpec, load_prompt, render
from ..core.registry import AgentRegistry

logger = logging.getLogger(__name__)

SLUG_RE = re.compile(r"^[a-z][a-z0-9-]*$")


@dataclass
class SkillFile:
    slug: str
    name: str
    description: str
    status: str

    def payload(self) -> dict[str, str]:
        return {"name": self.name, "description": self.description, "status": self.status}


class SkillsModule:
    name = "skills"

    def __init__(self, runner: TaskRunner | None = None, prompts_dir: Path | None = None):
        self._runner = runner
        self._prompts_dir = prompts_dir
        self._distill_prompt: PromptSpec | None = None

    def ready(self, registry: AgentRegistry) -> bool:
        return True

    def _prompt(self) -> PromptSpec:
        if self._distill_prompt is None:
            self._distill_prompt = load_prompt("distillation", self._prompts_dir)
        return self._distill_prompt

    def list(self, agent_home: Path, include_drafts: bool = False) -> list[SkillFile]:
        skills = [
            self._read(entry, "verified")
            for entry in sorted(_skills_dir(agent_home).glob("*/SKILL.md"))
        ]
        if include_drafts:
            skills.extend(
                self._read(entry, "draft")
                for entry in sorted(_drafts_dir(agent_home).glob("*/SKILL.md"))
            )
        return [s for s in skills if s is not None]

    def distill(self, registry: AgentRegistry, agent: str, trace: str) -> DistillResponse:
        trace = trace.strip()
        if not trace:
            return DistillResponse(reason="empty-trace")
        if self._runner is None or not self._runner.available("distillation"):
            return DistillResponse(reason="no-model")

        agent_home = registry.agent_home(agent)
        existing = self.list(agent_home, include_drafts=True)
        skills_block = "\n".join(f"- {s.name}: {s.description}" for s in existing) or "(none yet)"
        prompt = render(self._prompt(), skills=skills_block, trace=trace)
        try:
            output = self._runner.complete("distillation", prompt)
        except LlmUnavailable as err:
            return DistillResponse(reason=f"no-model: {err}")
        except Exception as err:
            logger.warning("distillation failed: %s", err)
            return DistillResponse(reason="llm-error")

        parsed = _parse_skill(output)
        if parsed is None:
            return DistillResponse(reason="unparseable")
        name, description, steps = parsed
        slug = _unique_slug(agent_home, name)
        draft_dir = _drafts_dir(agent_home) / slug
        draft_dir.mkdir(parents=True, exist_ok=True)
        (draft_dir / "SKILL.md").write_text(_render_skill_md(slug, description, steps))
        registry.audit(agent, "skill.draft", f"{slug}: {description}")
        return DistillResponse(
            created=SkillPayload(name=slug, description=description, status="draft")
        )

    def verify(self, registry: AgentRegistry, agent: str, slug: str) -> SkillVerifyResponse:
        agent_home = registry.agent_home(agent)
        if not SLUG_RE.match(slug):
            return SkillVerifyResponse(verified=False, reason="invalid-slug")
        draft = _drafts_dir(agent_home) / slug
        if not (draft / "SKILL.md").exists():
            return SkillVerifyResponse(verified=False, reason="not-found")
        target = _skills_dir(agent_home) / slug
        if target.exists():
            return SkillVerifyResponse(verified=False, reason="already-verified")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(draft), str(target))
        registry.audit(agent, "skill.verify", slug)
        return SkillVerifyResponse(verified=True, reason=None)

    def _read(self, path: Path, status: str) -> SkillFile | None:
        try:
            content = path.read_text()
        except OSError as err:
            # One unreadable skill file (races with a concurrent write,
            # permissions, disk error) must not break listing every other
            # skill — same resilience shape as channels.py's per-line
            # try/except.
            logger.warning("skipping skill file %s: %s", path, err)
            return None
        frontmatter, _ = _split_frontmatter(content)
        name = frontmatter.get("name")
        description = frontmatter.get("description")
        if not name or not description:
            return None
        return SkillFile(slug=path.parent.name, name=name, description=description, status=status)


def _skills_dir(agent_home: Path) -> Path:
    return agent_home / "skills"


def _drafts_dir(agent_home: Path) -> Path:
    return agent_home / "skills" / "drafts"


def _unique_slug(agent_home: Path, name: str) -> str:
    base = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-") or "skill"
    if not SLUG_RE.match(base):
        base = "skill"
    slug = base
    counter = 2
    while (_skills_dir(agent_home) / slug).exists() or (_drafts_dir(agent_home) / slug).exists():
        slug = f"{base}-{counter}"
        counter += 1
    return slug


def _parse_skill(output: str) -> tuple[str, str, str] | None:
    name: str | None = None
    description: str | None = None
    steps_start = 0
    lines = output.strip().splitlines()
    for i, line in enumerate(lines):
        if line.startswith("name:") and name is None:
            name = line[len("name:") :].strip()
        elif line.startswith("description:") and description is None:
            description = line[len("description:") :].strip()
            steps_start = i + 1
    if not name or not description:
        return None
    steps = "\n".join(lines[steps_start:]).strip()
    if not steps:
        return None
    return name, description, steps


def _render_skill_md(name: str, description: str, steps: str) -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{steps}\n"


def _split_frontmatter(content: str) -> tuple[dict[str, str], str]:
    if not content.startswith("---"):
        return {}, content
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content
    meta: dict[str, str] = {}
    for line in parts[1].strip().splitlines():
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip()
    return meta, parts[2].strip()
