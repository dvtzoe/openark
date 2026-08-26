import re
from dataclasses import dataclass
from pathlib import Path

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

_REQUIRED = ("name", "version", "task")


class PromptNotFound(KeyError):
    pass


class PromptFormatError(ValueError):
    pass


@dataclass(frozen=True)
class PromptSpec:
    name: str
    version: int
    task: str
    body: str


def parse_prompt(text: str) -> PromptSpec:
    if not text.startswith("---"):
        raise PromptFormatError("prompt must start with a '---' frontmatter block")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise PromptFormatError("unterminated frontmatter block")
    meta: dict[str, str] = {}
    for line in parts[1].strip().splitlines():
        if not line.strip():
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise PromptFormatError(f"malformed frontmatter line: {line!r}")
        meta[key.strip()] = value.strip()
    for key in _REQUIRED:
        if key not in meta:
            raise PromptFormatError(f"frontmatter missing required key: {key}")
    try:
        version = int(meta["version"])
    except ValueError as err:
        raise PromptFormatError(f"version must be an integer: {meta['version']!r}") from err
    return PromptSpec(
        name=meta["name"],
        version=version,
        task=meta["task"],
        body=parts[2].strip(),
    )


def load_prompt(name: str, prompts_dir: Path | None = None) -> PromptSpec:
    path = (prompts_dir or PROMPTS_DIR) / f"{name}.md"
    if not path.exists():
        raise PromptNotFound(name)
    spec = parse_prompt(path.read_text())
    if spec.name != name:
        raise PromptFormatError(f"prompt file {path} declares name {spec.name!r}")
    return spec


def render(spec: PromptSpec, **values: str) -> str:
    placeholders = set(re.findall(r"\{(\w+)\}", spec.body))
    missing = placeholders - set(values)
    if missing:
        raise PromptFormatError(f"prompt {spec.name}: missing placeholders {sorted(missing)}")
    rendered = spec.body
    for key, value in values.items():
        rendered = rendered.replace("{" + key + "}", value)
    return rendered
