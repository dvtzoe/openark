from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..core.llm import LlmUnavailable, TaskRunner
from ..core.models import (
    LessonAddResponse,
    LessonHitsResponse,
    LessonPayload,
    LessonRetireResponse,
    ReflectResponse,
)
from ..core.prompts import PromptSpec, load_prompt, render
from ..core.registry import AgentRegistry

logger = logging.getLogger(__name__)

RETIRE_AFTER_STALE_SESSIONS = 5
MAX_REMEMBERED_SESSIONS = 50

LINE_RE = re.compile(r"^- \[(active|retired)\] (.+?) \(source: (.*?), hits: (\d+), stale: (\d+)\)$")


@dataclass
class LessonEntry:
    id: str
    rule: str
    status: str = "active"
    source: str = "reflection"
    hits: int = 0
    stale: int = 0

    def render(self) -> str:
        return (
            f"- [{self.status}] {self.rule} "
            f"(source: {self.source}, hits: {self.hits}, stale: {self.stale})"
        )


def lesson_id(rule: str) -> str:
    return hashlib.sha1(rule.strip().lower().encode()).hexdigest()[:8]


def normalize_rule(rule: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", rule.strip().lower())


@dataclass
class ParsedFile:
    header: list[str]
    lessons: list[LessonEntry]


class LessonsModule:
    name = "reflection"

    def __init__(self, runner: TaskRunner | None = None, prompts_dir: Path | None = None):
        self._runner = runner
        self._prompts_dir = prompts_dir
        self._reflection_prompt: PromptSpec | None = None

    def ready(self, registry: AgentRegistry) -> bool:
        return True

    def _prompt(self) -> PromptSpec:
        if self._reflection_prompt is None:
            self._reflection_prompt = load_prompt("reflection", self._prompts_dir)
        return self._reflection_prompt

    def list(self, agent_home: Path, active_only: bool = True) -> list[LessonEntry]:
        parsed = _parse(agent_home / "lessons.md")
        if active_only:
            return [entry for entry in parsed.lessons if entry.status == "active"]
        return parsed.lessons

    def reflect(
        self,
        registry: AgentRegistry,
        agent: str,
        failures: list[dict[str, Any]],
        messages: list[str] | None = None,
    ) -> ReflectResponse:
        messages = [m for m in (messages or []) if m.strip()]
        failure_lines = []
        for failure in failures:
            tool = str(failure.get("tool") or "unknown").strip() or "unknown"
            summary = str(failure.get("summary") or "").strip()
            if summary:
                failure_lines.append(f"- {tool}: {summary}")
        if not failure_lines and not messages:
            return ReflectResponse(reason="nothing-to-reflect")

        if self._runner is None or not self._runner.available("reflection"):
            return ReflectResponse(reason="no-model")

        parsed = _parse(registry.agent_home(agent) / "lessons.md")
        existing_rules = "\n".join(f"- {entry.rule}" for entry in parsed.lessons) or "(none yet)"
        prompt = render(
            self._prompt(),
            lessons=existing_rules,
            failures="\n".join(failure_lines) or "(none)",
            messages="\n".join(f"- {m}" for m in messages) or "(none)",
        )
        try:
            output = self._runner.complete("reflection", prompt)
        except LlmUnavailable as err:
            return ReflectResponse(reason=f"no-model: {err}")
        except Exception as err:
            logger.warning("reflection failed: %s", err)
            return ReflectResponse(reason="llm-error")

        rules = _parse_rules(output)
        if not rules:
            return ReflectResponse(reason="no-rules")

        source = _source_for(failures, messages)
        added: list[LessonEntry] = []
        skipped = 0
        for rule in rules:
            entry = LessonEntry(id=lesson_id(rule), rule=rule, source=source)
            existing = _find_by_id(parsed.lessons, entry.id)
            if existing is not None:
                if existing.status == "retired":
                    existing.status = "active"
                    existing.stale = 0
                    existing.hits = 0
                    added.append(existing)
                else:
                    skipped += 1
                continue
            parsed.lessons.append(entry)
            added.append(entry)

        if not added:
            return ReflectResponse(skipped=skipped, reason="duplicate")
        _write(registry.agent_home(agent) / "lessons.md", parsed)
        for entry in added:
            registry.audit(agent, "lesson.add", entry.render())
        return ReflectResponse(added=[_payload(e) for e in added], skipped=skipped)

    def add(
        self, registry: AgentRegistry, agent: str, rule: str, source: str = "manual"
    ) -> LessonAddResponse:
        rule = rule.strip()
        if not rule:
            raise ValueError("rule must not be empty")
        parsed = _parse(registry.agent_home(agent) / "lessons.md")
        entry = LessonEntry(id=lesson_id(rule), rule=rule, source=source)
        if _find_by_id(parsed.lessons, entry.id) is not None:
            return LessonAddResponse(added=None, reason="duplicate")
        parsed.lessons.append(entry)
        _write(registry.agent_home(agent) / "lessons.md", parsed)
        registry.audit(agent, "lesson.add", entry.render())
        return LessonAddResponse(added=_payload(entry), reason=None)

    def retire(
        self, registry: AgentRegistry, agent: str, lesson_id_value: str
    ) -> LessonRetireResponse:
        parsed = _parse(registry.agent_home(agent) / "lessons.md")
        entry = _find_by_id(parsed.lessons, lesson_id_value)
        if entry is None:
            return LessonRetireResponse(retired=False, reason="not-found")
        entry.status = "retired"
        _write(registry.agent_home(agent) / "lessons.md", parsed)
        registry.audit(agent, "lesson.retire", entry.render())
        return LessonRetireResponse(retired=True, reason=None)

    def register_hits(
        self,
        registry: AgentRegistry,
        agent: str,
        ids: list[str],
        session_id: str,
    ) -> LessonHitsResponse:
        agent_home = registry.agent_home(agent)
        state = _load_state(agent_home)
        if session_id in state["seen"]:
            return LessonHitsResponse(counted=False, retired=[])
        state["seen"].append(session_id)
        state["seen"] = state["seen"][-MAX_REMEMBERED_SESSIONS:]

        parsed = _parse(agent_home / "lessons.md")
        hit_ids = set(ids)
        retired: list[str] = []
        for entry in parsed.lessons:
            if entry.id in hit_ids and entry.status == "active":
                entry.hits += 1
                entry.stale = 0
            elif entry.status == "active":
                entry.stale += 1
                if entry.stale >= RETIRE_AFTER_STALE_SESSIONS:
                    entry.status = "retired"
                    retired.append(entry.id)
                    registry.audit(agent, "lesson.retire", entry.render())
        _write(agent_home / "lessons.md", parsed)
        _save_state(agent_home, state)
        return LessonHitsResponse(counted=True, retired=retired)


def _payload(entry: LessonEntry) -> LessonPayload:
    return LessonPayload(
        id=entry.id,
        rule=entry.rule,
        status=entry.status,
        source=entry.source,
        hits=entry.hits,
    )


def _source_for(failures: list[dict[str, Any]], messages: list[str]) -> str:
    if failures:
        tool = str(failures[0].get("tool") or "unknown")
        return f"reflection:{tool}"
    return "reflection:correction"


def _parse_rules(output: str) -> list[str]:
    rules = []
    for line in output.splitlines():
        stripped = line.strip()
        index = stripped.upper().find("RULE:")
        if index == -1:
            continue
        rule = stripped[index + len("RULE:") :].strip()
        if rule:
            rules.append(rule)
    seen: set[str] = set()
    unique = []
    for rule in rules:
        key = normalize_rule(rule)
        if key and key not in seen:
            seen.add(key)
            unique.append(rule)
    return unique


def _find_by_id(lessons: list[LessonEntry], entry_id: str) -> LessonEntry | None:
    for entry in lessons:
        if entry.id == entry_id:
            return entry
    return None


def _parse(path: Path) -> ParsedFile:
    if not path.exists():
        return ParsedFile(header=["# Lessons", ""], lessons=[])
    header: list[str] = []
    lessons: list[LessonEntry] = []
    for line in path.read_text().splitlines():
        match = LINE_RE.match(line)
        if match:
            status, rule, source, hits, stale = match.groups()
            lessons.append(
                LessonEntry(
                    id=lesson_id(rule),
                    rule=rule,
                    status=status,
                    source=source,
                    hits=int(hits),
                    stale=int(stale),
                )
            )
        else:
            header.append(line)
    while header and not header[-1].strip():
        header.pop()
    return ParsedFile(header=header, lessons=lessons)


def _write(path: Path, parsed: ParsedFile) -> None:
    lines = ["\n".join(parsed.header).rstrip(), ""]
    lines.extend(entry.render() for entry in parsed.lessons)
    path.write_text("\n".join(lines).rstrip() + "\n")


def _state_path(agent_home: Path) -> Path:
    data_dir = agent_home / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "lessons_state.json"


def _load_state(agent_home: Path) -> dict[str, Any]:
    path = _state_path(agent_home)
    if path.exists():
        try:
            state = json.loads(path.read_text())
            if isinstance(state.get("seen"), list):
                return state
        except (ValueError, OSError):
            pass
    return {"seen": []}


def _save_state(agent_home: Path, state: dict[str, Any]) -> None:
    _state_path(agent_home).write_text(json.dumps(state, indent=2) + "\n")
