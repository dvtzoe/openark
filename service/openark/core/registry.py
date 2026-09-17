from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

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


# A persona "fragment" is one file backing a persona: the main file
# (persona.core.md / persona.evolving.md) or a drop-in under the sibling
# "<base>.d/" directory. (path, label, content) — label is the path relative
# to the agent home, used for provenance markers and audit entries.
PersonaFragment = tuple[Path, str, str]


def _iter_dropin_files(dropin_dir: Path) -> list[Path]:
    # Descendants of the .d directory, .md files only, hidden entries skipped,
    # lexicographic by relative path (systemd-style: predictable, no natural
    # sort magic — prefix files 10- and 20- to control order).
    if not dropin_dir.is_dir():
        return []
    files = [
        entry
        for entry in sorted(dropin_dir.rglob("*"))
        if entry.is_file()
        and entry.suffix == ".md"
        and not any(part.startswith(".") for part in entry.relative_to(dropin_dir).parts)
    ]
    files.sort(key=lambda p: p.relative_to(dropin_dir).as_posix())
    return files


def _merge_fragments(fragments: list[PersonaFragment]) -> str:
    # Main file first, then drop-ins, each drop-in preceded by a provenance
    # comment so injected output shows where a rule came from.
    parts: list[str] = []
    for _, label, content in fragments:
        chunk = content.strip("\n")
        if not chunk:
            continue
        if ".d/" in label:
            parts.append(f"<!-- from: {label} -->\n{chunk}")
        else:
            parts.append(chunk)
    return "\n\n".join(parts).strip() + "\n" if parts else ""


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
            except AgentNotFound as err:
                logger.warning("skipping agent %r: corrupted agent.json (%s)", entry.name, err)
        return manifests

    def get(self, name: str) -> AgentManifest:
        # Parse/IO failures surface as AgentNotFound (404) instead of an
        # unhandled 500: a hand-edited or partially-written agent.json makes
        # one agent unusable, not the whole service. The reason is logged.
        try:
            path = self.agent_home(name) / "agent.json"
        except ValueError as err:
            raise AgentNotFound(name) from err
        if not path.exists():
            raise AgentNotFound(name)
        try:
            raw = json.loads(path.read_text())
            return AgentManifest.model_validate(raw)
        except (ValueError, OSError) as err:
            logger.warning("agent %r has an unreadable agent.json: %s", name, err)
            raise AgentNotFound(name) from err

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
        source = BUNDLED_PERSONAS / persona if persona else None
        if source is not None:
            # Validate the whole bundled persona before creating anything —
            # a half-created agent home is listed but 500s on persona reads.
            missing = [
                base for base in self.PERSONA_BASES if not (source / base).is_file()
            ]
            if missing:
                raise ValueError(f"bundled persona {persona!r} is missing: {', '.join(missing)}")
        manifest = AgentManifest(
            name=name,
            description=description,
            modules=dict(DEFAULT_MODULES),
        )
        try:
            for sub in ("skills", "data", "logs"):
                (home / sub).mkdir(parents=True)
            _atomic_write_text(
                home / "agent.json", json.dumps(manifest.model_dump(), indent=2) + "\n"
            )
            if source is not None:
                (home / "persona.core.md").write_text((source / "persona.core.md").read_text())
                (home / "persona.evolving.md").write_text(
                    (source / "persona.evolving.md").read_text()
                )
                for base in self.PERSONA_BASES:
                    dropin = source / f"{base}.d"
                    if dropin.is_dir():
                        shutil.copytree(dropin, home / f"{base}.d", dirs_exist_ok=True)
            else:
                (home / "persona.core.md").write_text(CORE_TEMPLATE)
                (home / "persona.evolving.md").write_text(EVOLVING_TEMPLATE)
            (home / "lessons.md").write_text(LESSONS_TEMPLATE)
            (home / "logs" / "audit.log").write_text("")
        except BaseException:
            shutil.rmtree(home, ignore_errors=True)
            raise
        self.audit(name, "agent.create", f"persona={persona or 'default'} {description}".strip())
        return manifest

    def delete(self, name: str) -> None:
        home = self.agent_home(name)
        if not (home / "agent.json").exists():
            raise AgentNotFound(name)
        shutil.rmtree(home)

    # Bases the service knows how to compose from main file + drop-ins.
    PERSONA_BASES = ("persona.core.md", "persona.evolving.md")

    def _persona_fragments(self, home: Path, base: str) -> list[PersonaFragment]:
        # Main file first (if present), then drop-ins from "<base>.d/".
        # At least one source must exist: the main file alone is enough, so
        # is a single drop-in; no source at all is the same error as a
        # missing file has always been.
        fragments: list[PersonaFragment] = []
        main = home / base
        if main.is_file():
            fragments.append((main, base, main.read_text()))
        for path in _iter_dropin_files(home / f"{base}.d"):
            label = path.relative_to(home).as_posix()
            fragments.append((path, label, path.read_text()))
        return fragments

    def persona_fragments(self, name: str, base: str) -> list[PersonaFragment]:
        if base not in self.PERSONA_BASES:
            raise ValueError(f"unknown persona base: {base!r}")
        home = self.agent_home(name)
        if not (home / "agent.json").exists():
            raise AgentNotFound(name)
        fragments = self._persona_fragments(home, base)
        if not fragments:
            raise FileNotFoundError(home / base)
        return fragments

    def read_persona(self, name: str) -> tuple[str, str]:
        core = _merge_fragments(self.persona_fragments(name, "persona.core.md"))
        evolving = _merge_fragments(self.persona_fragments(name, "persona.evolving.md"))
        return core, evolving

    def write_persona(self, name: str, core: str, evolving: str) -> None:
        # Main files only — drop-in directories are never touched here.
        home = self.agent_home(name)
        if not (home / "agent.json").exists():
            raise AgentNotFound(name)
        _atomic_write_text(home / "persona.core.md", core)
        _atomic_write_text(home / "persona.evolving.md", evolving)

    def write_persona_fragment(self, name: str, path: Path, content: str) -> None:
        # Agent-authored writes may only land on the evolving main file or
        # inside its drop-in directory (core drop-ins are user config; the
        # core persona itself is never rewritten by the agent).
        home = self.agent_home(name)
        if not (home / "agent.json").exists():
            raise AgentNotFound(name)
        resolved = path.resolve()
        main = (home / "persona.evolving.md").resolve()
        dropin = (home / "persona.evolving.md.d").resolve()
        allowed = resolved == main or (dropin in resolved.parents and resolved.suffix == ".md")
        if not allowed:
            raise ValueError(
                f"refusing to write persona fragment outside persona.evolving.md(.d): {path}"
            )
        resolved.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(resolved, content)

    def audit(self, agent: str, action: str, detail: str = "") -> None:
        try:
            home = self.agent_home(agent)
        except ValueError:
            return
        if not home.exists():
            return
        entry = f"{datetime.now(UTC).isoformat()} {agent} {action} {detail}".strip()
        log = home / "logs" / "audit.log"
        try:
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a") as fh:
                fh.write(entry + "\n")
        except OSError as err:
            # Audit writes must never take an operation down, but losing
            # them silently would break the "audit everything" contract.
            logger.warning("audit write failed for %s: %s", agent, err)
