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
    overrides: dict[str, Any] = {}
    config_path = root / "openark.json"
    if config_path.exists():
        try:
            raw = json.loads(config_path.read_text())
            if isinstance(raw, dict):
                if "servicePort" in raw:
                    overrides["service_port"] = int(raw["servicePort"])
                if isinstance(raw.get("models"), dict):
                    overrides["models"] = raw["models"]
        except (ValueError, OSError):
            pass
    try:
        return Settings(root=root, **overrides)
    except ValueError:
        return Settings(root=root)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return _load_settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
