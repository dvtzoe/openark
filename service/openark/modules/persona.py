import logging
from pathlib import Path
from typing import Any

from ..core.llm import LlmUnavailable, TaskRunner
from ..core.prompts import PromptSpec, load_prompt, render
from ..core.registry import AgentRegistry

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 3
BULLET = "- "


class PersonaModule:
    name = "personality"

    def __init__(self, runner: TaskRunner | None = None, prompts_dir: Path | None = None):
        self._runner = runner
        self._prompts_dir = prompts_dir
        self._update_prompt: PromptSpec | None = None

    def ready(self, registry: AgentRegistry) -> bool:
        return True

    def _prompt(self) -> PromptSpec:
        if self._update_prompt is None:
            self._update_prompt = load_prompt("persona_update", self._prompts_dir)
        return self._update_prompt

    def evolve(
        self,
        registry: AgentRegistry,
        agent: str,
        signals: list[str],
        threshold: int = DEFAULT_THRESHOLD,
    ) -> dict[str, Any]:
        distinct = list(dict.fromkeys(s.strip() for s in signals if s.strip()))
        if len(distinct) < threshold:
            return {"updated": False, "added": [], "replaced": [], "reason": "below-threshold"}

        if self._runner is None or not self._runner.available("persona_update"):
            return {"updated": False, "added": [], "replaced": [], "reason": "no-model"}

        core, evolving = registry.read_persona(agent)
        header, preferences = _split_evolving(evolving)
        prompt = render(
            self._prompt(),
            current=_format_preferences(preferences),
            signals="\n".join(f"- {s}" for s in distinct),
            threshold=str(threshold),
        )
        try:
            output = self._runner.complete("persona_update", prompt)
        except LlmUnavailable as err:
            return {"updated": False, "added": [], "replaced": [], "reason": f"no-model: {err}"}
        except Exception as err:
            logger.warning("persona update failed: %s", err)
            return {"updated": False, "added": [], "replaced": [], "reason": "llm-error"}

        adds, replaces = _parse_proposal(output)
        if not adds and not replaces:
            return {"updated": False, "added": [], "replaced": [], "reason": "no-changes"}

        new_preferences, applied_adds, applied_replaces = _apply(preferences, adds, replaces)
        if not applied_adds and not applied_replaces:
            return {"updated": False, "added": [], "replaced": [], "reason": "no-match"}

        registry.write_persona(
            agent,
            core,
            _format_evolving(header, new_preferences),
        )
        registry.audit(agent, "persona.evolve", _diff_detail(applied_adds, applied_replaces))
        return {
            "updated": True,
            "added": applied_adds,
            "replaced": applied_replaces,
        }


def _split_evolving(content: str) -> tuple[list[str], list[str]]:
    header: list[str] = []
    preferences: list[str] = []
    for line in content.splitlines():
        if line.startswith(BULLET):
            preferences.append(line[len(BULLET) :].strip())
        else:
            header.append(line)
    while header and not header[-1].strip():
        header.pop()
    return header, preferences


def _format_preferences(preferences: list[str]) -> str:
    return "\n".join(f"{BULLET}{p}" for p in preferences) if preferences else "(none yet)"


def _format_evolving(header: list[str], preferences: list[str]) -> str:
    parts = ["\n".join(header).rstrip(), ""]
    if preferences:
        parts.extend(f"{BULLET}{p}" for p in preferences)
    return "\n".join(parts).rstrip() + "\n"


def _parse_proposal(output: str) -> tuple[list[str], list[tuple[str, str]]]:
    adds: list[str] = []
    replaces: list[tuple[str, str]] = []
    lines = [line.strip() for line in output.splitlines()]
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.lower().startswith("- replaces:"):
            old = line[len("- replaces:") :].strip().lstrip("-").strip()
            j = i + 1
            while j < len(lines) and not lines[j]:
                j += 1
            new = lines[j].lstrip("-").strip() if j < len(lines) else ""
            i = j
            if old and new:
                replaces.append((old, new))
        elif line:
            candidate = line.lstrip("-").strip()
            if candidate:
                adds.append(candidate)
        i += 1
    return _dedupe(adds), replaces


def _dedupe(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _apply(
    preferences: list[str],
    adds: list[str],
    replaces: list[tuple[str, str]],
) -> tuple[list[str], list[str], list[tuple[str, str]]]:
    result = list(preferences)
    applied_adds: list[str] = []
    applied_replaces: list[tuple[str, str]] = []

    for old, new in replaces:
        index = _find(result, old)
        if index is None:
            continue
        result[index] = new
        applied_replaces.append((old, new))

    for add in adds:
        if _find(result, add) is not None:
            continue
        result.append(add)
        applied_adds.append(add)

    return result, applied_adds, applied_replaces


def _find(preferences: list[str], target: str) -> int | None:
    for i, preference in enumerate(preferences):
        if preference == target:
            return i
    target_lower = target.lower()
    for i, preference in enumerate(preferences):
        if target_lower in preference.lower():
            return i
    return None


def _diff_detail(adds: list[str], replaces: list[tuple[str, str]]) -> str:
    parts = [f"added={len(adds)} replaced={len(replaces)}"]
    for add in adds:
        parts.append(f"+ {add}")
    for old, new in replaces:
        parts.append(f"~ {old} => {new}")
    return " | ".join(parts)
