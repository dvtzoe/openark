import logging
from pathlib import Path

from ..core.llm import LlmUnavailable, TaskRunner
from ..core.models import PersonaEvolveResponse, PersonaReplace
from ..core.prompts import PromptSpec, load_prompt, render
from ..core.registry import AgentRegistry

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD = 3
BULLET = "- "
EVOLVING_MAIN = "persona.evolving.md"


class _FragmentState:
    """One evolving persona file, split into header lines and bullets."""

    def __init__(self, path: Path, label: str, content: str):
        self.path = path
        self.label = label
        self.header, self.bullets = _split_evolving(content)


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
    ) -> PersonaEvolveResponse:
        distinct = list(dict.fromkeys(s.strip() for s in signals if s.strip()))
        if len(distinct) < threshold:
            return PersonaEvolveResponse(reason="below-threshold")

        if self._runner is None or not self._runner.available("persona_update"):
            return PersonaEvolveResponse(reason="no-model")

        # Evolving persona = main file + drop-ins under persona.evolving.md.d/.
        # The agent may write into both (core drop-ins are user config and are
        # never touched here). Replaces edit the fragment a bullet lives in;
        # adds always land in the main file.
        fragments = registry.persona_fragments(agent, "persona.evolving.md")
        states = [_FragmentState(path, label, content) for path, label, content in fragments]
        if not any(state.label == EVOLVING_MAIN for state in states):
            virtual_main = registry.agent_home(agent) / EVOLVING_MAIN
            states.append(_FragmentState(virtual_main, EVOLVING_MAIN, ""))
        main_index = next(i for i, state in enumerate(states) if state.label == EVOLVING_MAIN)

        prompt = render(
            self._prompt(),
            current=_format_preferences([b for s in states for b in s.bullets]),
            signals="\n".join(f"- {s}" for s in distinct),
            threshold=str(threshold),
        )
        try:
            output = self._runner.complete("persona_update", prompt)
        except LlmUnavailable as err:
            return PersonaEvolveResponse(reason=f"no-model: {err}")
        except Exception as err:
            logger.warning("persona update failed: %s", err)
            return PersonaEvolveResponse(reason="llm-error")

        adds, replaces = _parse_proposal(output)
        if not adds and not replaces:
            return PersonaEvolveResponse(reason="no-changes")

        pools, applied_adds, applied_replaces = _apply(
            [state.bullets for state in states], main_index, adds, replaces
        )
        if not applied_adds and not applied_replaces:
            return PersonaEvolveResponse(reason="no-match")

        changed: list[str] = []
        for state, pool in zip(states, pools, strict=True):
            if pool == state.bullets:
                continue
            registry.write_persona_fragment(agent, state.path, _format_evolving(state.header, pool))
            changed.append(state.label)

        registry.audit(
            agent, "persona.evolve", _diff_detail(applied_adds, applied_replaces, changed)
        )
        return PersonaEvolveResponse(
            updated=True,
            added=applied_adds,
            replaced=[PersonaReplace(old=old, new=new) for old, new in applied_replaces],
        )


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
    parts = ["\n".join(header).rstrip(), ""] if header else []
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
    pools: list[list[str]],
    main_index: int,
    adds: list[str],
    replaces: list[tuple[str, str]],
) -> tuple[list[list[str]], list[str], list[tuple[str, str]]]:
    # Applies a proposal across per-file bullet pools. Replaces rewrite the
    # pool the matched bullet lives in; adds always land in the main file's
    # pool (main_index). Matching operates on the merged view so fragment
    # boundaries are invisible to the proposal format.
    new_pools = [list(pool) for pool in pools]
    merged = [bullet for pool in new_pools for bullet in pool]
    owner = [i for i, pool in enumerate(new_pools) for _ in pool]
    offsets = []
    offset = 0
    for pool in new_pools:
        offsets.append(offset)
        offset += len(pool)

    applied_adds: list[str] = []
    applied_replaces: list[tuple[str, str]] = []

    for old, new in replaces:
        index = _find(merged, old)
        if index is None:
            continue
        fragment = owner[index]
        new_pools[fragment][index - offsets[fragment]] = new
        merged[index] = new
        applied_replaces.append((old, new))

    for add in adds:
        if _find(merged, add) is not None:
            continue
        new_pools[main_index].append(add)
        merged.append(add)
        applied_adds.append(add)

    return new_pools, applied_adds, applied_replaces


def _find(preferences: list[str], target: str) -> int | None:
    for i, preference in enumerate(preferences):
        if preference == target:
            return i
    target_lower = target.lower()
    for i, preference in enumerate(preferences):
        if target_lower in preference.lower():
            return i
    return None


def _diff_detail(
    adds: list[str],
    replaces: list[tuple[str, str]],
    files: list[str],
) -> str:
    parts = [f"added={len(adds)} replaced={len(replaces)}"]
    for add in adds:
        parts.append(f"+ {add}")
    for old, new in replaces:
        parts.append(f"~ {old} => {new}")
    if files:
        parts.append(f"files={','.join(files)}")
    return " | ".join(parts)
