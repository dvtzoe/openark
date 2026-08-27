import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx

from .config import ExplicitRoute, InheritRoute, ModelRoute, Settings, get_settings

PROVIDERS: dict[str, dict[str, str | None]] = {
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "kind": "openai",
        "key_env": "OPENAI_API_KEY",
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com",
        "kind": "anthropic",
        "key_env": "ANTHROPIC_API_KEY",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "kind": "openai",
        "key_env": "OPENROUTER_API_KEY",
    },
    "google": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "kind": "openai",
        "key_env": "GEMINI_API_KEY",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "kind": "openai",
        "key_env": "GROQ_API_KEY",
    },
    "xai": {"base_url": "https://api.x.ai/v1", "kind": "openai", "key_env": "XAI_API_KEY"},
    "mistral": {
        "base_url": "https://api.mistral.ai/v1",
        "kind": "openai",
        "key_env": "MISTRAL_API_KEY",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "kind": "openai",
        "key_env": "DEEPSEEK_API_KEY",
    },
    "ollama": {"base_url": "http://127.0.0.1:11434/v1", "kind": "openai", "key_env": None},
}

_NO_KEY_PROVIDERS = {"ollama"}


class LlmUnavailable(Exception):
    pass


@dataclass(frozen=True)
class ResolvedModel:
    model: str
    base_url: str
    api_key: str | None
    kind: str

    def mem0_llm_config(self) -> dict[str, Any]:
        if self.kind == "anthropic":
            return {
                "provider": "anthropic",
                "config": {"model": self.model, "api_key": self.api_key},
            }
        return {
            "provider": "openai",
            "config": {
                "model": self.model,
                "api_key": self.api_key or "unused",
                "openai_base_url": self.base_url,
            },
        }


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError):
        return None


def opencode_config_path() -> Path:
    if env := os.environ.get("OPENARK_OPENCODE_CONFIG"):
        return Path(env).expanduser()
    for name in ("opencode.json", "opencode.jsonc"):
        candidate = Path.home() / ".config" / "opencode" / name
        if candidate.exists():
            return candidate
    return Path.home() / ".config" / "opencode" / "opencode.json"


def opencode_auth_path() -> Path:
    if env := os.environ.get("OPENARK_OPENCODE_AUTH"):
        return Path(env).expanduser()
    return Path.home() / ".local" / "share" / "opencode" / "auth.json"


def read_opencode_config() -> dict[str, Any]:
    raw = _read_json(opencode_config_path())
    return raw if isinstance(raw, dict) else {}


def read_opencode_auth() -> dict[str, str]:
    raw = _read_json(opencode_auth_path())
    if not isinstance(raw, dict):
        return {}
    keys: dict[str, str] = {}
    for provider, entry in raw.items():
        if isinstance(entry, dict) and isinstance(entry.get("key"), str):
            keys[provider] = entry["key"]
    return keys


def _custom_provider_base_url(provider: str, config: dict[str, Any]) -> str | None:
    providers = config.get("provider")
    if not isinstance(providers, dict):
        return None
    entry = providers.get(provider)
    if not isinstance(entry, dict):
        return None
    options = entry.get("options")
    if isinstance(options, dict) and isinstance(options.get("baseURL"), str):
        return options["baseURL"]
    return None


def _resolve_model_string(
    model_str: str,
    config: dict[str, Any],
    auth: dict[str, str],
) -> ResolvedModel | None:
    provider, _, model = model_str.partition("/")
    if not model:
        return None
    base_url = _custom_provider_base_url(provider, config) or PROVIDERS.get(provider, {}).get(
        "base_url"
    )
    kind = "anthropic" if provider == "anthropic" else "openai"
    api_key = auth.get(provider) or _provider_key_env(provider)
    if base_url is None:
        return None
    if provider not in _NO_KEY_PROVIDERS and not api_key:
        return None
    return ResolvedModel(model=model, base_url=base_url, api_key=api_key, kind=kind)


def _provider_key_env(provider: str) -> str | None:
    key_env = PROVIDERS.get(provider, {}).get("key_env")
    return os.environ.get(key_env) if key_env else None


def resolve_route(
    task: str,
    settings: Settings | None = None,
    opencode_config: dict[str, Any] | None = None,
    auth: dict[str, str] | None = None,
) -> ResolvedModel | None:
    route: ModelRoute | None = (settings or get_settings()).models.get(task)
    if route is None:
        route = InheritRoute(inherit="small")
    if isinstance(route, InheritRoute):
        config = opencode_config if opencode_config is not None else read_opencode_config()
        keys = auth if auth is not None else read_opencode_auth()
        model_str = config.get("model" if route.inherit == "main" else "small_model")
        if not isinstance(model_str, str):
            return None
        return _resolve_model_string(model_str, config, keys)
    return _resolve_explicit(route, auth)


def _resolve_explicit(route: ExplicitRoute, auth: dict[str, str] | None) -> ResolvedModel | None:
    base_url = route.base_url or PROVIDERS.get(route.provider, {}).get("base_url")
    if base_url is None:
        return None
    kind = "anthropic" if route.provider == "anthropic" else "openai"
    api_key: str | None = None
    if route.api_key_env:
        api_key = os.environ.get(route.api_key_env)
    else:
        api_key = (auth or {}).get(route.provider) or _provider_key_env(route.provider)
    if route.provider not in _NO_KEY_PROVIDERS and not api_key:
        return None
    return ResolvedModel(model=route.model, base_url=base_url, api_key=api_key, kind=kind)


class TaskRunner(Protocol):
    def available(self, task: str) -> bool:
        """Return True when a model route resolves for the task."""
        ...

    def complete(self, task: str, prompt: str) -> str:
        """Run a prompt through the model routed for the task.

        Raises LlmUnavailable when no model is resolvable for the task.
        """
        ...


class HttpTaskRunner:
    def __init__(
        self,
        resolve=resolve_route,
        client: httpx.Client | None = None,
        timeout: float = 60.0,
    ):
        self._resolve = resolve
        self._client = client
        self._timeout = timeout

    def available(self, task: str) -> bool:
        try:
            return self._resolve(task) is not None
        except Exception:
            return False

    def complete(self, task: str, prompt: str) -> str:
        route = self._resolve(task)
        if route is None:
            raise LlmUnavailable(f"no model route for task {task!r}")
        if route.kind == "anthropic":
            return self._anthropic(route, prompt)
        return self._openai(route, prompt)

    def _openai(self, route: ResolvedModel, prompt: str) -> str:
        headers = {"authorization": f"Bearer {route.api_key}"} if route.api_key else {}
        response = self._request(
            f"{route.base_url.rstrip('/')}/chat/completions",
            headers=headers,
            payload={
                "model": route.model,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        return response["choices"][0]["message"]["content"]

    def _anthropic(self, route: ResolvedModel, prompt: str) -> str:
        response = self._request(
            f"{route.base_url.rstrip('/')}/v1/messages",
            headers={
                "x-api-key": route.api_key or "",
                "anthropic-version": "2023-06-01",
            },
            payload={
                "model": route.model,
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        return "".join(block.get("text", "") for block in response["content"])

    def _request(
        self, url: str, headers: dict[str, str], payload: dict[str, Any]
    ) -> dict[str, Any]:
        owned = self._client is None
        client = self._client or httpx.Client(timeout=self._timeout)
        try:
            res = client.post(url, headers=headers, json=payload)
            res.raise_for_status()
            return res.json()
        except httpx.HTTPError as err:
            raise LlmUnavailable(f"model call failed: {err}") from err
        finally:
            if owned:
                client.close()


def build_task_runner() -> TaskRunner:
    return HttpTaskRunner()
