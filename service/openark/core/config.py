import json
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

logger = logging.getLogger(__name__)


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
    # Mirrored by plugin/src/core/config.ts's DEFAULT_SERVICE_PORT — no
    # shared constant is possible across the TS/Python boundary, so this
    # must be kept in sync by hand if it ever changes.
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
        except (ValueError, OSError) as err:
            logger.warning("ignoring unreadable %s: %s", config_path, err)
            return Settings(root=root)
        if not isinstance(raw, dict):
            logger.warning("ignoring %s: top-level JSON must be an object", config_path)
            return Settings(root=root)
        port = raw.get("servicePort")
        if port is not None:
            # bool is an int subclass — exclude it explicitly, and validate
            # the range, so a typo can't bind port 1 or crash startup with
            # an uncaught TypeError from int(None)/int({}).
            if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
                logger.warning("ignoring invalid servicePort %r in %s", port, config_path)
            else:
                overrides["service_port"] = port
        if isinstance(raw.get("models"), dict):
            overrides["models"] = raw["models"]
    try:
        return Settings(root=root, **overrides)
    except ValueError as err:
        logger.warning("ignoring invalid model routing in %s: %s", config_path, err)
        return Settings(root=root)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return _load_settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
