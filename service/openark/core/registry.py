from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError

from ..core.models import AgentManifest

logger = logging.getLogger(__name__)

BUNDLED_PERSONAS = Path(__file__).parent.parent / "personas"

DEFAULT_MODULES = {
    "memory": True,
    "personality": True,
    "reflection": True,
    "skills": True,
}

CORE_TEMPLATE = """# Core persona

This file is yours. The agent never rewrites it — describe who they are,
how they talk, and what they care about. See personas/ in the openark repo
for a full example (defoko).
"""

EVOLVING_TEMPLATE = """# Learned preferences

Managed by the agent. Every change is appended to logs/audit.log.
Preference updates only land here after crossing a confidence threshold.
"""

LESSONS_TEMPLATE = """# Lessons

Rules this agent learned from failures and corrections.
Format: "- [status] rule (source: X, hits: N, stale: M)" — managed by openark.
"""


def _atomic_write_text(path: Path, content: str) -> None:
    # write-to-temp-then-rename so a crash or kill mid-write can't leave a
    # torn agent.json for list()/get() to trip over later (os.replace is
    # atomic on the same filesystem, which the temp file is by construction).
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(content)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


class AgentNotFound(KeyError):
    pass


class AgentAlreadyExists(ValueError):
    pass


class UnknownPersona(ValueError):
    pass


class AgentRegistry:
    def __init__(self, root: Path):
        self.root = root
        self.agents_dir = root / "agents"
        self.channels_dir = root / "channels"

    def ensure_layout(self) -> None:
        self.agents_dir.mkdir(parents=True, exist_ok=True)
        self.channels_dir.mkdir(parents=True, exist_ok=True)

    def agent_home(self, name: str) -> Path:
        if not name or "/" in name or name.startswith("."):
            raise ValueError(f"invalid agent name: {name!r}")
        return self.agents_dir / name

    def exists(self, name: str) -> bool:
        return (self.agent_home(name) / "agent.json").exists()

    def list(self) -> list[AgentManifest]:
        # One agent with a corrupted agent.json must not take the rest of
        # the list down with it (ADR 0004: "one polluted agent cannot
        # poison everyone") — skip and log rather than propagating.
        manifests = []
        if not self.agents_dir.exists():
            return manifests
        for entry in sorted(self.agents_dir.iterdir()):
            if not (entry / "agent.json").exists():
                continue
            try:
                manifests.append(self.get(entry.name))
            except (json.JSONDecodeError, ValidationError) as err:
                logger.warning("skipping agent %r: corrupted agent.json (%s)", entry.name, err)
        return manifests

    def get(self, name: str) -> AgentManifest:
        path = self.agent_home(name) / "agent.json"
        if not path.exists():
            raise AgentNotFound(name)
        raw = json.loads(path.read_text())
        return AgentManifest.model_validate(raw)

    def save_manifest(self, manifest: AgentManifest) -> None:
        path = self.agent_home(manifest.name) / "agent.json"
        if not path.exists():
            raise AgentNotFound(manifest.name)
        _atomic_write_text(path, json.dumps(manifest.model_dump(), indent=2) + "\n")

    def bundled_personas(self) -> list[str]:
        if not BUNDLED_PERSONAS.exists():
            return []
        return sorted(
            entry.name
            for entry in BUNDLED_PERSONAS.iterdir()
            if (entry / "persona.core.md").is_file()
        )

    def create(
        self,
        name: str,
        description: str = "An openark agent",
        persona: str | None = None,
    ) -> AgentManifest:
        home = self.agent_home(name)
        if home.exists():
            raise AgentAlreadyExists(name)
        if persona is not None and persona not in self.bundled_personas():
            raise UnknownPersona(persona)
        manifest = AgentManifest(
            name=name,
            description=description,
            modules=dict(DEFAULT_MODULES),
        )
        for sub in ("skills", "data", "logs"):
            (home / sub).mkdir(parents=True)
        _atomic_write_text(home / "agent.json", json.dumps(manifest.model_dump(), indent=2) + "\n")
        if persona:
            source = BUNDLED_PERSONAS / persona
            (home / "persona.core.md").write_text((source / "persona.core.md").read_text())
            (home / "persona.evolving.md").write_text((source / "persona.evolving.md").read_text())
        else:
            (home / "persona.core.md").write_text(CORE_TEMPLATE)
            (home / "persona.evolving.md").write_text(EVOLVING_TEMPLATE)
        (home / "lessons.md").write_text(LESSONS_TEMPLATE)
        (home / "logs" / "audit.log").write_text("")
        self.audit(name, "agent.create", f"persona={persona or 'default'} {description}".strip())
        return manifest

    def delete(self, name: str) -> None:
        home = self.agent_home(name)
        if not (home / "agent.json").exists():
            raise AgentNotFound(name)
        shutil.rmtree(home)

    def read_persona(self, name: str) -> tuple[str, str]:
        home = self.agent_home(name)
        if not (home / "agent.json").exists():
            raise AgentNotFound(name)
        core = (home / "persona.core.md").read_text()
        evolving = (home / "persona.evolving.md").read_text()
        return core, evolving

    def write_persona(self, name: str, core: str, evolving: str) -> None:
        home = self.agent_home(name)
        if not (home / "agent.json").exists():
            raise AgentNotFound(name)
        (home / "persona.core.md").write_text(core)
        (home / "persona.evolving.md").write_text(evolving)

    def audit(self, agent: str, action: str, detail: str = "") -> None:
        home = self.agent_home(agent)
        entry = f"{datetime.now(UTC).isoformat()} {agent} {action} {detail}".strip()
        log = home / "logs" / "audit.log"
        if log.exists():
            with log.open("a") as fh:
                fh.write(entry + "\n")
