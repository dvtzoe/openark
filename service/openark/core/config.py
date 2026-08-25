import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel


class InheritRoute(BaseModel):
    inherit: Literal["main", "small"]


class ExplicitRoute(BaseModel):
    provider: str
    model: str
    base_url: str | None = None
    api_key_env: str | None = None


ModelRoute = InheritRoute | ExplicitRoute

TASKS = ("extraction", "reflection", "distillation", "persona_update", "embeddings")


class Settings(BaseModel):
    root: Path
    service_port: int = 8765
    models: dict[str, ModelRoute] = {}


def _default_root() -> Path:
    home = os.environ.get("OPENARK_HOME")
    if home:
        return Path(home).expanduser()
    return Path.home() / ".openark"


def _load_settings() -> Settings:
    root = _default_root()
    settings = Settings(root=root)
    config_path = root / "openark.json"
    if config_path.exists():
        try:
            raw = json.loads(config_path.read_text())
            settings.service_port = int(raw.get("servicePort", settings.service_port))
            settings.models = raw.get("models", {})
        except (ValueError, OSError):
            pass
    return settings


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return _load_settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()


def resolve_task_model(task: str) -> dict[str, Any]:
    settings = get_settings()
    route = settings.models.get(task)
    if route is None:
        return {"inherit": "small"}
    return route.model_dump()
