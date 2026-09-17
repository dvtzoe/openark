import json

import httpx
import pytest

from openark.core.config import Settings
from openark.core.llm import (
    HttpTaskRunner,
    LlmUnavailable,
    ResolvedModel,
    resolve_route,
)


def settings(models=None):
    from pathlib import Path

    return Settings(root=Path("/tmp/openark-test"), models=models or {})


def write_config(tmp_path, payload):
    path = tmp_path / "opencode.json"
    path.write_text(json.dumps(payload))
    return str(path)


class TestResolveRoute:
    @pytest.fixture(autouse=True)
    def _no_real_catalog(self, monkeypatch):
        # Tests must not depend on the developer machine's models.json.
        monkeypatch.setattr("openark.core.llm.read_provider_catalog", lambda: {})

    def test_inherit_small_from_opencode_config(self, tmp_path, monkeypatch):
        cfg = write_config(
            tmp_path, {"model": "anthropic/claude-4", "small_model": "openai/gpt-4o-mini"}
        )
        monkeypatch.setenv("OPENARK_OPENCODE_CONFIG", cfg)
        monkeypatch.delenv("OPENARK_OPENCODE_AUTH", raising=False)
        auth = tmp_path / "auth.json"
        auth.write_text(json.dumps({"openai": {"type": "api", "key": "sk-1"}}))
        monkeypatch.setenv("OPENARK_OPENCODE_AUTH", str(auth))
        route = resolve_route("extraction", settings=settings())
        assert route.model == "gpt-4o-mini"
        assert route.base_url == "https://api.openai.com/v1"
        assert route.api_key == "sk-1"
        assert route.kind == "openai"

    def test_inherit_main_uses_model_field(self, tmp_path, monkeypatch):
        cfg = write_config(
            tmp_path,
            {"model": "anthropic/claude-sonnet-4-20250514"},
        )
        monkeypatch.setenv("OPENARK_OPENCODE_CONFIG", cfg)
        monkeypatch.setattr(
            "openark.core.llm.read_opencode_auth",
            lambda: {"anthropic": "sk-ant-1"},
        )
        route = resolve_route("reflection", settings=settings({"reflection": {"inherit": "main"}}))
        assert route.kind == "anthropic"
        assert route.model == "claude-sonnet-4-20250514"
        assert route.api_key == "sk-ant-1"

    def test_inherit_without_opencode_model_returns_none(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENARK_OPENCODE_CONFIG", str(tmp_path / "missing.json"))
        monkeypatch.setattr("openark.core.llm.read_opencode_auth", lambda: {})
        assert resolve_route("extraction", settings=settings()) is None

    def test_missing_api_key_returns_none(self, tmp_path, monkeypatch):
        cfg = write_config(tmp_path, {"small_model": "openai/gpt-4o-mini"})
        monkeypatch.setenv("OPENARK_OPENCODE_CONFIG", cfg)
        monkeypatch.setattr("openark.core.llm.read_opencode_auth", lambda: {})
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        assert resolve_route("extraction", settings=settings()) is None

    def test_explicit_route_with_env_key(self, monkeypatch):
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-1")
        route = resolve_route(
            "distillation",
            settings=settings({"distillation": {"provider": "openrouter", "model": "x/y"}}),
        )
        assert route.base_url == "https://openrouter.ai/api/v1"
        assert route.api_key == "or-1"

    def test_explicit_route_with_api_key_env(self, monkeypatch):
        monkeypatch.setenv("MY_KEY", "k")
        route = resolve_route(
            "persona_update",
            settings=settings(
                {"persona_update": {"provider": "openai", "model": "m", "api_key_env": "MY_KEY"}}
            ),
        )
        assert route.api_key == "k"

    def test_explicit_route_custom_base_url(self, monkeypatch):
        monkeypatch.setenv("MY_KEY", "k")
        route = resolve_route(
            "extraction",
            settings=settings(
                {
                    "extraction": {
                        "provider": "vllm",
                        "model": "qwen",
                        "base_url": "http://gpu-box:8000/v1",
                        "api_key_env": "MY_KEY",
                    }
                }
            ),
        )
        assert route.base_url == "http://gpu-box:8000/v1"
        assert route.kind == "openai"

    def test_ollama_needs_no_key(self, monkeypatch):
        monkeypatch.setattr("openark.core.llm.read_opencode_auth", lambda: {})
        route = resolve_route(
            "extraction",
            settings=settings({"extraction": {"provider": "ollama", "model": "llama3"}}),
        )
        assert route.api_key is None
        assert route.base_url == "http://127.0.0.1:11434/v1"

    def test_custom_opencode_provider_base_url(self, tmp_path, monkeypatch):
        cfg = write_config(
            tmp_path,
            {
                "small_model": "my-lm/qwen-3",
                "provider": {"my-lm": {"options": {"baseURL": "http://lm:8080/v1"}}},
            },
        )
        monkeypatch.setenv("OPENARK_OPENCODE_CONFIG", cfg)
        monkeypatch.setattr("openark.core.llm.read_opencode_auth", lambda: {"my-lm": "k"})
        route = resolve_route("extraction", settings=settings())
        assert route.base_url == "http://lm:8080/v1"
        assert route.model == "qwen-3"

    def test_unknown_provider_without_base_url_returns_none(self, monkeypatch):
        monkeypatch.setenv("MY_KEY", "k")
        monkeypatch.setattr("openark.core.llm.read_opencode_auth", lambda: {})
        assert (
            resolve_route(
                "extraction",
                settings=settings(
                    {"extraction": {"provider": "weird", "model": "m", "api_key_env": "MY_KEY"}}
                ),
            )
            is None
        )

    def test_explicit_route_reads_opencode_auth(self, monkeypatch):
        monkeypatch.setattr("openark.core.llm.read_opencode_auth", lambda: {"openai": "sk-auth"})
        route = resolve_route(
            "extraction",
            settings=settings({"extraction": {"provider": "openai", "model": "gpt-4o-mini"}}),
        )
        assert route.api_key == "sk-auth"

    def test_unknown_provider_falls_back_to_models_catalog(self, monkeypatch):
        monkeypatch.setenv("MY_KEY", "k")
        monkeypatch.setattr("openark.core.llm.read_opencode_auth", lambda: {})
        monkeypatch.setattr(
            "openark.core.llm.read_provider_catalog",
            lambda: {"weird": {"api": "http://weird-box/v1"}},
        )
        route = resolve_route(
            "extraction",
            settings=settings(
                {"extraction": {"provider": "weird", "model": "m", "api_key_env": "MY_KEY"}}
            ),
        )
        assert route.base_url == "http://weird-box/v1"

    def test_opencode_go_inherit_resolves(self, tmp_path, monkeypatch):
        cfg = write_config(tmp_path, {"small_model": "opencode-go/deepseek-v4.1-flash"})
        monkeypatch.setenv("OPENARK_OPENCODE_CONFIG", cfg)
        monkeypatch.setattr(
            "openark.core.llm.read_opencode_auth", lambda: {"opencode-go": "zen-key"}
        )
        route = resolve_route("persona_update", settings=settings())
        assert route.model == "deepseek-v4.1-flash"
        assert route.base_url == "https://opencode.ai/zen/go/v1"
        assert route.api_key == "zen-key"
        assert route.session_id == "openark-background"

    def test_preferred_selected_model_used_without_opencode_config(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENARK_OPENCODE_CONFIG", str(tmp_path / "missing.json"))
        monkeypatch.setattr(
            "openark.core.llm.read_opencode_auth", lambda: {"opencode-go": "zen-key"}
        )
        route = resolve_route(
            "persona_update",
            settings=settings(),
            preferred="opencode-go/deepseek-v4.1-flash",
        )
        assert route is not None
        assert route.model == "deepseek-v4.1-flash"

    def test_explicit_route_beats_preferred(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-1")
        route = resolve_route(
            "persona_update",
            settings=settings({"persona_update": {"provider": "openai", "model": "gpt-4o-mini"}}),
            auth={},
            preferred="opencode-go/deepseek-v4.1-flash",
        )
        assert route.model == "gpt-4o-mini"


class TestMem0LlmConfig:
    def test_openai_kind_config(self):
        route = ResolvedModel(model="m", base_url="http://x/v1", api_key="k", kind="openai")
        cfg = route.mem0_llm_config()
        assert cfg["provider"] == "openai"
        assert cfg["config"]["openai_base_url"] == "http://x/v1"

    def test_anthropic_kind_config(self):
        route = ResolvedModel(
            model="claude", base_url="https://api.anthropic.com", api_key="k", kind="anthropic"
        )
        cfg = route.mem0_llm_config()
        assert cfg["provider"] == "anthropic"
        assert cfg["config"]["api_key"] == "k"


class TestHttpTaskRunner:
    def _runner(self, handler):
        return HttpTaskRunner(
            resolve=lambda task, preferred=None: ResolvedModel(
                model="m", base_url="http://llm.test/v1", api_key="k", kind="openai"
            ),
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

    def test_openai_completion(self):
        def handler(request):
            assert request.url.path == "/v1/chat/completions"
            assert request.headers["authorization"] == "Bearer k"
            body = json.loads(request.content)
            assert body["model"] == "m"
            return httpx.Response(
                200, json={"choices": [{"message": {"content": "fact one\nfact two"}}]}
            )

        assert self._runner(handler).complete("extraction", "p") == "fact one\nfact two"

    def test_anthropic_completion(self):
        def handler(request):
            assert request.url.path == "/v1/messages"
            assert request.headers["x-api-key"] == "k"
            return httpx.Response(200, json={"content": [{"type": "text", "text": "hello"}]})

        runner = HttpTaskRunner(
            resolve=lambda task, preferred=None: ResolvedModel(
                model="claude", base_url="http://llm.test", api_key="k", kind="anthropic"
            ),
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        assert runner.complete("reflection", "p") == "hello"

    def test_no_route_raises_unavailable(self):
        runner = HttpTaskRunner(resolve=lambda task, preferred=None: None)
        with pytest.raises(LlmUnavailable):
            runner.complete("extraction", "p")

    def test_null_content_returns_empty_string(self):
        def handler(request):
            return httpx.Response(200, json={"choices": [{"message": {"content": None}}]})

        assert self._runner(handler).complete("extraction", "p") == ""

    def test_opencode_session_header_is_sent(self):
        def handler(request):
            assert request.headers["x-opencode-session"] == "openark-background"
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        runner = HttpTaskRunner(
            resolve=lambda task, preferred=None: ResolvedModel(
                model="m",
                base_url="http://llm.test/v1",
                api_key="k",
                kind="openai",
                session_id="openark-background",
            ),
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        assert runner.complete("persona_update", "p") == "ok"

    def test_provider_error_body_is_surfaced(self):
        def handler(request):
            return httpx.Response(400, text="MissingSessionID: see docs")

        with pytest.raises(LlmUnavailable, match="MissingSessionID"):
            self._runner(handler).complete("extraction", "p")

    def test_http_error_raises_unavailable(self):
        def handler(request):
            return httpx.Response(500, text="boom")

        with pytest.raises(LlmUnavailable):
            self._runner(handler).complete("extraction", "p")
