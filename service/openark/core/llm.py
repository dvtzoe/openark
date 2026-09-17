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
    # opencode's own gateways. opencode ships them as built-in providers;
    # the models.json cache (below) normally supplies these, this is the
    # fallback for installs where the cache is missing.
    "opencode": {
        "base_url": "https://opencode.ai/zen/v1",
        "kind": "openai",
        "key_env": "OPENCODE_API_KEY",
    },
    "opencode-go": {
        "base_url": "https://opencode.ai/zen/go/v1",
        "kind": "openai",
        "key_env": "OPENCODE_API_KEY",
    },
}

_NO_KEY_PROVIDERS = {"ollama"}

# Providers that route through opencode's own gateway and therefore need the
# x-opencode-session header.
_SESSION_HEADER_PROVIDERS = {"opencode", "opencode-go"}
_BACKGROUND_SESSION_ID = "openark-background"


class LlmUnavailable(Exception):
    pass


@dataclass(frozen=True)
class ResolvedModel:
    model: str
    base_url: str
    api_key: str | None
    kind: str
    # opencode's gateways require a stable conversation id in
    # x-opencode-session (see https://opencode.ai/docs/go/). Background tasks
    # are standalone one-shot prompts, so one stable id per service is enough.
    session_id: str | None = None

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


def opencode_models_path() -> Path:
    """opencode's cache of the models.dev provider catalog."""
    if env := os.environ.get("OPENARK_OPENCODE_MODELS"):
        return Path(env).expanduser()
    return Path.home() / ".cache" / "opencode" / "models.json"


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


def read_provider_catalog() -> dict[str, Any]:
    raw = _read_json(opencode_models_path())
    return raw if isinstance(raw, dict) else {}


def _catalog_base_url(provider: str, catalog: dict[str, Any]) -> str | None:
    entry = catalog.get(provider)
    if isinstance(entry, dict) and isinstance(entry.get("api"), str):
        return entry["api"]
    return None


def _config_api_key(provider: str, config: dict[str, Any]) -> str | None:
    providers = config.get("provider")
    if not isinstance(providers, dict):
        return None
    entry = providers.get(provider)
    if not isinstance(entry, dict):
        return None
    options = entry.get("options")
    if isinstance(options, dict) and isinstance(options.get("apiKey"), str):
        return options["apiKey"]
    return None


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
    # Custom opencode provider config wins, then the built-in table, then
    # opencode's own models.dev cache — the last one is what lets providers
    # openark doesn't hardcode (opencode's gateways, copilot, ...) resolve.
    base_url = (
        _custom_provider_base_url(provider, config)
        or PROVIDERS.get(provider, {}).get("base_url")
        or _catalog_base_url(provider, read_provider_catalog())
    )
    kind = "anthropic" if provider == "anthropic" else "openai"
    api_key = (
        auth.get(provider)
        or _config_api_key(provider, config)
        or _provider_key_env(provider)
    )
    if base_url is None:
        return None
    if provider not in _NO_KEY_PROVIDERS and not api_key:
        return None
    session_id = _BACKGROUND_SESSION_ID if provider in _SESSION_HEADER_PROVIDERS else None
    return ResolvedModel(
        model=model, base_url=base_url, api_key=api_key, kind=kind, session_id=session_id
    )


def _provider_key_env(provider: str) -> str | None:
    key_env = PROVIDERS.get(provider, {}).get("key_env")
    return os.environ.get(key_env) if key_env else None


def resolve_route(
    task: str,
    settings: Settings | None = None,
    opencode_config: dict[str, Any] | None = None,
    auth: dict[str, str] | None = None,
    preferred: str | None = None,
) -> ResolvedModel | None:
    """Resolve the model for a background task.

    Priority: an explicit per-task route in openark.json wins; otherwise the
    session's selected model (`preferred`, forwarded by the plugin as
    "provider/model") is used when it resolves; otherwise the inherited
    opencode small/main model. The preferred hint is what makes learning
    work when opencode has no small_model configured but a model is
    selected in the TUI.
    """
    config = opencode_config if opencode_config is not None else read_opencode_config()
    # Read auth.json for explicit routes too, not just inherited ones —
    # opencode keeps provider keys there, and an explicit route naming a
    # provider whose key lives only in auth.json used to resolve to None.
    keys = auth if auth is not None else read_opencode_auth()
    explicit: ModelRoute | None = (settings or get_settings()).models.get(task)
    if explicit is not None and not isinstance(explicit, InheritRoute):
        return _resolve_explicit(explicit, keys)
    if preferred:
        resolved = _resolve_model_string(preferred, config, keys)
        if resolved is not None:
            return resolved
    route: ModelRoute = explicit or InheritRoute(inherit="small")
    if isinstance(route, InheritRoute):
        # A task missing from openark.json's `models` map isn't treated as
        # "no route" outright — it defaults to inheriting opencode's small
        # model first, so a bare-bones openark.json still gets LLM-backed
        # features if opencode itself has a small model configured. This
        # still degrades to None below if that isn't configured either.
        model_str = config.get("model" if route.inherit == "main" else "small_model")
        if not isinstance(model_str, str):
            return None
        return _resolve_model_string(model_str, config, keys)
    return None


def _resolve_explicit(route: ExplicitRoute, auth: dict[str, str] | None) -> ResolvedModel | None:
    base_url = route.base_url or PROVIDERS.get(route.provider, {}).get("base_url")
    if base_url is None:
        base_url = _catalog_base_url(route.provider, read_provider_catalog())
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
    session_id = (
        _BACKGROUND_SESSION_ID if route.provider in _SESSION_HEADER_PROVIDERS else None
    )
    return ResolvedModel(
        model=route.model,
        base_url=base_url,
        api_key=api_key,
        kind=kind,
        session_id=session_id,
    )


class TaskRunner(Protocol):
    def available(self, task: str, preferred: str | None = None) -> bool:
        """Return True when a model route resolves for the task."""
        ...

    def route(self, task: str, preferred: str | None = None) -> ResolvedModel | None:
        """Return the resolved route for the task, if any.

        Lets a caller inspect provider details (e.g. whether the route is a
        gateway that needs session headers) without re-resolving itself.
        """
        ...

    def complete(self, task: str, prompt: str, preferred: str | None = None) -> str:
        """Run a prompt through the model routed for the task.

        `preferred` is the session's selected model ("provider/model"),
        forwarded by the plugin; used when no explicit per-task route is set.

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

    def available(self, task: str, preferred: str | None = None) -> bool:
        try:
            return self._resolve(task, preferred=preferred) is not None
        except Exception:
            return False

    def route(self, task: str, preferred: str | None = None) -> ResolvedModel | None:
        return self._resolve(task, preferred=preferred)

    def complete(self, task: str, prompt: str, preferred: str | None = None) -> str:
        route = self._resolve(task, preferred=preferred)
        if route is None:
            raise LlmUnavailable(f"no model route for task {task!r}")
        if route.kind == "anthropic":
            return self._anthropic(route, prompt)
        return self._openai(route, prompt)

    def _openai(self, route: ResolvedModel, prompt: str) -> str:
        headers = {"authorization": f"Bearer {route.api_key}"} if route.api_key else {}
        if route.session_id:
            headers["x-opencode-session"] = route.session_id
        response = self._request(
            f"{route.base_url.rstrip('/')}/chat/completions",
            headers=headers,
            payload={
                "model": route.model,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        content = response["choices"][0]["message"]["content"]
        # Some providers return null content (blocked prompts, tool calls);
        # callers parse the string, so never hand them None.
        return content if isinstance(content, str) else ""

    def _anthropic(self, route: ResolvedModel, prompt: str) -> str:
        headers = {
            "x-api-key": route.api_key or "",
            "anthropic-version": "2023-06-01",
        }
        if route.session_id:
            headers["x-opencode-session"] = route.session_id
        response = self._request(
            f"{route.base_url.rstrip('/')}/v1/messages",
            headers=headers,
            payload={
                "model": route.model,
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        return "".join(
            block.get("text", "") for block in response["content"] if isinstance(block, dict)
        )

    def _request(
        self, url: str, headers: dict[str, str], payload: dict[str, Any]
    ) -> dict[str, Any]:
        owned = self._client is None
        client = self._client or httpx.Client(timeout=self._timeout)
        request_headers = {"user-agent": "openark-service/0.1.0", **headers}
        try:
            res = client.post(url, headers=request_headers, json=payload)
            if res.status_code >= 400:
                # Surface the provider's message: "no model" vs "bad request"
                # must be distinguishable without a debugger.
                raise LlmUnavailable(
                    f"model call failed: {res.status_code} {res.text[:300].strip()}"
                )
            return res.json()
        except httpx.HTTPError as err:
            raise LlmUnavailable(f"model call failed: {err}") from err
        finally:
            if owned:
                client.close()


def build_task_runner() -> TaskRunner:
    return HttpTaskRunner()
